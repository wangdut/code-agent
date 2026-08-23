/**
 * Code Agent - 核心共享类型定义
 * 定义扩展侧与 WebView 侧共用的数据契约
 */

/** 模型元数据 */
export interface ModelMeta {
  /** 模型标识（API 调用使用） */
  id: string;
  /** 展示名称 */
  name: string;
  /** 总上下文窗口大小（Token） */
  contextWindow: number;
  /** 最大输出 Token 数 */
  maxOutputTokens: number;
  /** 计费类型说明 */
  pricing: string;
  /** 所属服务商 id（V1.1.0 多模型体系；旧缓存模型缺省时归属预置服务商） */
  providerId?: string;
}

/**
 * 模型服务商配置（V1.1.0 多模型接入体系）
 * 服务商为模型调用路由的单元：Base URL 决定接口地址，API Key 按服务商独立加密存储
 */
export interface ProviderInfo {
  id: string;
  name: string;
  /** OpenAI 兼容协议接口 Base URL */
  baseUrl: string;
  /** 是否已配置 API Key */
  hasApiKey: boolean;
  /** 预置服务商（DeepSeek）：保证开箱即用，不可删除、可编辑 */
  preset?: boolean;
  /** 最近一次模型列表同步时间（毫秒时间戳） */
  lastSyncAt?: number;
  /** 最近一次同步失败原因（成功/未同步时为空） */
  syncError?: string;
}

/** 运行模式 */
export type RunMode = 'chat' | 'agent';

/**
 * 只读工具名集合（V0.9.0 对话模式可用工具集）
 * 无副作用操作：文件读取、目录遍历、代码检索、diff 对比；支持并行执行与流式预启动
 * 同时作为统一权限校验层的判定基准：对话模式下仅这些工具可被执行
 */
export const READONLY_TOOL_NAMES = ['read_file', 'list_dir', 'search_code', 'get_diff'] as const;

/** Token 用量统计 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/** 文件引用（@引用机制） */
export interface AttachedFileRef {
  /** 相对工作区路径或绝对路径 */
  path: string;
  /** file | folder */
  kind: 'file' | 'folder';
  /** 引用时的文件内容（仅 file，注入上下文时填充） */
  content?: string;
  /** 是否超限截断 */
  truncated?: boolean;
  /** 行范围引用起始行（1-based，编辑器右键选中代码注入） */
  startLine?: number;
  /** 行范围引用结束行（1-based，含两端） */
  endLine?: number;
}

/** 工具调用定义 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // JSON 字符串
}

/** 执行步骤（Agent 执行态可视化） */
export interface AgentStep {
  id: string;
  /** plan | thinking | toolCall | toolResult | summary */
  type: 'plan' | 'thinking' | 'toolCall' | 'toolResult' | 'summary';
  title: string;
  status: 'pending' | 'running' | 'success' | 'error' | 'waiting';
  /** 工具名（toolCall/toolResult） */
  toolName?: string;
  /** 工具参数（toolCall） */
  toolArgs?: string;
  /** 执行结果（toolResult） */
  result?: string;
  /** 命令（终端工具） */
  command?: string;
  /** 终端输出 */
  output?: string;
  /** diff 内容（文件修改） */
  diff?: string;
  /** diff 关联的文件路径（编辑器装饰与跳转定位） */
  filePath?: string;
  /** 权限请求 id（waiting 状态） */
  requestId?: string;
  createdAt: number;
}

/**
 * 消息分段（V0.6.0 时序化流式分步输出；V0.8.0 推理链路分层）
 * 思考（深度思考过程）、推理节点（主干决策结论）、工具调用、执行结果按实际执行顺序交替构成完整执行链路；
 * reasoning/insight 段内容流式追加，工具段（toolCall/toolResult）共享同一 step（id 相同，状态演进）
 */
export interface MessageSegment {
  id: string;
  /** reasoning（深度思考过程） | insight（推理节点/主干决策结论） | toolCall | toolResult */
  type: 'reasoning' | 'insight' | 'toolCall' | 'toolResult';
  /** reasoning/insight 段的内容（流式追加） */
  content?: string;
  /** 工具段关联的执行步骤 */
  step?: AgentStep;
  createdAt: number;
}

/** 聊天消息 */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  /** 工具消息对应的工具名 */
  name?: string;
  /** tool 角色消息关联的 tool_call id */
  toolCallId?: string;
  /** assistant 消息携带的工具调用 */
  toolCalls?: ToolCall[];
  /** assistant 消息的推理/思考内容（DeepSeek 推理模型思维链，思考区块展示） */
  reasoning?: string;
  /** assistant 消息的执行步骤 */
  steps?: AgentStep[];
  /** 时序化分段（V0.6.0 流式分步输出结构；旧消息无该字段时前端回退 reasoning + steps 渲染） */
  segments?: MessageSegment[];
  /** 消息附件引用 */
  attachments?: AttachedFileRef[];
  tokenUsage?: TokenUsage;
  modelId?: string;
  createdAt: number;
}

/** 压缩记录块（压缩可回溯） */
export interface CompressRecord {
  id: string;
  /** 压缩后摘要 */
  content: string;
  /** 压缩前完整原文 */
  original: string;
  /** 压缩前 Token 估算 */
  tokenBefore: number;
  /** 压缩后 Token 估算 */
  tokenAfter: number;
  compressedAt: number;
}

/** 会话元数据 */
export interface SessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  modelId: string;
  mode: RunMode;
  messageCount: number;
}

/** 完整会话 */
export interface Session extends SessionMeta {
  /** 活跃对话（未压缩的完整消息） */
  messages: ChatMessage[];
  /** 历史摘要层（压缩块） */
  summaries: CompressRecord[];
  /** 压缩记录（含原文，供回溯查看） */
  compressLog: CompressRecord[];
  /** 最近一次模型请求实际接收的 prompt Token（真实计数校准基准，与请求体口径完全一致） */
  lastPromptTokens?: number;
  /** 上述真实计数的消息链长度快照（链长变化后回退为估算值） */
  lastStatsMessageCount?: number;
}

/** 会话摘要（列表展示用） */
export interface SessionListItem {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

/** 权限请求 */
export interface PermissionRequest {
  id: string;
  type: 'fileWrite' | 'command' | 'highRiskCommand';
  title: string;
  detail: string;
  /** 影响范围描述 */
  impact: string;
  payload: Record<string, unknown>;
}

/** 当日用量统计 */
export interface DailyUsage {
  date: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** 请求次数 */
  requests: number;
  /** 当日已消费金额估算（CNY，按模型单价 × Token 用量本地累计，自然日口径） */
  usedAmount: number;
}

/** 全局设置快照（发送给 WebView） */
export interface SettingsSnapshot {
  /** 是否已配置至少一个服务商的 API Key（V1.1.0 起按服务商维度判定） */
  apiKeyConfigured: boolean;
  /** 已添加的模型服务商（V1.1.0 服务商-模型两级体系） */
  providers: ProviderInfo[];
  models: ModelMeta[];
  defaultModel: string;
  defaultMode: RunMode;
  requestTimeout: number;
  proxy: string;
  temperature: number;
  topP: number;
  maxTokens: number;
  frequencyPenalty: number;
  /**
   * 权限管理（仅智能体模式下生效）：ask 询问模式 / auto 全自动模式
   * 第一层「运行模式」决定工具集边界；第二层「权限管理」仅控制智能体模式下工作区内文件写入的确认机制，对话模式下不生效
   */
  permissionMode: 'ask' | 'auto';
  terminalAutoApprove: boolean;
  highRiskCommands: boolean;
  /** 单轮任务最大工具调用轮次（1-1000，默认 20） */
  maxToolIterations: number;
  autoCompressThreshold: number;
  historyPath: string;
  effectiveHistoryPath: string;
  folderIncludePatterns: string[];
  logLevel: string;
  debugMode: boolean;
  autoUpdateCheck: boolean;
}

/** 会话上下文统计 */
export interface SessionContextStats {
  sessionId: string;
  usedTokens: number;
  windowTokens: number;
  maxOutputTokens: number;
  /** 已用 Token 是否为模型侧真实返回的 prompt_tokens 校准值（true）还是启发式估算（false） */
  calibrated: boolean;
  /** 分层占用 */
  layers: {
    system: number;
    active: number;
    summaries: number;
  };
}

/** WebView -> 扩展 消息协议 */
export type WebviewToExtensionMessage =
  | { type: 'ready' }
  | { type: 'chat:send'; sessionId: string; text: string; attachments: AttachedFileRef[]; modelId: string; mode: RunMode }
  | { type: 'chat:regenerate'; sessionId: string; messageId: string }
  | { type: 'chat:stop'; sessionId: string }
  | { type: 'chat:compress'; sessionId: string }
  | { type: 'permission:respond'; requestId: string; approved: boolean }
  | { type: 'session:new' }
  | { type: 'session:select'; sessionId: string }
  | { type: 'session:setModel'; sessionId: string; modelId: string }
  | { type: 'session:rename'; sessionId: string; title: string }
  | { type: 'session:delete'; sessionId: string }
  | { type: 'session:export'; sessionId: string }
  | { type: 'session:search'; keyword: string }
  | { type: 'settings:get' }
  | { type: 'settings:update'; settings: Partial<Record<string, unknown>>; apiKey?: string; clearApiKey?: boolean }
  | { type: 'model:add'; model: ModelMeta }
  | { type: 'model:update'; oldId: string; model: ModelMeta }
  | { type: 'model:delete'; modelId: string }
  | { type: 'provider:add'; name: string; baseUrl: string; apiKey?: string }
  | { type: 'provider:update'; id: string; name: string; baseUrl: string; apiKey?: string; clearApiKey?: boolean }
  | { type: 'provider:delete'; id: string }
  | { type: 'provider:refresh'; id: string }
  | { type: 'files:list'; query: string }
  | { type: 'editor:open'; filePath: string }
  | { type: 'usage:query' }
  | { type: 'openSettingsPage' };

/** 扩展 -> WebView 消息协议 */
export type ExtensionToWebviewMessage =
  | { type: 'boot:ack'; ok: boolean }
  | { type: 'session:list'; sessions: SessionListItem[] }
  | { type: 'session:loaded'; session: Session; stats: SessionContextStats }
  | { type: 'session:updated'; session: Session }
  | { type: 'session:deleted'; sessionId: string }
  | { type: 'session:new'; session: Session }
  | { type: 'settings:state'; settings: SettingsSnapshot }
  | { type: 'chat:start'; sessionId: string; messageId: string }
  | { type: 'chat:chunk'; sessionId: string; messageId: string; text: string }
  /** segmentId 标识当前思考段落（前端据此追加或新建 reasoning 段，实现思考与工具的时序交替） */
  | { type: 'chat:reasoning'; sessionId: string; messageId: string; segmentId: string; text: string }
  /** 推理节点增量（V0.8.0 主干内容；carry 为工具调用出现时从回复气泡迁移的已推送正文，仅 flush 时携带） */
  | { type: 'chat:insight'; sessionId: string; messageId: string; segmentId: string; text: string; carry?: string }
  | { type: 'chat:step'; sessionId: string; messageId: string; step: AgentStep }
  | { type: 'chat:done'; sessionId: string; messageId: string; message: ChatMessage }
  | { type: 'chat:error'; sessionId: string; messageId: string; error: string }
  | { type: 'chat:stopped'; sessionId: string; messageId: string }
  | { type: 'permission:request'; request: PermissionRequest }
  | { type: 'stats:update'; stats: SessionContextStats }
  | { type: 'files:result'; query: string; paths: string[] }
  | { type: 'usage:result'; usage: { today: DailyUsage | null; balance?: string; balanceError?: string } }
  | { type: 'compressed'; sessionId: string; record: CompressRecord }
  | { type: 'editor:inject'; refs: AttachedFileRef[] };
