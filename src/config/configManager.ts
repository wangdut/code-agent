/**
 * 配置管理模块
 * 职责：配置读写、校验、持久化；API Key 使用 VSCode SecretStorage 加密存储
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { ModelMeta, ProviderInfo, RunMode, SettingsSnapshot } from '../types';

const CONFIG_SECTION = 'codeAgent';
/** 旧版全局 API Key 存储键（保留：作为预置 DeepSeek 服务商的密钥回退，平滑升级存量用户） */
const API_KEY_SECRET = 'codeAgent.apiKey';

/** 预置服务商 id（DeepSeek，开箱即用） */
export const PRESET_PROVIDER_ID = 'deepseek';

/** 模型元数据全局默认兜底（V1.1.0）：总上下文窗口 300k / 单轮最大输出 100k */
export const DEFAULT_CONTEXT_WINDOW = 300000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 100000;

/** 预置 DeepSeek 服务商（官方 Base URL，用户仅需填写 API Key 即可使用） */
export const DEFAULT_PROVIDER: ProviderInfo = {
  id: PRESET_PROVIDER_ID,
  name: 'DeepSeek',
  baseUrl: 'https://api.deepseek.com',
  hasApiKey: false,
  preset: true
};

/**
 * 预置厂商目录（V1.2.0）：国内外主流 OpenAI 兼容厂商官方配置 + 官方标准模型列表兜底数据。
 * 用途：新增服务商弹窗下拉快捷选择；无密钥/拉取失败时以兜底模型列表完成创建，配置密钥后动态拉取自动覆盖。
 * 兜底数据随版本迭代更新；不含任何密钥等敏感信息。
 */
export interface PresetProviderCatalogItem {
  id: string;
  name: string;
  baseUrl: string;
  /** 兼容性备注（非 OpenAI 兼容协议等需用户知悉的限制） */
  note?: string;
  /** 兜底模型列表（multimodal 按官方能力准确标记，缺省视为不支持多模态） */
  fallbackModels: Array<{ id: string; name: string; contextWindow: number; maxOutputTokens: number; multimodal?: boolean }>;
}

export const PRESET_PROVIDER_CATALOG: PresetProviderCatalogItem[] = [
  {
    id: PRESET_PROVIDER_ID,
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    fallbackModels: [
      { id: 'deepseek-chat', name: 'DeepSeek Chat（通用对话）', contextWindow: 65536, maxOutputTokens: 8192 },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner（深度推理）', contextWindow: 65536, maxOutputTokens: 8192 },
      { id: 'deepseek-v4-flash-vision-exp', name: 'DeepSeek V4 Flash Vision Exp（视觉）', contextWindow: 1000000, maxOutputTokens: 8192, multimodal: true }
    ]
  },
  {
    id: 'zhipu',
    name: '智谱 AI',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    fallbackModels: [
      { id: 'glm-4-flash', name: 'GLM-4 Flash（轻量高速）', contextWindow: 128000, maxOutputTokens: 4096 },
      { id: 'glm-4-air', name: 'GLM-4 Air（均衡）', contextWindow: 128000, maxOutputTokens: 4096 },
      { id: 'glm-4-plus', name: 'GLM-4 Plus（旗舰）', contextWindow: 128000, maxOutputTokens: 4096 },
      { id: 'glm-4v-flash', name: 'GLM-4V Flash（视觉）', contextWindow: 128000, maxOutputTokens: 4096, multimodal: true }
    ]
  },
  {
    id: 'moonshot',
    name: '月之暗面 Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    fallbackModels: [
      { id: 'kimi-k3', name: 'Kimi K3（旗舰·原生多模态）', contextWindow: 1000000, maxOutputTokens: 8192, multimodal: true },
      { id: 'moonshot-v1-8k-vision-preview', name: 'Moonshot v1 8K Vision（视觉）', contextWindow: 8192, maxOutputTokens: 8192, multimodal: true },
      { id: 'moonshot-v1-8k', name: 'Moonshot v1 8K', contextWindow: 8192, maxOutputTokens: 8192 },
      { id: 'moonshot-v1-32k', name: 'Moonshot v1 32K', contextWindow: 32768, maxOutputTokens: 8192 },
      { id: 'moonshot-v1-128k', name: 'Moonshot v1 128K（长上下文）', contextWindow: 131072, maxOutputTokens: 8192 }
    ]
  },
  {
    id: 'qwen',
    name: '通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    fallbackModels: [
      { id: 'qwen-turbo', name: 'Qwen Turbo（高速）', contextWindow: 131072, maxOutputTokens: 8192 },
      { id: 'qwen-plus', name: 'Qwen Plus（均衡）', contextWindow: 131072, maxOutputTokens: 8192 },
      { id: 'qwen-max', name: 'Qwen Max（旗舰）', contextWindow: 32768, maxOutputTokens: 8192 },
      { id: 'qwen-vl-max', name: 'Qwen VL Max（视觉）', contextWindow: 32768, maxOutputTokens: 8192, multimodal: true }
    ]
  },
  {
    id: 'doubao',
    name: '字节跳动豆包（火山方舟）',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    fallbackModels: [
      { id: 'doubao-lite-32k', name: '豆包 Lite 32K', contextWindow: 32768, maxOutputTokens: 4096 },
      { id: 'doubao-pro-32k', name: '豆包 Pro 32K', contextWindow: 32768, maxOutputTokens: 4096 },
      { id: 'doubao-vision-pro-32k', name: '豆包 Vision Pro 32K（视觉）', contextWindow: 32768, maxOutputTokens: 4096, multimodal: true }
    ]
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    fallbackModels: [
      { id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128000, maxOutputTokens: 16384, multimodal: true },
      { id: 'gpt-4o-mini', name: 'GPT-4o mini', contextWindow: 128000, maxOutputTokens: 16384, multimodal: true },
      { id: 'o3-mini', name: 'OpenAI o3-mini（推理）', contextWindow: 200000, maxOutputTokens: 100000 }
    ]
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    note: '官方原生接口为 Anthropic 自有协议（非 OpenAI 兼容），直接以官方地址接入可能无法调用；如需接入请将 Base URL 改为 OpenAI 兼容网关地址',
    fallbackModels: [
      { id: 'claude-3-5-sonnet-latest', name: 'Claude 3.5 Sonnet', contextWindow: 200000, maxOutputTokens: 8192, multimodal: true },
      { id: 'claude-3-opus-latest', name: 'Claude 3 Opus', contextWindow: 200000, maxOutputTokens: 4096, multimodal: true }
    ]
  }
];

/** 服务商级同步状态（非持久化：内存态，重启后重新拉取刷新） */
interface ProviderSyncState {
  lastSyncAt?: number;
  syncError?: string;
}

export class ConfigManager {
  private readonly secret: vscode.SecretStorage;

  constructor(secret: vscode.SecretStorage) {
    this.secret = secret;
  }

  private get config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration(CONFIG_SECTION);
  }

  // ---------- API Key（加密存储） ----------

  async getApiKey(): Promise<string> {
    return (await this.secret.get(API_KEY_SECRET)) ?? '';
  }

  async setApiKey(key: string): Promise<void> {
    if (key.trim()) {
      await this.secret.store(API_KEY_SECRET, key.trim());
    } else {
      await this.deleteApiKey();
    }
  }

  async deleteApiKey(): Promise<void> {
    await this.secret.delete(API_KEY_SECRET);
  }

  /** 服务商 API Key 存储键（按服务商独立加密存储） */
  private providerKeySecret(providerId: string): string {
    return `codeAgent.providerKey.${providerId}`;
  }

  /**
   * 读取服务商 API Key：优先服务商独立密钥；
   * 预置 DeepSeek 回退旧版全局密钥（存量用户升级后无需重新输入）
   */
  async getProviderApiKey(providerId: string): Promise<string> {
    const v = await this.secret.get(this.providerKeySecret(providerId));
    if (v) {
      return v;
    }
    if (providerId === PRESET_PROVIDER_ID) {
      return (await this.secret.get(API_KEY_SECRET)) ?? '';
    }
    return '';
  }

  async setProviderApiKey(providerId: string, key: string): Promise<void> {
    if (key.trim()) {
      await this.secret.store(this.providerKeySecret(providerId), key.trim());
    } else {
      await this.deleteProviderApiKey(providerId);
    }
  }

  async deleteProviderApiKey(providerId: string): Promise<void> {
    await this.secret.delete(this.providerKeySecret(providerId));
  }
  
  /**
   * 彻底清除服务商密钥（V1.2.0 缺陷修复）：
   * 除服务商独立密钥外，预置 DeepSeek 需同步删除旧版全局密钥回退源，
   * 否则清除后仍会经 getProviderApiKey 回退链路命中旧密钥，导致清除操作失效
   */
  async clearProviderApiKey(providerId: string): Promise<void> {
    await this.secret.delete(this.providerKeySecret(providerId));
    if (providerId === PRESET_PROVIDER_ID) {
      await this.secret.delete(API_KEY_SECRET);
    }
  }

  // ---------- 基础配置读取 ----------
  
  getBaseUrl(): string {
    const v = this.config.get<string>('baseUrl', 'https://api.deepseek.com');
    return v.trim().replace(/\/+$/, '') || 'https://api.deepseek.com';
  }
  
  /**
   * 作用域对齐写入（V1.2.0 缺陷修复）：
   * 若工作区文件夹/工作区层已定义该配置项，必须写入同一作用域——
   * 否则读取时被工作区值遮蔽，新增服务商/修改配置写 Global 后读不到（表现为「服务商不存在」）。
   * WorkspaceFolder 目标必须以文件夹作用域的配置对象写入（无作用域配置直接写该目标会抛异常），
   * 因此逐个文件夹探测已定义该配置项的层级后定向写入
   */
  private async writeAligned(key: string, value: unknown): Promise<void> {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const scoped = vscode.workspace.getConfiguration(CONFIG_SECTION, folder.uri);
      const info = scoped.inspect(key);
      if (info && info.workspaceFolderValue !== undefined) {
        await scoped.update(key, value, vscode.ConfigurationTarget.WorkspaceFolder);
        return;
      }
    }
    const info = this.config.inspect(key);
    if (info && info.workspaceValue !== undefined) {
      await this.config.update(key, value, vscode.ConfigurationTarget.Workspace);
      return;
    }
    await this.config.update(key, value, vscode.ConfigurationTarget.Global);
  }

  /** 按作用域对齐原则写入单个配置项（读写同层，杜绝遮蔽导致的配置丢失） */
  async updateSetting(key: string, value: unknown): Promise<void> {
    await this.writeAligned(key, value);
  }

  // ---------- 模型服务商（V1.1.0 服务商-模型两级体系） ----------

  /** 读取服务商列表：配置异常或缺预置服务商时自动兜底补回 DeepSeek */
  getProviders(): ProviderInfo[] {
    const raw = this.config.get<Array<Partial<ProviderInfo>>>('providers', [DEFAULT_PROVIDER]);
    const list = Array.isArray(raw) ? raw : [];
    const out: ProviderInfo[] = [];
    for (const p of list) {
      if (!p || typeof p !== 'object' || !p.id) {
        continue;
      }
      out.push({
        id: String(p.id),
        name: String(p.name || p.id),
        baseUrl: this.normalizeBaseUrl(p.baseUrl),
        hasApiKey: false,
        preset: p.id === PRESET_PROVIDER_ID ? true : !!p.preset
      });
    }
    if (!out.some(p => p.id === PRESET_PROVIDER_ID)) {
      out.unshift({ ...DEFAULT_PROVIDER });
    }
    return out;
  }

  getProvider(providerId: string): ProviderInfo | undefined {
    return this.getProviders().find(p => p.id === providerId);
  }

  /** 按模型定位所属服务商：未命中时回退预置 DeepSeek（保证存量缓存模型可用） */
  getProviderForModel(modelId?: string): ProviderInfo {
    const providers = this.getProviders();
    if (modelId) {
      const model = this.getModel(modelId);
      if (model?.providerId) {
        const hit = providers.find(p => p.id === model.providerId);
        if (hit) {
          return hit;
        }
      }
    }
    return providers.find(p => p.preset) ?? providers[0];
  }

  private normalizeBaseUrl(url: string | undefined): string {
    const v = String(url ?? '').trim().replace(/\/+$/, '');
    return /^https?:\/\//i.test(v) ? v : 'https://api.deepseek.com';
  }

  async addProvider(info: { id: string; name: string; baseUrl: string }): Promise<void> {
    const list = this.getProviders().filter(p => !p.preset);
    list.push({ id: info.id, name: info.name, baseUrl: info.baseUrl, hasApiKey: false });
    await this.saveProviders(list);
  }
  
  async updateProvider(id: string, patch: { name: string; baseUrl: string }): Promise<void> {
    const list = this.getProviders().map(p => (p.id === id ? { ...p, name: patch.name, baseUrl: patch.baseUrl } : p));
    await this.saveProviders(list);
  }
  
  async deleteProvider(id: string): Promise<void> {
    const list = this.getProviders().filter(p => p.id !== id);
    await this.saveProviders(list);
  }
  
  /** 仅持久化非预置服务商（预置 DeepSeek 由默认值兜底保持存在），写入作用域与读取对齐 */
  private async saveProviders(list: ProviderInfo[]): Promise<void> {
    const plain = list.map(p => ({ id: p.id, name: p.name, baseUrl: p.baseUrl, preset: !!p.preset }));
    await this.writeAligned('providers', plain);
  }

  /**
   * 读取模型缓存（含动态拉取与用户校准后的元数据）
   * 未持久化的缓存为空数组（V1.1.0 起取消硬编码模型列表，由 /models 接口拉取填充）
   */
  getModels(): ModelMeta[] {
    const raw = this.config.get<ModelMeta[]>('models', []);
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw
      .filter(m => m && typeof m === 'object' && m.id)
      .map(m => ({
        id: m.id,
        name: m.name || m.id,
        contextWindow: typeof m.contextWindow === 'number' && m.contextWindow > 0 ? m.contextWindow : DEFAULT_CONTEXT_WINDOW,
        maxOutputTokens: typeof m.maxOutputTokens === 'number' && m.maxOutputTokens > 0 ? m.maxOutputTokens : DEFAULT_MAX_OUTPUT_TOKENS,
        pricing: m.pricing || '按量计费',
        // 多模态标识透传（V1.4.0 缺陷修复）：预置标记/拉取探测/手动校准的布尔值原样保留，
        // 显式 false 视为用户校准（重拉取时优先保留），缺省/非法值视为不支持；遗漏该字段会导致校验层恒判「不支持图片输入」
        multimodal: typeof m.multimodal === 'boolean' ? m.multimodal : undefined,
        providerId: m.providerId ?? PRESET_PROVIDER_ID
      }));
  }

  async getModelsAsync(): Promise<ModelMeta[]> {
    return this.getModels();
  }

  async setModels(models: ModelMeta[]): Promise<void> {
    await this.writeAligned('models', models);
  }

  /**
   * 服务商模型同步落缓存（V1.1.0）：拉取结果整体替换该服务商的模型；
   * 用户校准过的元数据（按模型 id 命中缓存）保留，新增模型套用全局默认元数据
   */
  async replaceProviderModels(providerId: string, fetched: ModelMeta[]): Promise<void> {
    const cached = this.getModels().filter(m => m.providerId === providerId);
    const merged = fetched.map(f => {
      const prev = cached.find(c => c.id === f.id);
      // multimodal：用户手动校准过的值（prev 非缺省）优先保留，否则采用本次拉取的能力信息
      return prev
        ? { ...f, name: prev.name, contextWindow: prev.contextWindow, maxOutputTokens: prev.maxOutputTokens, pricing: prev.pricing, multimodal: prev.multimodal ?? f.multimodal }
        : f;
    });
    const others = this.getModels().filter(m => m.providerId !== providerId);
    await this.setModels([...others, ...merged]);
  }

  /** 删除服务商时清理其模型缓存 */
  async removeProviderModels(providerId: string): Promise<void> {
    await this.setModels(this.getModels().filter(m => m.providerId !== providerId));
  }
  
  /**
   * 预置厂商兜底模型列表（V1.2.0）：无密钥/拉取失败时以官方标准模型列表完成服务商创建，
   * 配置密钥后动态拉取结果自动覆盖兜底数据（动态拉取优先级高于兜底）
   */
  getProviderFallbackModels(providerId: string): ModelMeta[] {
    const preset = PRESET_PROVIDER_CATALOG.find(p => p.id === providerId);
    if (!preset || preset.fallbackModels.length === 0) {
      return [];
    }
    return preset.fallbackModels.map(m => ({
      id: m.id,
      name: m.name,
      contextWindow: m.contextWindow,
      maxOutputTokens: m.maxOutputTokens,
      pricing: '按量计费',
      multimodal: m.multimodal,
      providerId
    }));
  }

  getDefaultModel(models?: ModelMeta[]): string {
    const list = models ?? this.getModels();
    const def = this.getRawDefaultModel();
    return list.some(m => m.id === def) ? def : (list[0]?.id ?? 'deepseek-chat');
  }
  
  /**
   * 当前生效的默认服务商（V1.2.0）：主界面模型下拉框与设置页默认模型的联动基准；
   * 配置值指向不存在的服务商时回退预置 DeepSeek
   */
  getDefaultProvider(): string {
    const v = this.config.get<string>('defaultProvider', PRESET_PROVIDER_ID);
    return this.getProvider(v) ? v : PRESET_PROVIDER_ID;
  }

  /** 读取原始 defaultModel 配置值（不回退，用于更新/删除模型时判断是否跟随） */
  getRawDefaultModel(): string {
    return this.config.get<string>('defaultModel', 'deepseek-chat');
  }

  getModel(id: string): ModelMeta | undefined {
    return this.getModels().find(m => m.id === id);
  }

  getDefaultMode(): RunMode {
    const v = this.config.get<string>('defaultMode', 'agent');
    return v === 'chat' ? 'chat' : 'agent';
  }

  getRequestTimeout(): number {
    return this.config.get<number>('requestTimeout', 120000);
  }

  getProxy(): string {
    return this.config.get<string>('proxy', '').trim();
  }

  // ---------- 推理参数 ----------

  getInferenceParams() {
    return {
      temperature: this.config.get<number>('temperature', 0.7),
      topP: this.config.get<number>('topP', 0.95),
      maxTokens: this.config.get<number>('maxTokens', 100000),
      frequencyPenalty: this.config.get<number>('frequencyPenalty', 0)
    };
  }

  // ---------- 安全权限 ----------

  /**
   * 权限管理（第二层，仅智能体模式下生效）：ask 询问 / auto 全自动
   * 仅控制智能体模式下工作区内文件写入的确认机制；对话模式下不生效、无作用
   */
  getPermissionMode(): 'ask' | 'auto' {
    return this.config.get<string>('permissionMode', 'ask') === 'auto' ? 'auto' : 'ask';
  }

  getTerminalAutoApprove(): boolean {
    return !!this.config.get<boolean>('terminalAutoApprove', false);
  }

  getHighRiskCommandsEnabled(): boolean {
    return !!this.config.get<boolean>('highRiskCommands', true);
  }

  // ---------- 上下文 ----------

  getAutoCompressThreshold(): number {
    return this.config.get<number>('autoCompressThreshold', 0.75);
  }

  /** 最大工具调用轮次：正整数 1-1000，非法值回退默认 128（V1.1.0 适配长链路任务） */
  getMaxToolIterations(): number {
    const v = this.config.get<number>('maxToolIterations', 128);
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return 128;
    }
    return Math.min(1000, Math.max(1, Math.round(v)));
  }

  /** 联网搜索全局开关（V1.5.0）：默认启用；关闭后 Agent 调度层完全屏蔽搜索工具，即时生效无需重启 */
  getWebSearchEnabled(): boolean {
    return !!this.config.get<boolean>('webSearchEnabled', true);
  }

  // ---------- 存储 ----------

  /** 会话存储根目录：自定义绝对路径 或 工作区 .code-agent/history */
  getHistoryRoot(): string {
    const custom = this.config.get<string>('historyPath', '').trim();
    if (custom && path.isAbsolute(custom)) {
      return custom;
    }
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) {
      // 无工作区时回退到全局存储目录
      const base = vscode.workspace.workspaceFile ? path.dirname(vscode.workspace.workspaceFile.fsPath) : os.homedir();
      return path.join(base, '.code-agent', 'history');
    }
    return path.join(ws.uri.fsPath, '.code-agent', 'history');
  }

  getFolderIncludePatterns(): string[] {
    const v = this.config.get<string[]>('folderIncludePatterns', []);
    return Array.isArray(v) && v.length > 0 ? v : ['**/*.{ts,tsx,js,jsx,json,md,py,java,go,rs,c,cpp,h,hpp,cs,html,css,scss,vue,yml,yaml,sh,bat,ps1,sql}'];
  }

  // ---------- 高级 ----------

  getLogLevel(): 'debug' | 'info' | 'warn' | 'error' {
    const v = this.config.get<string>('logLevel', 'info');
    return v === 'debug' || v === 'warn' || v === 'error' ? v : 'info';
  }

  getDebugMode(): boolean {
    return !!this.config.get<boolean>('debugMode', false);
  }

  getAutoUpdateCheck(): boolean {
    return !!this.config.get<boolean>('autoUpdateCheck', true);
  }

  // ---------- 服务商同步状态（内存态） ----------

  private readonly syncState = new Map<string, ProviderSyncState>();

  setProviderSyncState(providerId: string, state: ProviderSyncState): void {
    this.syncState.set(providerId, state);
  }

  getProviderSyncState(providerId: string): ProviderSyncState {
    return this.syncState.get(providerId) ?? {};
  }

  // ---------- 快照 ----------

  async getSettingsSnapshot(): Promise<SettingsSnapshot> {
    const providers = this.getProviders();
    // 服务商密钥状态按需读取（SecretStorage 异步），同步时间/错误从内存态补充
    const keyStates = await Promise.all(providers.map(p => this.getProviderApiKey(p.id)));
    const providerInfos: ProviderInfo[] = providers.map((p, i) => ({
      ...p,
      hasApiKey: keyStates[i].length > 0,
      ...this.getProviderSyncState(p.id)
    }));
    return {
      apiKeyConfigured: providerInfos.some(p => p.hasApiKey),
      providers: providerInfos,
      defaultProvider: this.getDefaultProvider(),
      presetProviders: PRESET_PROVIDER_CATALOG.map(p => ({
        id: p.id,
        name: p.name,
        baseUrl: p.baseUrl,
        hasFallbackModels: p.fallbackModels.length > 0,
        note: p.note
      })),
      models: this.getModels(),
      defaultModel: this.getDefaultModel(),
      defaultMode: this.getDefaultMode(),
      requestTimeout: this.getRequestTimeout(),
      proxy: this.getProxy(),
      ...this.getInferenceParams(),
      permissionMode: this.getPermissionMode(),
      terminalAutoApprove: this.getTerminalAutoApprove(),
      highRiskCommands: this.getHighRiskCommandsEnabled(),
      maxToolIterations: this.getMaxToolIterations(),
      webSearchEnabled: this.getWebSearchEnabled(),
      autoCompressThreshold: this.getAutoCompressThreshold(),
      historyPath: this.config.get<string>('historyPath', ''),
      effectiveHistoryPath: this.getHistoryRoot(),
      folderIncludePatterns: this.getFolderIncludePatterns(),
      logLevel: this.getLogLevel(),
      debugMode: this.getDebugMode(),
      autoUpdateCheck: !!this.config.get<boolean>('autoUpdateCheck', true)
    };
  }

  /** 批量更新设置（WebView 设置面板提交） */
  async updateSettings(patch: Partial<Record<string, unknown>>, apiKey?: string, clearApiKey?: boolean): Promise<void> {
    const keyMap: Record<string, string> = {
      baseUrl: 'baseUrl',
      models: 'models',
      defaultModel: 'defaultModel',
      defaultProvider: 'defaultProvider',
      defaultMode: 'defaultMode',
      requestTimeout: 'requestTimeout',
      proxy: 'proxy',
      temperature: 'temperature',
      topP: 'topP',
      maxTokens: 'maxTokens',
      frequencyPenalty: 'frequencyPenalty',
      permissionMode: 'permissionMode',
      terminalAutoApprove: 'terminalAutoApprove',
      highRiskCommands: 'highRiskCommands',
      maxToolIterations: 'maxToolIterations',
      webSearchEnabled: 'webSearchEnabled',
      autoCompressThreshold: 'autoCompressThreshold',
      historyPath: 'historyPath',
      folderIncludePatterns: 'folderIncludePatterns',
      logLevel: 'logLevel',
      debugMode: 'debugMode',
      autoUpdateCheck: 'autoUpdateCheck'
    };
    for (const [k, v] of Object.entries(patch)) {
      const cfgKey = keyMap[k];
      if (cfgKey && v !== undefined) {
        await this.updateSetting(cfgKey, v);
      }
    }
    if (apiKey !== undefined) {
      await this.setApiKey(apiKey);
    }
    if (clearApiKey) {
      await this.deleteApiKey();
    }
  }
}
