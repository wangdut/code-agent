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
  /** 429 限流退避等待开始（waitSec 为等待秒数，attempt 为第几次重试，从 1 起）：供上层向用户提示，避免静默等待误判为卡死 */
  onRateLimited?: (waitSec: number, attempt: number) => void;
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
  /** 拉取服务商模型列表（OpenAI 兼容 /models 接口，部分服务商可能不支持） */
  listModels?(): Promise<Array<{ id: string; contextWindow?: number; maxOutputTokens?: number }>>;
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
 * 服务商参数兼容记忆（模块级，扩展宿主进程生命周期内有效，厂商无关）：
 * 记录某 Base URL 曾被 400 拒绝的请求字段（stream_options / temperature / top_p / frequency_penalty / tool_choice），
 * 后续请求主动省略，避免「每次请求都试错」。严格 RPM 限额下（如月之暗面免费额度 org max RPM 3）
 * 试错重试会使单次对话消耗双倍配额、立即触发 429；按 Base URL 记忆可让同服务商下所有模型一次学习、全程受益
 */
const paramCompatMemory = new Map<string, Set<string>>();

function rememberIncompat(baseUrl: string, keys: string[]): void {
  if (keys.length === 0) {
    return;
  }
  let set = paramCompatMemory.get(baseUrl);
  if (!set) {
    set = new Set();
    paramCompatMemory.set(baseUrl, set);
  }
  for (const k of keys) {
    set.add(k);
  }
}

/**
 * 将 400 错误报文映射为请求体中不被支持的字段（厂商无关的关键词匹配，覆盖主流 OpenAI 兼容服务）
 * 零负优化约定：仅在服务商明确以 400 拒绝某字段时才记忆省略；无限额/全兼容服务商（如 DeepSeek）
 * 不会触发任何记忆与重试，请求体与历史版本逐字节一致；记忆按 Base URL 隔离，服务商间互不影响
 */
function incompatibleKeys(errMsg: string, body: Record<string, unknown>): string[] {
  const lower = errMsg.toLowerCase();
  const keys: string[] = [];
  if (body.stream_options !== undefined && lower.includes('stream_options')) keys.push('stream_options');
  if (body.temperature !== undefined && lower.includes('temperature')) keys.push('temperature');
  // top_p 兼容 top_p / topp 两种报错拼写；词边界匹配防止 stopped 等单词子串误伤
  if (body.top_p !== undefined && (lower.includes('top_p') || /\btopp\b/.test(lower))) keys.push('top_p');
  if (body.frequency_penalty !== undefined && lower.includes('frequency_penalty')) keys.push('frequency_penalty');
  if (body.tool_choice !== undefined && lower.includes('tool_choice')) keys.push('tool_choice');
  return keys;
}

/** 解析 429 限流报文中的重试等待秒数（如 "try again after 1 seconds"）；无法解析默认 2s，上下限 1–10s */
function rateLimitWaitSeconds(errMsg: string): number {
  const m = /after\s+(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s\b)/i.exec(errMsg) ?? /retry[ -]?after[^\d]{0,4}(\d+(?:\.\d+)?)/i.exec(errMsg);
  const v = m ? Number(m[1]) : NaN;
  if (!Number.isFinite(v) || v <= 0) {
    return 2;
  }
  return Math.min(Math.max(v, 1), 10);
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

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
    // 主动省略该 Base URL 已记忆的不兼容字段（兼容记忆），避免逐请求试错浪费配额
    const learnedDrop = paramCompatMemory.get(this.baseUrl);
    if (learnedDrop) {
      for (const k of learnedDrop) {
        delete body[k];
      }
    }

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

    const doFetch = () =>
      fetchJson(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
        timeout: this.timeout,
        proxy: this.proxy,
        signal: opts.signal,
        onData
      });

    /** 重置增量解析状态：上一次请求的错误响应已进入 buffer，避免污染重试流 */
    const resetStreamState = () => {
      buffer = '';
      content = '';
      reasoning = '';
      toolCalls.clear();
      readyNotified.clear();
      usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      finishReason = '';
    };

    let { status, raw, json } = await doFetch();

    // 参数兼容降级（厂商无关）：400 时将错误报文映射为不支持字段，记入兼容记忆并省略后重试一次；
    // 后续请求按记忆主动省略，进程生命周期内仅本次试错（如 Kimi K2 限定 temperature、部分服务不支持 stream_options）
    const badKeys = incompatibleKeys(String(json?.error?.message ?? raw ?? ''), body);
    if (status === 400 && badKeys.length > 0) {
      rememberIncompat(this.baseUrl, badKeys);
      for (const k of badKeys) {
        delete body[k];
      }
      resetStreamState();
      ({ status, raw, json } = await doFetch());
    }

    // 429 限流退避重试：部分服务商对组织/免费额度有严格 RPM 限制（如月之暗面 org max RPM 3），
    // 按错误提示秒数等待后自动重试（至多 2 次），避免瞬时限流直接报错打断对话
    for (let attempt = 0; status === 429 && attempt < 2; attempt++) {
      const waitSec = rateLimitWaitSeconds(String(json?.error?.message ?? raw ?? ''));
      callbacks.onRateLimited?.(waitSec, attempt + 1);
      await sleep(Math.round(waitSec * 1000));
      if (opts.signal?.aborted) {
        throw new Error('aborted');
      }
      resetStreamState();
      ({ status, raw, json } = await doFetch());
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
    const learnedDrop = paramCompatMemory.get(this.baseUrl);
    if (learnedDrop) {
      for (const k of learnedDrop) {
        delete body[k];
      }
    }

    const doFetch = () =>
      fetchJson(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
        timeout: this.timeout,
        proxy: this.proxy,
        signal: opts.signal
      });

    let { status, json, raw } = await doFetch();

    // 参数兼容降级：400 映射不支持字段 → 记入兼容记忆 + 省略重试一次（与流式链路共享记忆）
    const badKeys = incompatibleKeys(String(json?.error?.message ?? raw ?? ''), body);
    if (status === 400 && badKeys.length > 0) {
      rememberIncompat(this.baseUrl, badKeys);
      for (const k of badKeys) {
        delete body[k];
      }
      ({ status, json, raw } = await doFetch());
    }

    // 429 限流退避重试（至多 2 次），与流式链路同一策略
    for (let attempt = 0; status === 429 && attempt < 2; attempt++) {
      await sleep(Math.round(rateLimitWaitSeconds(String(json?.error?.message ?? raw ?? '')) * 1000));
      if (opts.signal?.aborted) {
        throw new Error('aborted');
      }
      ({ status, json, raw } = await doFetch());
    }

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

  /**
   * 拉取服务商可用模型列表（V1.1.0 动态模型接入）
   * 兼容主流响应格式：OpenAI 标准 { data: [{ id }] } 与 Ollama 风格 { models: [{ name }] }；
   * 附带解析常见元数据字段（context_length / max_output_tokens 等），缺省由上层套用全局默认
   */
  async listModels(): Promise<Array<{ id: string; contextWindow?: number; maxOutputTokens?: number }>> {
    // API Key 未配置时不携带 Authorization（部分服务商允许匿名查看模型列表）
    const headers = this.apiKey ? this.buildHeaders() : { Accept: 'application/json' };
    const { status, json, raw } = await fetchJson(`${this.baseUrl}/models`, {
      headers,
      timeout: 30000,
      proxy: this.proxy
    });
    if (status === 0) {
      throw new Error('网络请求失败');
    }
    if (status !== 200) {
      const msg = json?.error?.message ?? json?.message ?? raw?.slice(0, 300) ?? `HTTP ${status}`;
      throw new Error(`模型列表拉取失败 (${status}): ${msg}`);
    }
    const items = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : null;
    if (!items) {
      throw new Error('模型列表拉取失败：接口响应格式不支持（缺少 data / models 字段）');
    }
    const out: Array<{ id: string; contextWindow?: number; maxOutputTokens?: number }> = [];
    for (const it of items) {
      const id = typeof it?.id === 'string' && it.id ? it.id : typeof it?.name === 'string' && it.name ? it.name : '';
      if (!id) {
        continue;
      }
      const entry: { id: string; contextWindow?: number; maxOutputTokens?: number } = { id };
      const cw = it?.context_length ?? it?.contextWindow ?? it?.max_input_tokens;
      const mo = it?.max_output_tokens ?? it?.maxOutputTokens;
      if (typeof cw === 'number' && cw > 0) {
        entry.contextWindow = cw;
      }
      if (typeof mo === 'number' && mo > 0) {
        entry.maxOutputTokens = mo;
      }
      out.push(entry);
    }
    if (out.length === 0) {
      throw new Error('模型列表拉取失败：服务商返回的模型列表为空');
    }
    return out;
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
