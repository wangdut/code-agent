/**
 * 上下文管理模块
 * 四层优先级架构：
 *   1. 系统指令层：Agent 角色定义、工具说明、安全规则（固定占用，优先级最高）
 *   2. 活跃对话层：最近 N 轮完整对话与执行结果（全量信息）
 *   3. 历史摘要层：早期对话经结构化摘要压缩后保留
 *   4. 引用资源层：用户 @ 引用的文件，按需加载、未持续引用自动降级
 * 自动/手动压缩：上下文达到模型窗口阈值（默认 75%）触发，差异化压缩算法
 */
import { ChatMessage, CompressRecord, ImageRef, ModelMeta, RunMode, Session, SessionContextStats } from '../types';
import { estimateTokens } from './tokenCounter';
import { ModelAdapter, ModelMessage } from '../models/modelAdapter';
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_OUTPUT_TOKENS } from '../config/configManager';
import { randomId } from '../utils/id';

/** 压缩时的最小保留消息数（避免压缩后上下文过空） */
const MIN_KEEP_MESSAGES = 4;

/** 上下文动态裁剪：距离消息链末尾超过该条数的历史 tool 消息才会降级 */
const TOOL_DEGRADE_DISTANCE = 16;
/** 上下文动态裁剪：tool 消息内容超过该字符数才降级（保留头部结论与尾部细节） */
const TOOL_DEGRADE_LEN = 4000;
/** 降级时保留的头部/尾部字符数 */
const TOOL_DEGRADE_HEAD = 2000;
const TOOL_DEGRADE_TAIL = 1000;

/** 压缩摘要系统提示词（结构化摘要方案） */
const SUMMARIZE_SYSTEM = `你是对话压缩器。将以下编程会话内容压缩为结构化摘要，要求：
1. 保留：核心需求与目标、已完成的修改（文件路径与关键改动）、关键结论与决策、未解决的问题、执行错误与修复方式
2. 压缩策略：代码片段只保留函数签名与核心逻辑，裁剪注释与非核心代码；执行日志只保留结论与关键报错；对话文本提炼核心需求，去除冗余表述
3. 使用简洁的中文要点输出，每类信息用"## 小节"分组，总量控制在 600 字以内`;

/**
 * 对话模式系统约束（V0.9.0 权限模型修正）
 * 明确告知模型能力边界：仅只读工具可用、写入/终端操作会被系统拒绝，避免无效越权调用
 */
const CHAT_MODE_CONSTRAINT = `

## 当前模式约束（对话模式）
- 当前处于对话模式：仅可使用只读工具（read_file / list_dir / search_code / get_diff / web_search）读取工作区或本地任意路径的文件与目录、联网检索外部信息，基于文件内容与搜索结果回答用户问题
- 禁止修改、写入、删除文件，禁止执行终端命令；此类操作会被系统一律拒绝
- 如用户需要修改代码或执行命令，请明确告知用户：切换至智能体模式后即可执行`;

export class ContextManager {
  private systemPrompt = '';

  constructor(
    /** 按模型创建适配器（V1.1.0：多服务商体系下按模型定位所属服务商路由） */
    private readonly getAdapter: (modelId: string) => Promise<ModelAdapter>,
    private readonly getModel: (id: string) => ModelMeta | undefined,
    private readonly getThreshold: () => number
  ) {}

  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  getSystemPromptTokens(): number {
    return estimateTokens(this.systemPrompt);
  }

  /**
   * 计算会话上下文统计（分层占用）
   * Token 口径：优先采用模型侧返回的 prompt_tokens 校准值（与请求体口径一致）；
   * 校准快照之后新增的消息按启发式估算补充，链收缩（压缩/重新生成）或快照缺失时整体回退启发式估算
   */
  computeStats(session: Session, modelId: string): SessionContextStats {
    const model = this.getModel(modelId);
    const windowTokens = model?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
    const system = this.getSystemPromptTokens();
    const summaries = session.summaries.reduce((acc, s) => acc + estimateTokens(s.content), 0);
    const active = session.messages.reduce((acc, m) => acc + this.messageTokens(m), 0);
    const snapshotLen = session.lastStatsMessageCount;
    const promptBase = session.lastPromptTokens;
    let usedTokens = system + summaries + active;
    let calibrated = false;
    if (
      typeof snapshotLen === 'number' &&
      typeof promptBase === 'number' &&
      promptBase > 0 &&
      session.messages.length >= snapshotLen
    ) {
      const added = session.messages.slice(snapshotLen).reduce((acc, m) => acc + this.messageTokens(m), 0);
      usedTokens = promptBase + added;
      calibrated = true;
    }
    return {
      sessionId: session.id,
      usedTokens,
      windowTokens,
      maxOutputTokens: model?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      calibrated,
      layers: { system, active, summaries }
    };
  }

  messageTokens(msg: ChatMessage): number {
    let t = estimateTokens(msg.content);
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        t += estimateTokens(tc.name) + estimateTokens(tc.arguments);
      }
    }
    if (msg.attachments) {
      for (const a of msg.attachments) {
        t += estimateTokens(a.content ?? '') + 16;
      }
    }
    // 图片启发式估算（V1.4.0 多模态）：主流服务商按分辨率计费单张约 85～1700 Token，取中位固定值；
    // 请求后由模型侧 prompt_tokens 真实计数校准覆盖，不影响存量纯文本会话统计
    if (msg.images && msg.images.length > 0) {
      t += msg.images.length * 1024;
    }
    return t + 8; // 消息结构开销估算
  }

  /** 判断是否需要自动压缩 */
  needsAutoCompress(session: Session, modelId: string): boolean {
    const stats = this.computeStats(session, modelId);
    if (stats.windowTokens <= 0) {
      return false;
    }
    return stats.usedTokens / stats.windowTokens >= this.getThreshold();
  }

  /**
   * 压缩会话：将最早的一部分活跃对话转为摘要层
   * 差异化压缩算法 + 压缩可回溯（记录原文）
   * 协议合法性：切分边界自动对齐，禁止在 assistant(tool_calls) 与 tool 响应之间断开配对
   */
  async compress(session: Session, modelId: string): Promise<CompressRecord | null> {
    if (session.messages.length <= MIN_KEEP_MESSAGES + 2) {
      return null;
    }
    // 保留最近 N 条活跃消息，其余压缩；边界对齐后 tool 消息不会孤立留在活跃层开头
    const keepCount = Math.max(MIN_KEEP_MESSAGES, Math.ceil(session.messages.length * 0.4));
    const cut = this.alignCompressBoundary(session.messages, session.messages.length - keepCount);
    const toCompress = session.messages.slice(0, cut);
    if (toCompress.length === 0) {
      return null;
    }
    const original = toCompress.map(m => this.messageToText(m)).join('\n\n');
    const tokenBefore = estimateTokens(original);

    let content = '';
    try {
      const adapter = await this.getAdapter(modelId);
      const messages: ModelMessage[] = [
        { role: 'system', content: SUMMARIZE_SYSTEM },
        { role: 'user', content: original.slice(0, 60000) }
      ];
      const resp = await adapter.chat({ model: modelId, messages, temperature: 0.2, maxTokens: 1500 });
      content = resp.content.trim();
    } catch {
      // 模型压缩失败时降级为规则压缩：截断每条消息
      content = this.fallbackCompress(toCompress);
    }
    if (!content) {
      content = this.fallbackCompress(toCompress);
    }

    const record: CompressRecord = {
      id: randomId(),
      content,
      original,
      tokenBefore,
      tokenAfter: estimateTokens(content),
      compressedAt: Date.now()
    };

    // 活跃对话层移除已压缩消息，转入摘要层；原文保留供回溯
    session.messages = session.messages.slice(cut);
    session.summaries.push(record);
    session.compressLog.push(record);
    // 清除 Token 校准快照：promptBase 对应的原始消息链已被摘要替代，旧基准与新请求体口径失配，
    // 避免链长重新增长后误用旧校准值高估占用（回退为启发式估算）
    delete session.lastPromptTokens;
    delete session.lastStatsMessageCount;
    return record;
  }

  /**
   * 压缩边界对齐：切分点不能落在协议配对中间
   * tool 消息必须紧随其 assistant(tool_calls) 消息，因此保留部分不能以 tool 消息开头；
   * 将开头的 tool 消息继续归入压缩部分，直到遇到非 tool 消息（至少保留最后 1 条）。
   */
  private alignCompressBoundary(messages: ChatMessage[], cut: number): number {
    let aligned = cut;
    while (aligned < messages.length - 1 && messages[aligned].role === 'tool') {
      aligned++;
    }
    return aligned;
  }

  /** 规则降级压缩：保留每条消息的前 300 字符与角色标记 */
  private fallbackCompress(messages: ChatMessage[]): string {
    const parts: string[] = [];
    for (const m of messages) {
      const label = m.role === 'user' ? '用户' : m.role === 'assistant' ? (m.toolCalls?.length ? 'Agent(工具调用)' : 'Agent') : '工具结果';
      const text = m.content.length > 300 ? m.content.slice(0, 300) + '…(已截断)' : m.content;
      parts.push(`[${label}] ${text}`);
    }
    return parts.join('\n');
  }

  /** 将消息转为纯文本（用于压缩原文） */
  messageToText(m: ChatMessage): string {
    let head = '';
    switch (m.role) {
      case 'user':
        head = '用户: ';
        break;
      case 'assistant':
        head = m.toolCalls?.length ? `Agent 调用工具 ${m.toolCalls.map(t => t.name).join(', ')}:\n` : 'Agent: ';
        break;
      case 'tool':
        head = `工具 [${m.name ?? ''}] 结果: `;
        break;
      case 'system':
        head = '系统: ';
        break;
    }
    // 图片不进入压缩原文（视觉内容无法文本化摘要），仅标注存在性避免上下文语义断裂
    const imageNote = m.images && m.images.length > 0 ? `\n(附带 ${m.images.length} 张图片)` : '';
    return head + m.content + imageNote;
  }

  /** 构建发送给模型的完整消息序列（系统层 + 摘要层 + 活跃层 + 引用层；images 为当前轮用户消息携带的图片） */
  buildMessages(session: Session, newUserContent: string, mode?: RunMode, images?: ImageRef[]): ModelMessage[] {
    const messages: ModelMessage[] = [];
    if (this.systemPrompt) {
      // 语言自适应：按用户最近一次输入的主导语言注入动态语言约束（思考与回复跟随用户语言）
      const lang = this.detectDominantLanguage(newUserContent);
      // 对话模式附加能力边界约束（V0.9.0：只读工具与拦截规则，减少无效越权调用）
      const modeConstraint = mode === 'chat' ? CHAT_MODE_CONSTRAINT : '';
      messages.push({
        role: 'system',
        content: `${this.systemPrompt}${modeConstraint}\n\n## 语言约束\n用户最近一次输入以${lang === 'zh' ? '中文' : '英文'}为主，请使用${lang === 'zh' ? '中文' : '英文'}进行思考与回复；代码、命令、工具参数等非自然语言内容保持原格式。`
      });
    }
    // 历史摘要层
    if (session.summaries.length > 0) {
      const summaryText = session.summaries
        .map((s, i) => `=== 早期对话摘要 ${i + 1}（${new Date(s.compressedAt).toLocaleString()} 压缩）===\n${s.content}`)
        .join('\n\n');
      messages.push({
        role: 'system',
        content: `以下是历史对话的结构化摘要，代表已完成的工作与结论，供上下文参考：\n${summaryText}`
      });
    }
    // 活跃对话层（跳过最后一条 user 消息：当前轮内容由引用资源层单独注入，避免重复）
    for (let i = 0; i < session.messages.length; i++) {
      const m = session.messages[i];
      if (i === session.messages.length - 1 && m.role === 'user') {
        continue;
      }
      // 上下文动态裁剪：较早的历史 tool 输出轻量降级（仅发送时降级，持久化原文保持不变）
      // 保留头部结论（文件头/命令头）与尾部细节（错误信息/关键结果），中间大段正文裁剪
      const depth = session.messages.length - 1 - i;
      if (m.role === 'tool' && depth > TOOL_DEGRADE_DISTANCE && m.content.length > TOOL_DEGRADE_LEN) {
        messages.push({
          role: 'tool',
          content: this.degradeToolContent(m.content),
          tool_call_id: m.toolCallId ?? '',
          name: m.name
        });
      } else {
        messages.push(this.chatMessageToModel(m));
      }
    }
    // 引用资源层：@ 引用内容已合并进用户消息文本；多模态图片随当前轮 user 消息一并下发（适配器层组装内容块）
    messages.push({ role: 'user', content: newUserContent, images: images && images.length > 0 ? images : undefined });
    // 发送前最后一道防线：协议合法性校验与自动修正（防止 400 错误）
    return this.validateMessageChain(messages);
  }

  /**
   * 消息链合法性校验与自动修正（发送前前置校验）
   * OpenAI 兼容协议硬性规则：
   *   - tool 消息必须是 assistant(tool_calls) 的直接响应（tool_call_id 匹配且紧跟其后）
   *   - assistant(tool_calls) 的每个 tool_call 都必须有对应 tool 响应，否则整个 tool_calls 非法
   * 修正策略：
   *   - 孤立 tool 消息（无配对 / id 不匹配）→ 移除
   *   - 未完整响应的 tool_calls → 移除该 assistant 的 tool_calls 及其已输出的 tool 响应（整体降级）
   */
  private validateMessageChain(messages: ModelMessage[]): ModelMessage[] {
    const out: ModelMessage[] = [];
    let pairStart = -1; // 当前配对序列中 assistant(tool_calls) 在 out 中的索引
    let pendingIds = new Set<string>();

    // 前一个配对未完整响应：移除其 tool_calls 及已输出的 tool 响应，整体降级为纯文本
    const degradePair = () => {
      if (pairStart < 0) {
        return;
      }
      const prev = out[pairStart];
      if (prev.role === 'assistant' && prev.tool_calls) {
        prev.tool_calls = undefined;
        if (!prev.content) {
          prev.content = '(工具调用未完成)';
        }
      }
      // 该配对已输出的 tool 响应此时成为孤立消息，一并移除
      for (let i = out.length - 1; i > pairStart; i--) {
        if (out[i].role === 'tool') {
          out.splice(i, 1);
        }
      }
      pairStart = -1;
      pendingIds = new Set();
    };

    for (const m of messages) {
      if (m.role === 'assistant' && m.tool_calls?.length) {
        // 新的工具调用出现：前一个配对若未完整响应则降级
        if (pairStart >= 0 && pendingIds.size > 0) {
          degradePair();
        }
        pairStart = out.length;
        pendingIds = new Set(m.tool_calls.map(tc => tc.id));
        out.push(m);
        continue;
      }
      if (m.role === 'tool') {
        const id = m.tool_call_id ?? '';
        if (pairStart >= 0 && pendingIds.has(id)) {
          pendingIds.delete(id);
          out.push(m);
        }
        // 孤立 tool 消息（无配对或 id 不匹配）→ 直接移除
        continue;
      }
      // user/system：中断配对序列
      if (pairStart >= 0 && pendingIds.size > 0) {
        degradePair();
      } else {
        pairStart = -1;
        pendingIds = new Set();
      }
      out.push(m);
    }
    // 末尾的配对未完整响应 → 降级
    if (pairStart >= 0 && pendingIds.size > 0) {
      degradePair();
    }
    return out;
  }

  /** 检测文本主导语言：CJK 字符占比不低于英文字母占比且存在 CJK 时视为中文，否则英文（中英混合以主导语言为准） */
  private detectDominantLanguage(text: string): 'zh' | 'en' {
    if (!text) {
      return 'zh';
    }
    let cjk = 0;
    let latin = 0;
    for (const ch of text) {
      const code = ch.codePointAt(0) ?? 0;
      if (
        (code >= 0x2e80 && code <= 0x9fff) ||
        (code >= 0xac00 && code <= 0xd7af) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0x3000 && code <= 0x303f) ||
        (code >= 0xff00 && code <= 0xffef)
      ) {
        cjk++;
      } else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) {
        latin++;
      }
    }
    return cjk > 0 && cjk >= latin ? 'zh' : 'en';
  }

  /** 上下文动态裁剪：超长历史 tool 输出降级为「头部结论 + 省略标记 + 尾部细节」 */
  private degradeToolContent(content: string): string {
    const head = content.slice(0, TOOL_DEGRADE_HEAD);
    const tail = content.slice(-TOOL_DEGRADE_TAIL);
    return `${head}\n…(中间内容已裁剪，原 ${content.length} 字符，完整原文保留于本地会话记录)\n${tail}`;
  }

  chatMessageToModel(m: ChatMessage): ModelMessage {
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map(tc => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.arguments }
        }))
      };
    }
    if (m.role === 'tool') {
      return { role: 'tool', content: m.content, tool_call_id: m.toolCallId ?? '', name: m.name };
    }
    // user 历史消息携带的图片随消息重发（多轮视觉追问场景，协议口径与首轮一致）
    if (m.role === 'user' && m.images && m.images.length > 0) {
      return { role: 'user', content: m.content, images: m.images };
    }
    return { role: m.role, content: m.content };
  }
}
