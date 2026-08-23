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

/** 模型元数据全局默认兑底（V1.1.0）：总上下文窗口 300k / 单轮最大输出 100k */
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

  // ---------- 基础配置读取 ----------

  getBaseUrl(): string {
    const v = this.config.get<string>('baseUrl', 'https://api.deepseek.com');
    return v.trim().replace(/\/+$/, '') || 'https://api.deepseek.com';
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

  /** 仅持久化非预置服务商（预置 DeepSeek 由默认值兜底保持存在） */
  private async saveProviders(list: ProviderInfo[]): Promise<void> {
    const plain = list.map(p => ({ id: p.id, name: p.name, baseUrl: p.baseUrl, preset: !!p.preset }));
    await this.config.update('providers', plain, vscode.ConfigurationTarget.Global);
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
        providerId: m.providerId ?? PRESET_PROVIDER_ID
      }));
  }

  async getModelsAsync(): Promise<ModelMeta[]> {
    return this.getModels();
  }

  async setModels(models: ModelMeta[]): Promise<void> {
    await this.config.update('models', models, vscode.ConfigurationTarget.Global);
  }

  /**
   * 服务商模型同步落缓存（V1.1.0）：拉取结果整体替换该服务商的模型；
   * 用户校准过的元数据（按模型 id 命中缓存）保留，新增模型套用全局默认元数据
   */
  async replaceProviderModels(providerId: string, fetched: ModelMeta[]): Promise<void> {
    const cached = this.getModels().filter(m => m.providerId === providerId);
    const merged = fetched.map(f => {
      const prev = cached.find(c => c.id === f.id);
      return prev
        ? { ...f, name: prev.name, contextWindow: prev.contextWindow, maxOutputTokens: prev.maxOutputTokens, pricing: prev.pricing }
        : f;
    });
    const others = this.getModels().filter(m => m.providerId !== providerId);
    await this.setModels([...others, ...merged]);
  }

  /** 删除服务商时清理其模型缓存 */
  async removeProviderModels(providerId: string): Promise<void> {
    await this.setModels(this.getModels().filter(m => m.providerId !== providerId));
  }

  getDefaultModel(models?: ModelMeta[]): string {
    const list = models ?? this.getModels();
    const def = this.getRawDefaultModel();
    return list.some(m => m.id === def) ? def : (list[0]?.id ?? 'deepseek-chat');
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
        await this.config.update(cfgKey, v, vscode.ConfigurationTarget.Global);
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
