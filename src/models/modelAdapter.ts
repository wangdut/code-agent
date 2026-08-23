/**
 * 模型适配层 - 适配器设计模式
 * 统一调用接口，兼容 OpenAI 协议的所有模型服务（DeepSeek 等），支持快速扩展新模型
 */
import * as http from 'http';
import * as https from 'https';
import { TokenUsage } from '../types';

/** 模型消息（OpenAI 格式） */
export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

/** 工具定义（OpenAI function 格式） */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface StreamCallbacks {
  /** 增量文本（可能为 null，仅工具调用时） */
  onText?: (text: string) => void;
  /** 增量推理/思考内容（DeepSeek 推理模型 reasoning_content 字段） */
  onReasoning?: (text: string) => void;
  /** 单个工具调用参数接收完整时回调（流式执行流水线：只读工具可预启动，推理与执行并行） */
  onToolCallReady?: (tc: ToolCallResult) => void;
  /** 完整推理结束后的工具调用 */
  onDone?: (result: { content: string; reasoning: string; toolCalls: ToolCallResult[]; usage: TokenUsage; finishReason: string }) => void;
  /** 错误 */
  onError?: (error: Error) => void;
}

export interface ToolCallResult {
  id: string;
  name: string;
  arguments: string;
}

export interface ChatRequestOptions {
  model: string;
  messages: ModelMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  frequencyPenalty?: number;
  signal?: AbortSignal;
}

/** 模型适配器统一接口 */
export interface ModelAdapter {
  /** 适配器名称 */
  readonly name: string;
  /** 流式对话（SSE） */
  streamChat(opts: ChatRequestOptions, callbacks: StreamCallbacks): Promise<void>;
  /** 非流式对话（用于压缩等内部任务） */
  chat(opts: ChatRequestOptions): Promise<{ content: string; usage: TokenUsage }>;
  /** 查询账户余额（部分服务商支持） */
  queryBalance(): Promise<string>;
}

function getAgent(proxy: string | undefined): { httpAgent?: http.Agent; httpsAgent?: https.Agent } {
  if (!proxy) {
    return {};
  }
  try {
    const { HttpsProxyAgent } = require('https-proxy-agent');
    const proxyUrl = proxy.includes('://') ? proxy : `http://${proxy}`;
    return { httpsAgent: new HttpsProxyAgent(proxyUrl) };
  } catch {
    return {};
  }
}

function fetchJson(url: string, init: { method?: string; headers?: Record<string, string>; body?: string; timeout?: number; proxy?: string; signal?: AbortSignal; onData?: (chunk: string) => void } = {}): Promise<{ status: number; json: any; raw: string }> {
  return new Promise((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      reject(new Error(`无效的 URL: ${url}`));
      return;
    }
    const agents = getAgent(init.proxy);
    const isHttps = target.protocol === 'https:';
    const mod = isHttps ? https : http;
    const timeout = init.timeout ?? 120000;
    const req = mod.request(
      target,
      {
        method: init.method ?? 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...init.headers
        },
        ...agents
      },
      res => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {
          raw += chunk;
          init.onData?.(chunk);
        });
        res.on('end', () => {
          let json: any = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch {
            // 非 JSON 响应
          }
          resolve({ status: res.statusCode ?? 0, json, raw });
        });
        res.on('error', reject);
      }
    );
    req.setTimeout(timeout, () => req.destroy(new Error(`请求超时（${Math.round(timeout / 1000)}s）`)));
    req.on('error', reject);
    if (init.body) {
      req.write(init.body);
    }
    if (init.signal) {
      if (init.signal.aborted) {
        req.destroy(new Error('aborted'));
      } else {
        init.signal.addEventListener('abort', () => req.destroy(new Error('aborted')));
      }
    }
    req.end();
  });
}

/**
 * OpenAI 协议适配器
 * 兼容 DeepSeek 及所有 OpenAI 协议兼容服务
 */
export class OpenAICompatibleAdapter implements ModelAdapter {
  readonly name = 'openai-compatible';

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly proxy?: string,
    private readonly timeout = 120000
  ) {}

  private buildHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json'
    };
  }

  async streamChat(opts: ChatRequestOptions, callbacks: StreamCallbacks): Promise<void> {
    const body: Record<string, unknown> = {
      model: opts.model,
      messages: opts.messages,
      stream: true,
      stream_options: { include_usage: true }
    };
    if (opts.tools && opts.tools.length > 0) {
      body.tools = opts.tools;
      body.tool_choice = 'auto';
    }
    if (opts.temperature !== undefined) body.temperature = opts.temperature;
    if (opts.topP !== undefined) body.top_p = opts.topP;
    if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
    if (opts.frequencyPenalty !== undefined) body.frequency_penalty = opts.frequencyPenalty;

    // 增量解析 SSE 流（边下载边解析，实时回传文本并支持即时中止）
    let content = '';
    let reasoning = '';
    const toolCalls = new Map<number, ToolCallResult>();
    /** 已通知过 onToolCallReady 的工具调用索引（避免同一调用重复预启动） */
    const readyNotified = new Set<number>();
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    let finishReason = '';
    let buffer = '';

    const parseLine = (line: string) => {
      line = line.trim();
      if (!line.startsWith('data:')) {
        return;
      }
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') {
        return;
      }
      let parsed: any;
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }
      const delta = parsed?.choices?.[0]?.delta;
      if (delta?.content) {
        content += delta.content;
        callbacks.onText?.(delta.content);
      }
      // DeepSeek 推理模型的思维链内容（reasoning_content）
      if (delta?.reasoning_content) {
        reasoning += delta.reasoning_content;
        callbacks.onReasoning?.(delta.reasoning_content);
      }
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const i = tc.index ?? 0;
          const cur = toolCalls.get(i) ?? { id: '', name: '', arguments: '' };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.arguments += tc.function.arguments;
          toolCalls.set(i, cur);
          // 流式执行流水线：参数 JSON 完整可解析（闭合）即视为该工具调用接收完成，提前通知预启动
          if (cur.id && cur.name && cur.arguments && !readyNotified.has(i)) {
            try {
              JSON.parse(cur.arguments);
              readyNotified.add(i);
              callbacks.onToolCallReady?.({ id: cur.id, name: cur.name, arguments: cur.arguments });
            } catch {
              // 参数尚未完整，继续等待后续分片
            }
          }
        }
      }
      if (parsed?.choices?.[0]?.finish_reason) {
        finishReason = parsed.choices[0].finish_reason;
      }
      if (parsed?.usage) {
        usage = {
          inputTokens: parsed.usage.prompt_tokens ?? 0,
          outputTokens: parsed.usage.completion_tokens ?? 0,
          totalTokens: parsed.usage.total_tokens ?? 0
        };
      }
    };

    const parseLines = () => {
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        parseLine(line);
      }
    };

    const onData = (chunk: string) => {
      buffer += chunk;
      parseLines();
    };

    let { status, raw, json } = await fetchJson(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
      timeout: this.timeout,
      proxy: this.proxy,
      signal: opts.signal,
      onData
    });

    // 部分服务商不支持 stream_options 字段，自动降级重试（重试同样走增量解析）
    if (status === 400 && String(json?.error?.message ?? raw ?? '').toLowerCase().includes('stream_options')) {
      delete body.stream_options;
      // 重置解析状态：第一次请求的错误响应已进入 buffer，避免污染重试流
      buffer = '';
      content = '';
      reasoning = '';
      toolCalls.clear();
      readyNotified.clear();
      usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      finishReason = '';
      const retry = await fetchJson(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
        timeout: this.timeout,
        proxy: this.proxy,
        signal: opts.signal,
        onData
      });
      status = retry.status;
      raw = retry.raw;
      json = retry.json;
    }

    if (status === 0) {
      // fetchJson 只在网络层失败时 reject，这里兜底
      throw new Error('网络请求失败');
    }
    if (status !== 200) {
      const msg = json?.error?.message ?? json?.message ?? raw?.slice(0, 500) ?? `HTTP ${status}`;
      throw new Error(`模型接口错误 (${status}): ${msg}`);
    }

    // 处理残留缓冲（含无换行的尾行，防非标服务流末无 \n 导致最后事件丢失）
    parseLines();
    const rest = buffer;
    buffer = '';
    parseLine(rest);

    callbacks.onDone?.({
      content,
      reasoning,
      toolCalls: [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v),
      usage,
      finishReason
    });
  }

  async chat(opts: ChatRequestOptions): Promise<{ content: string; usage: TokenUsage }> {
    const body: Record<string, unknown> = {
      model: opts.model,
      messages: opts.messages,
      stream: false
    };
    if (opts.temperature !== undefined) body.temperature = opts.temperature;
    if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;

    const { status, json, raw } = await fetchJson(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
      timeout: this.timeout,
      proxy: this.proxy,
      signal: opts.signal
    });

    if (status !== 200) {
      const msg = json?.error?.message ?? json?.message ?? raw?.slice(0, 500) ?? `HTTP ${status}`;
      throw new Error(`模型接口错误 (${status}): ${msg}`);
    }
    const content: string = json?.choices?.[0]?.message?.content ?? '';
    const u = json?.usage ?? {};
    return {
      content,
      usage: {
        inputTokens: u.prompt_tokens ?? 0,
        outputTokens: u.completion_tokens ?? 0,
        totalTokens: u.total_tokens ?? 0
      }
    };
  }

  async queryBalance(): Promise<string> {
    // DeepSeek 官方余额接口；其他服务商失败时返回友好错误
    const { status, json } = await fetchJson(`${this.baseUrl}/user/balance`, {
      headers: this.buildHeaders(),
      timeout: 30000,
      proxy: this.proxy
    });
    if (status !== 200) {
      throw new Error(`余额查询失败 (HTTP ${status})，当前服务商可能不支持余额接口`);
    }
    const infos = json?.balance_infos;
    if (Array.isArray(infos) && infos.length > 0) {
      return infos
        .map((b: any) => {
          const currency = typeof b?.currency === 'string' && b.currency !== '' ? b.currency : 'CNY';
          const total = toMoney(b?.total_balance);
          // 全量映射官方字段：总余额 / 充值余额 / 赠金余额（与官方控制台口径一致）
          const topped = toMoney(b?.topped_up_balance);
          const granted = toMoney(b?.granted_balance);
          const parts: string[] = [`余额 ${total.toFixed(2)} ${currency}`];
          const detail: string[] = [];
          if (topped > 0) {
            detail.push(`充值 ${topped.toFixed(2)}`);
          }
          if (granted > 0) {
            detail.push(`赠金 ${granted.toFixed(2)}`);
          }
          if (detail.length > 0) {
            parts.push(`（${detail.join(' / ')}）`);
          }
          // 接口仅返回余额快照，无法推导累计消费（赠金优先扣费场景下余额差值恒为 0），
          // 「已用金额」由服务层按本地 Token 用量 × 单价累计后拼接，此处仅返回余额
          return parts.join(' ');
        })
        .join('；');
    }
    if (json?.balance !== undefined) {
      return `余额: ${json.balance}`;
    }
    return JSON.stringify(json).slice(0, 200);
  }
}

/** 金额字段解析：接口以字符串返回金额（如 "110.00"），非法值兜底 0 */
function toMoney(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

/** 适配器工厂：根据模型服务注册适配器（注册制，可无侵入扩展） */
export class AdapterRegistry {
  private readonly registry = new Map<string, (ctx: AdapterContext) => ModelAdapter>();

  constructor() {
    this.register('openai-compatible', ctx => new OpenAICompatibleAdapter(ctx.baseUrl, ctx.apiKey, ctx.proxy, ctx.timeout));
  }

  register(name: string, factory: (ctx: AdapterContext) => ModelAdapter): void {
    this.registry.set(name, factory);
  }

  create(ctx: AdapterContext): ModelAdapter {
    const factory = this.registry.get('openai-compatible');
    if (!factory) {
      throw new Error('模型适配器注册表异常');
    }
    return factory(ctx);
  }
}

export interface AdapterContext {
  baseUrl: string;
  apiKey: string;
  proxy?: string;
  timeout?: number;
}
