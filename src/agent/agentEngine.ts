/**
 * Agent 调度引擎
 * 职责：任务规划、工具调度、多轮对话闭环（工具结果回传模型，自我修正直至完成）
 * 参考 Cline 的工具调度与任务执行链路设计
 */
import * as vscode from 'vscode';
import { AgentStep, AttachedFileRef, ChatMessage, MessageSegment, ModelMeta, PermissionRequest, READONLY_TOOL_NAMES, RunMode, Session, ToolCall } from '../types';
import { ConfigManager } from '../config/configManager';
import { SecurityManager } from '../security/securityManager';
import { AuditLogger } from '../security/auditLogger';
import { SessionManager } from '../sessions/sessionManager';
import { UsageTracker } from '../sessions/usageTracker';
import { ContextManager } from '../context/contextManager';
import { ToolRegistry } from '../tools/toolRegistry';
import { ToolResult } from '../tools/fileTools';
import { ModelAdapter, ModelMessage } from '../models/modelAdapter';
import { estimateCostCNY } from '../models/modelPricing';
import { randomId, truncate } from '../utils/id';

/** 工具结果回传模型的最大长度（Token 效率优化） */
const MAX_TOOL_RESULT_LEN = 30000;

/** 只读工具集合：无副作用，同批次可并行执行（流式执行流水线中也可预启动） */
const READONLY_TOOLS = new Set<string>(READONLY_TOOL_NAMES);

const SYSTEM_PROMPT = `你是 Code Agent，VSCode 中的智能编程助手。你可以自主调用工具完成任务。

## 工作原则
1. 任务规划：先分析需求，拆解步骤，再调度工具逐步执行
2. 文件操作：修改文件前先用 read_file 读取相关代码；优先使用 write_file 的精确替换模式（oldContent+content）做小改动
3. 代码检索：查找符号、函数、调用关系时使用 search_code
4. 终端操作：依赖安装、构建、测试等使用 execute_command，注意评估命令安全性
5. 验证闭环：修改后使用 get_diff 或重新读取确认结果，必要时执行测试验证
6. Token 效率：读取文件时按需分段，避免重复读取大文件；回答简洁直接

## 安全规则
- 只能修改当前工作区内的文件，工作区外文件任何情况下只读（可读取，不可修改/删除）
- 不执行破坏性命令；高危命令会触发用户二次确认
- 不泄露任何敏感信息（密钥、令牌等）
- 不确定时先询问用户，不擅自扩大操作范围

## 输出规范
- 使用 Markdown 格式，代码用代码块包裹并标注语言
- 语言自适应：思考过程与回复必须使用与用户最近一次输入相同的自然语言（用户用中文则中文，用英文则英文）；代码片段、命令、工具参数等非自然语言内容保持原格式
- 完成任务后简要总结：改了什么、为什么、如何验证`;

export { SYSTEM_PROMPT };

/** 引擎内部流式回调（onReasoning 单参数：思考分段由 runTurn 包装层维护并拼接 segmentId） */
interface EngineStreamCallbacks {
  onChunk: (text: string) => void;
  onReasoning: (text: string) => void;
  /** 推理节点增量（carry 为从回复气泡迁移的已推送正文，flush 时一次性携带） */
  onInsight: (segmentId: string, text: string, carry: string | null) => void;
  onStep: (step: AgentStep) => void;
  requestPermission: (req: PermissionRequest) => Promise<boolean>;
  onCommandOutput: (command: string, chunk: string) => void;
  onCompressed: (session: Session) => void;
  /** 轻量运行期提示（如 429 限流退避等待）：不写入会话历史，仅前端瞬时展示 */
  onNotice?: (text: string) => void;
}

/** 引擎运行回调（由服务层桥接 WebView） */
export interface AgentRunCallbacks {
  onChunk: (text: string) => void;
  /** 推理/思考内容增量（深度思考区块实时展示；segmentId 标识当前思考段，与工具节点时序交替） */
  onReasoning: (segmentId: string, text: string) => void;
  /** 推理节点增量（V0.8.0 主干决策结论，工具调用前后分散挂载；carry 为 flush 时需迁移的已推送正文） */
  onInsight: (segmentId: string, text: string, carry: string | null) => void;
  onStep: (step: AgentStep) => void;
  requestPermission: (req: PermissionRequest) => Promise<boolean>;
  onCommandOutput: (command: string, chunk: string) => void;
  onCompressed: (session: Session) => void;
  /** 轻量运行期提示（如 429 限流退避等待）：由服务层推送前端瞬时提示，避免静默等待误判为卡死 */
  onNotice?: (text: string) => void;
}

export interface AgentDeps {
  config: ConfigManager;
  security: SecurityManager;
  audit: AuditLogger;
  sessions: SessionManager;
  usage: UsageTracker;
  context: ContextManager;
  tools: ToolRegistry;
  /** 按模型创建适配器（V1.1.0：多服务商体系下按模型定位所属服务商路由） */
  getAdapter: (modelId: string) => Promise<ModelAdapter>;
}

export class AgentEngine {
  private readonly runs = new Map<string, AbortController>();

  constructor(private readonly deps: AgentDeps) {}

  /** 是否有正在运行的任务 */
  isRunning(sessionId: string): boolean {
    return this.runs.has(sessionId);
  }

  /** 注册会话运行（由服务层创建 AbortController） */
  registerRun(sessionId: string, controller: AbortController): void {
    this.runs.set(sessionId, controller);
  }

  /** 原子注册会话运行（返回 false 表示已有运行中任务，防并发执行同一会话） */
  tryRegisterRun(sessionId: string, controller: AbortController): boolean {
    if (this.runs.has(sessionId)) {
      return false;
    }
    this.runs.set(sessionId, controller);
    return true;
  }

  /** 停止指定会话的 Agent 运行 */
  stop(sessionId: string): void {
    this.runs.get(sessionId)?.abort();
  }

  /** 构建发送给模型的工具集（V0.9.0：对话模式仅挂载只读工具，写入/终端工具不入请求，调度层屏蔽越权调用） */
  private buildTools(mode: RunMode) {
    return this.deps.tools.getDefinitionsForMode(mode);
  }

  /**
   * 执行一轮对话（完整闭环）
   */
  async runTurn(
    session: Session,
    userText: string,
    attachments: AttachedFileRef[],
    modelId: string,
    mode: RunMode,
    cb: AgentRunCallbacks,
    signal: AbortSignal,
    assistantMessageId?: string,
    skipUserAppend = false
  ): Promise<'done' | 'stopped'> {
    // 助手消息占位（try 外声明：收尾落盘时需要引用）
    const assistantMessage: ChatMessage = {
      id: assistantMessageId ?? randomId(),
      role: 'assistant',
      content: '',
      steps: [],
      modelId,
      createdAt: Date.now()
    };

    // 规划步骤
    const planStep: AgentStep = {
      id: randomId(),
      type: 'plan',
      title: mode === 'agent' ? '智能体模式 · 开始执行任务' : '对话模式 · 生成回复',
      status: 'running',
      createdAt: Date.now()
    };
    assistantMessage.steps!.push(planStep);
    cb.onStep(planStep);

    let totalUsage = { inputTokens: 0, outputTokens: 0 };
    let finalContent = '';
    // 思维链内容（多轮工具调用时累积合并）
    let finalReasoning = '';
    let stopped = false;
    let errored: Error | null = null;
    let iterations = 0;
    // assistant 消息是否已持久化到会话（首个工具轮次时提前写入，保证协议顺序：assistant → tool）
    let assistantPersisted = false;
    // Token 真实计数校准：最近一次模型请求的 prompt Token 与请求时消息链长度快照（try 外声明：收尾落盘时写入会话）
    let lastRoundInputTokens = 0;
    let lastRequestChainLen = 0;
    // 时序化分段（V0.6.0 流式分步输出）：思考/工具调用/工具结果按实际执行顺序交替
    const segments: MessageSegment[] = [];
    // 流式期间预插入的工具步骤注册表（tcId → step），执行阶段复用（前端节点即时插入后状态演进）
    const pendingToolSteps = new Map<string, AgentStep>();

    /** 确保末段为 reasoning 段（否则新建），返回当前思考段 */
    const ensureReasoningSegment = (): MessageSegment => {
      const last = segments[segments.length - 1];
      if (last && last.type === 'reasoning') {
        return last;
      }
      const seg: MessageSegment = { id: randomId(), type: 'reasoning', content: '', createdAt: Date.now() };
      segments.push(seg);
      return seg;
    };
    // 包装回调：思考增量同时写入 reasoning 段（流式追加）并携带 segmentId 推送
    const streamCb: EngineStreamCallbacks = {
      ...cb,
      onReasoning: t => {
        const seg = ensureReasoningSegment();
        seg.content = (seg.content ?? '') + t;
        cb.onReasoning(seg.id, t);
      },
      onInsight: (segmentId, text, carry) => {
        // 推理节点段：首次（flush）创建并写入迁移正文，后续增量追加（V0.8.0 主干分层）
        let seg = segments.find(s => s.id === segmentId && s.type === 'insight');
        if (!seg) {
          seg = { id: segmentId, type: 'insight', content: '', createdAt: Date.now() };
          segments.push(seg);
        }
        if (carry) {
          seg.content = carry;
        }
        if (text) {
          seg.content = (seg.content ?? '') + text;
        }
        cb.onInsight(segmentId, text, carry);
      }
    };

    try {
      // 1. 用户消息持久化（重新生成时跳过）
      if (!skipUserAppend) {
        const userMessage: ChatMessage = {
          id: randomId(),
          role: 'user',
          content: userText,
          attachments: attachments.length > 0 ? attachments : undefined,
          createdAt: Date.now()
        };
        this.deps.sessions.appendMessage(session, userMessage);
      }

      // 2. 自动压缩检测（阈值 75%，保障续接后交互效率）
      if (this.deps.context.needsAutoCompress(session, modelId)) {
        const record = await this.deps.context.compress(session, modelId);
        if (record) {
          this.deps.sessions.save(session);
          cb.onCompressed(session);
        }
      }

      // 3. 构建四层上下文消息（系统层 + 摘要层 + 活跃层 + 引用层；对话模式附加能力边界约束）
      const contentWithAttachments = this.buildUserContent(userText, attachments);
      const messages: ModelMessage[] = this.deps.context.buildMessages(session, contentWithAttachments, mode);

      // 初始化移入 try：异常时 finally 仍会清理 runs，避免会话被永久判定为运行中
      const adapter = await this.deps.getAdapter(modelId);
      const params = this.deps.config.getInferenceParams();
      const model = this.deps.config.getModel(modelId);
      const tools = this.buildTools(mode);

      // 最大工具调用轮次：运行时读配置，即时生效（新建/续接会话无需重启）
      const maxIterations = this.deps.config.getMaxToolIterations();

      for (iterations = 0; iterations < maxIterations; iterations++) {
        // 流式调用（请求前记录链长快照，用于对齐本轮 prompt_tokens 的统计口径）
        lastRequestChainLen = session.messages.length;
        // 本轮推理节点段 id（工具轮次的正文将作为 insight 段分散挂载，仅在出现工具调用时启用）
        const insightSegmentId = randomId();
        const result = await this.streamOnce(adapter, model, messages, tools, params, streamCb, signal, session.id, insightSegmentId, mode, tc => {
          // 工具调用解析完整：立即在对话流插入工具执行节点（pending 加载态），无需等待本轮推理结束
          const step: AgentStep = {
            id: randomId(),
            type: 'toolCall',
            title: `调用工具 ${tc.name}`,
            status: 'pending',
            toolName: tc.name,
            toolArgs: tc.arguments,
            createdAt: Date.now()
          };
          assistantMessage.steps!.push(step);
          segments.push({ id: step.id, type: 'toolCall', step, createdAt: Date.now() });
          pendingToolSteps.set(tc.id, step);
          cb.onStep(step);
        });
        if (signal.aborted) {
          stopped = true;
          break;
        }
        if (result.reasoning) {
          finalReasoning += result.reasoning;
        }
        totalUsage.inputTokens += result.usage.inputTokens;
        totalUsage.outputTokens += result.usage.outputTokens;
        lastRoundInputTokens = result.usage.inputTokens;
        // 今日用量实时累加（V0.6.0 P1）：随每次接口响应立即统计，与接口返回计费数据对齐，杜绝滞后
        if (result.usage.inputTokens + result.usage.outputTokens > 0) {
          this.deps.usage.addUsage(
            result.usage.inputTokens,
            result.usage.outputTokens,
            estimateCostCNY(modelId, result.usage.inputTokens, result.usage.outputTokens)
          );
        }

        if (result.toolCalls.length === 0) {
          // 无工具调用：本轮正文为最终回复（V0.8.0 工具轮正文已作为推理节点分散挂载，不再进入回复）
          finalContent += result.content;
          break; // 无工具调用，对话结束
        }
        // 兑底：适配器未触发 onToolCallReady（异常流）时，本轮的正文未 flush 为推理节点段，此处补建避免内容丢失
        if (result.content && !segments.some(s => s.id === insightSegmentId && s.type === 'insight')) {
          const ins: MessageSegment = { id: insightSegmentId, type: 'insight', content: result.content, createdAt: Date.now() };
          segments.push(ins);
          cb.onInsight(insightSegmentId, '', result.content);
        }

        // 记录助手工具调用消息（模型上下文）
        const toolCalls: ToolCall[] = result.toolCalls.map(tc => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments
        }));
        messages.push({
          role: 'assistant',
          content: result.content || null,
          tool_calls: result.toolCalls.map(tc => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: tc.arguments }
          }))
        });
        assistantMessage.toolCalls = [...(assistantMessage.toolCalls ?? []), ...toolCalls];

        // 首个工具轮次：将 assistant 消息提前写入会话（确保协议顺序：assistant(tool_calls) → tool 消息）
        if (!assistantPersisted) {
          session.messages.push(assistantMessage);
          assistantPersisted = true;
        }

        // 工具执行：并行调度分组（连续只读工具并行、不同文件写入并行、命令串行）
        // 记录已执行 id：停止时裁剪 tool_calls，保证与 tool 消息一一对应
        const executedToolIds = new Set<string>();
        for (const group of groupToolCalls(result.toolCalls)) {
          if (signal.aborted) {
            stopped = true;
            break;
          }
          // 步骤复用：流式期间已预插入 toolCall 节点（pending），此处更新为 running 开始执行
          const groupSteps: AgentStep[] = [];
          for (const tc of group) {
            let step = pendingToolSteps.get(tc.id);
            if (!step) {
              // 兜底：流式期间未触发预插入（异常流）时按模型顺序创建
              step = {
                id: randomId(),
                type: 'toolCall',
                title: `调用工具 ${tc.name}`,
                status: 'pending',
                toolName: tc.name,
                toolArgs: tc.arguments,
                createdAt: Date.now()
              };
              assistantMessage.steps!.push(step);
              segments.push({ id: step.id, type: 'toolCall', step, createdAt: Date.now() });
              pendingToolSteps.set(tc.id, step);
              cb.onStep(step);
            }
            step.status = 'running';
            groupSteps.push(step);
            cb.onStep({ ...step });
          }

          // 组内并行执行（execute_command 单元素组等效串行；只读组/不同文件写入组并行）
          // 流式执行流水线：只读工具在推理期间已预启动，直接复用其 Promise（未完成则等待，不重复执行）
          // 终端实时输出仅对命令组生效（命令恒单独成组）
          let liveOutput = '';
          const results: ToolResult[] = await Promise.all(
            group.map((tc, gi) => {
              const pre = result.preexecPromises.get(tc.id);
              if (pre) {
                return pre;
              }
              return this.executeTool(tc, session.id, streamCb, signal, mode, chunk => {
                if (group.length === 1 && tc.name === 'execute_command') {
                  liveOutput += chunk;
                  if (liveOutput.length < MAX_TOOL_RESULT_LEN) {
                    const liveStep: AgentStep = { ...groupSteps[gi], status: 'running', output: liveOutput, command: tc.arguments ? safeParseCommand(tc.arguments) : undefined };
                    cb.onStep(liveStep);
                  }
                }
              });
            })
          );

          // 按模型给出顺序回写结果（tool 消息与 tool_call id 对应，OpenAI 协议允许乱序响应）
          for (let gi = 0; gi < group.length; gi++) {
            const tc = group[gi];
            const toolResult = results[gi];
            const resultStep: AgentStep = {
              ...groupSteps[gi],
              type: 'toolResult',
              title: `${tc.name} 执行${toolResult.success ? '成功' : toolResult.denied ? '被拒绝' : toolResult.cancelled ? '已取消' : '失败'}`,
              status: toolResult.success ? 'success' : 'error',
              result: toolResult.output,
              diff: toolResult.diff,
              filePath: toolResult.filePath,
              command: toolResult.command
            };
            const si = assistantMessage.steps!.findIndex(s => s.id === resultStep.id);
            if (si >= 0) {
              assistantMessage.steps![si] = resultStep;
            }
            // 分段状态演进：toolCall 段原位更新为 toolResult 段（保留时序位置）
            const seg = segments.find(s => s.id === resultStep.id);
            if (seg) {
              seg.type = 'toolResult';
              seg.step = resultStep;
            }
            cb.onStep(resultStep);

            // 工具结果回传模型（多轮闭环）
            const resultText = truncate(toolResult.output, MAX_TOOL_RESULT_LEN).text;
            messages.push({
              role: 'tool',
              content: `${toolResult.success ? '成功' : toolResult.cancelled ? '用户取消' : '失败'}\n${resultText}`,
              tool_call_id: tc.id,
              name: tc.name
            });
            // 工具消息持久化（供会话续接后恢复上下文）
            session.messages.push({
              id: randomId(),
              role: 'tool',
              name: tc.name,
              toolCallId: tc.id,
              content: `${toolResult.success ? '成功' : toolResult.cancelled ? '用户取消' : '失败'}\n${resultText}`,
              createdAt: Date.now()
            });
            executedToolIds.add(tc.id);
          }
          if (signal.aborted) {
            stopped = true;
            break;
          }
        }
        if (stopped) {
          // 停止于多工具中途：裁剪未执行工具，避免 assistant(tool_calls) 缺少对应 tool 响应破坏协议
          assistantMessage.toolCalls = (assistantMessage.toolCalls ?? []).filter(t => executedToolIds.has(t.id));
          break;
        }
        this.deps.sessions.save(session);
      }

      // 规划步骤完成（停止场景标识为已停止）
      planStep.status = stopped ? 'error' : 'success';
      planStep.title = stopped ? '任务已停止' : mode === 'agent' ? '任务执行完成' : '回复完成';
      cb.onStep(planStep);
      assistantMessage.steps![0] = planStep;

      if (iterations >= maxIterations && !stopped && !errored) {
        finalContent += `\n\n> ⚠️ 已达到最大工具调用轮次（${maxIterations}），任务可能未完全完成，请检查结果。可在设置中调整「最大工具调用轮次」以支持更长任务链路。`;
      }
    } catch (err) {
      if (signal.aborted) {
        stopped = true;
      } else {
        errored = err instanceof Error ? err : new Error(String(err));
        planStep.status = 'error';
        planStep.title = `执行失败`;
        cb.onStep(planStep);
        assistantMessage.steps![0] = planStep;
      }
    } finally {
      this.runs.delete(session.id);
    }

    // 5. 结果落盘
    assistantMessage.content = finalContent;
    if (finalReasoning) {
      assistantMessage.reasoning = finalReasoning;
    }
    // 时序化分段落盘（思考/工具节点按实际执行顺序保留，重启/切换会话后可回溯完整链路）
    if (segments.length > 0) {
      assistantMessage.segments = segments;
    }
    if (stopped) {
      assistantMessage.content = finalContent + (finalContent ? '\n\n' : '') + '> ⏹ 用户已停止生成';
    }
    assistantMessage.tokenUsage = {
      inputTokens: totalUsage.inputTokens,
      outputTokens: totalUsage.outputTokens,
      totalTokens: totalUsage.inputTokens + totalUsage.outputTokens
    };
    // 无论内容是否为空都落盘（保证服务层能回找消息并发送 chat:done，避免前端流式状态悬挂）
    if (!assistantPersisted && !errored) {
      session.messages.push(assistantMessage);
    }
    session.modelId = modelId;
    session.mode = mode;
    // Token 统计真实化：模型侧返回的 prompt_tokens 与请求体口径完全一致，作为校准基准；
    // 链长快照用于后续统计判断是否仍适用（快照后新增消息按启发式估算补充，链收缩则整体回退估算）
    if (lastRoundInputTokens > 0) {
      session.lastPromptTokens = lastRoundInputTokens;
      session.lastStatsMessageCount = lastRequestChainLen;
    }
    this.deps.sessions.save(session);

    // 6. 今日用量统计已随每轮流式响应实时累加（V0.6.0），此处无需收尾一次性补记

    if (errored) {
      throw errored;
    }
    return stopped ? 'stopped' : 'done';
  }

  /** 单次流式模型调用（流式执行流水线：只读工具参数接收完整时预启动，推理与执行并行；工具节点即时插入） */
  private async streamOnce(
    adapter: ModelAdapter,
    model: ModelMeta | undefined,
    messages: ModelMessage[],
    tools: ReturnType<AgentEngine['buildTools']>,
    params: { temperature: number; topP: number; maxTokens: number; frequencyPenalty: number },
    cb: EngineStreamCallbacks,
    signal: AbortSignal,
    sessionId: string,
    insightSegmentId: string,
    mode: RunMode,
    onToolCallParsed: (tc: { id: string; name: string; arguments: string }) => void
  ): Promise<{ content: string; reasoning: string; toolCalls: Array<{ id: string; name: string; arguments: string }>; usage: { inputTokens: number; outputTokens: number }; preexecPromises: Map<string, Promise<ToolResult>> }> {
    return new Promise((resolve, reject) => {
      let content = '';
      let reasoning = '';
      /** 本轮正文是否已切换为推理节点流（首个工具调用出现后，后续正文增量归入 insight 段） */
      let insightFlushed = false;
      /** 预启动的只读工具执行 Promise（按 tool_call id 缓存，流结束后复用执行结果） */
      const preexecPromises = new Map<string, Promise<ToolResult>>();
      adapter
        .streamChat(
          {
            model: model?.id ?? this.deps.config.getDefaultModel(),
            messages,
            tools,
            temperature: params.temperature,
            topP: params.topP,
            maxTokens: Math.min(params.maxTokens, model?.maxOutputTokens ?? params.maxTokens),
            frequencyPenalty: params.frequencyPenalty,
            signal
          },
          {
            onText: t => {
              content += t;
              if (insightFlushed) {
                cb.onInsight(insightSegmentId, t, null);
              } else {
                cb.onChunk(t);
              }
            },
            onReasoning: t => {
              reasoning += t;
              cb.onReasoning(t);
            },
            onToolCallReady: tc => {
              // 推理节点 flush（V0.8.0）：工具调用出现即确定本轮为工具轮，已推送的正文从回复气泡迁移为 insight 段
              if (!insightFlushed) {
                insightFlushed = true;
                if (content) {
                  cb.onInsight(insightSegmentId, '', content);
                }
              }
              // 工具节点即时插入（所有工具类型，pending 加载态），不等待本轮思考结束
              onToolCallParsed(tc);
              // 仅只读工具可预启动（无副作用）；参数完整即执行，与剩余思考/文本生成并行
              if (!READONLY_TOOLS.has(tc.name) || signal.aborted) {
                return;
              }
              preexecPromises.set(tc.id, this.executeTool(tc, sessionId, cb, signal, mode));
            },
            onDone: r => {
              resolve({ content: r.content || content, reasoning: r.reasoning || reasoning, toolCalls: r.toolCalls, usage: r.usage, preexecPromises });
            },
            onRateLimited: (waitSec, attempt) => {
              cb.onNotice?.(`服务商限流（429），${waitSec} 秒后自动重试（第 ${attempt} 次），请稍候…`);
            },
            onError: reject
          }
        )
        .catch(reject);
    });
  }

  /** 执行单个工具调用 */
  private async executeTool(
    tc: { id: string; name: string; arguments: string },
    sessionId: string,
    cb: EngineStreamCallbacks,
    signal: AbortSignal,
    mode: RunMode,
    onLiveOutput?: (chunk: string) => void
  ): Promise<ToolResult> {
    const tool = this.deps.tools.get(tc.name);
    if (!tool) {
      return { success: false, output: `未知工具: ${tc.name}` };
    }
    // 统一权限校验（V0.9.0 执行层防线）：所有工具执行前按当前运行模式判定合法性，底层杜绝模式越权
    const modeCheck = this.deps.security.checkToolAllowed(tc.name, mode);
    if (!modeCheck.allowed) {
      this.deps.audit.log({ type: 'permission', action: tc.name, target: tc.name, result: 'denied', detail: '对话模式越权工具调用被拦截', sessionId });
      return { success: false, output: modeCheck.reason ?? '权限拒绝：当前模式不允许该操作', denied: true };
    }
    let args: any = {};
    try {
      args = JSON.parse(tc.arguments || '{}');
    } catch {
      return { success: false, output: `工具参数解析失败: ${tc.arguments.slice(0, 200)}` };
    }
    try {
      return await tool.execute(args, {
        security: this.deps.security,
        audit: this.deps.audit,
        requestPermission: cb.requestPermission,
        sessionId,
        mode,
        onCommandOutput: (cmd, chunk) => {
          cb.onCommandOutput(cmd, chunk);
          onLiveOutput?.(chunk);
        },
        signal
      });
    } catch (err) {
      return { success: false, output: `工具执行异常: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /** 构建含 @ 引用的用户消息内容 */
  private buildUserContent(userText: string, attachments: AttachedFileRef[]): string {
    if (attachments.length === 0) {
      return userText;
    }
    const blocks: string[] = [];
    for (const a of attachments) {
      if (a.kind === 'file' && a.content !== undefined) {
        // 行范围引用（编辑器右键选中注入）：标注行号范围，与全文件引用区分
        const rangeAttr = typeof a.startLine === 'number' && typeof a.endLine === 'number' ? ` lines="${a.startLine}-${a.endLine}"` : '';
        blocks.push(`<file path="${a.path}"${rangeAttr}>\n${a.content}${a.truncated ? '\n…(内容过大已截断)' : ''}\n</file>`);
      } else if (a.kind === 'folder') {
        blocks.push(`<folder path="${a.path}">\n${a.content ?? ''}\n</folder>`);
      }
    }
    if (blocks.length === 0) {
      return userText;
    }
    return `# 引用资源\n${blocks.join('\n\n')}\n\n# 用户消息\n${userText}`;
  }

  /** 工作区信息描述（附加到系统层） */
  workspaceSummary(): string {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) {
      return '';
    }
    return `\n## 当前工作区\n路径: ${ws.uri.fsPath}`;
  }
}

/** 从工具参数 JSON 中安全提取命令文本 */
function safeParseCommand(argsJson: string): string | undefined {
  try {
    const obj = JSON.parse(argsJson);
    return typeof obj?.command === 'string' ? obj.command : undefined;
  } catch {
    return undefined;
  }
}

/** 提取 write_file 的目标路径（用于同路径串行、不同路径并行分组） */
function writeTarget(tc: { name: string; arguments: string }): string {
  try {
    const a = JSON.parse(tc.arguments || '{}');
    return `w:${String(a.path ?? '')}`;
  } catch {
    return 'w:?';
  }
}

/**
 * 工具并行调度分组：连续只读工具合并为一组（并行）；连续 write_file 且目标路径互不相同合并为一组（并行）；
 * execute_command 与其他未知工具单独成组（串行，保持命令执行语义与顺序依赖）
 */
function groupToolCalls(toolCalls: Array<{ id: string; name: string; arguments: string }>): Array<Array<{ id: string; name: string; arguments: string }>> {
  const groups: Array<Array<{ id: string; name: string; arguments: string }>> = [];
  for (const tc of toolCalls) {
    const prev = groups[groups.length - 1];
    if (tc.name === 'execute_command') {
      groups.push([tc]);
      continue;
    }
    if (tc.name === 'write_file') {
      const key = writeTarget(tc);
      if (prev && prev.every(p => p.name === 'write_file') && !prev.some(p => writeTarget(p) === key)) {
        prev.push(tc);
      } else {
        groups.push([tc]);
      }
      continue;
    }
    if (READONLY_TOOLS.has(tc.name)) {
      if (prev && prev.every(p => READONLY_TOOLS.has(p.name))) {
        prev.push(tc);
      } else {
        groups.push([tc]);
      }
      continue;
    }
    groups.push([tc]);
  }
  return groups;
}
