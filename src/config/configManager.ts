/**
 * 配置管理模块
 * 职责：配置读写、校验、持久化；API Key 使用 VSCode SecretStorage 加密存储
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { ModelMeta, RunMode, SettingsSnapshot } from '../types';

const CONFIG_SECTION = 'codeAgent';
const API_KEY_SECRET = 'codeAgent.apiKey';

/** 默认模型列表（DeepSeek 首批深度适配） */
export const DEFAULT_MODELS: ModelMeta[] = [
  {
    id: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    contextWindow: 131072,
    maxOutputTokens: 8192,
    pricing: '按量计费'
  },
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    contextWindow: 262144,
    maxOutputTokens: 32768,
    pricing: '按量计费'
  }
];

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

  // ---------- 基础配置读取 ----------

  getBaseUrl(): string {
    const v = this.config.get<string>('baseUrl', 'https://api.deepseek.com');
    return v.trim().replace(/\/+$/, '') || 'https://api.deepseek.com';
  }

  getModels(): ModelMeta[] {
    const raw = this.config.get<ModelMeta[]>('models', DEFAULT_MODELS);
    if (!Array.isArray(raw) || raw.length === 0) {
      return [...DEFAULT_MODELS];
    }
    return raw.map(m => ({
      id: m.id,
      name: m.name || m.id,
      contextWindow: m.contextWindow || 131072,
      maxOutputTokens: m.maxOutputTokens || 8192,
      pricing: m.pricing || '按量计费'
    }));
  }

  async getModelsAsync(): Promise<ModelMeta[]> {
    return this.getModels();
  }

  async setModels(models: ModelMeta[]): Promise<void> {
    await this.config.update('models', models, vscode.ConfigurationTarget.Global);
  }

  getDefaultModel(models?: ModelMeta[]): string {
    const list = models ?? this.getModels();
    const def = this.getRawDefaultModel();
    return list.some(m => m.id === def) ? def : (list[0]?.id ?? 'deepseek-v4-flash');
  }

  /** 读取原始 defaultModel 配置值（不回退，用于更新/删除模型时判断是否跟随） */
  getRawDefaultModel(): string {
    return this.config.get<string>('defaultModel', 'deepseek-v4-flash');
  }

  getModel(id: string): ModelMeta | undefined {
    return this.getModels().find(m => m.id === id) ?? DEFAULT_MODELS.find(m => m.id === id);
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
      maxTokens: this.config.get<number>('maxTokens', 8192),
      frequencyPenalty: this.config.get<number>('frequencyPenalty', 0)
    };
  }

  // ---------- 安全权限 ----------

  getPermissionMode(): 'ask' | 'auto' {
    return this.config.get<string>('permissionMode', 'ask') === 'auto' ? 'auto' : 'ask';
  }

  getFileWritePermission(): 'auto' | 'ask' {
    return this.config.get<string>('fileWritePermission', 'ask') === 'auto' ? 'auto' : 'ask';
  }

  getOutsideWorkspaceRead(): 'ask' | 'deny' {
    return this.config.get<string>('outsideWorkspaceRead', 'ask') === 'deny' ? 'deny' : 'ask';
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

  /** 最大工具调用轮次：正整数 1-1000，非法值回退默认 20 */
  getMaxToolIterations(): number {
    const v = this.config.get<number>('maxToolIterations', 20);
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return 20;
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

  // ---------- 快照 ----------

  async getSettingsSnapshot(): Promise<SettingsSnapshot> {
    const apiKey = await this.getApiKey();
    return {
      apiKeyConfigured: apiKey.length > 0,
      baseUrl: this.getBaseUrl(),
      models: this.getModels(),
      defaultModel: this.getDefaultModel(),
      defaultMode: this.getDefaultMode(),
      requestTimeout: this.getRequestTimeout(),
      proxy: this.getProxy(),
      ...this.getInferenceParams(),
      permissionMode: this.getPermissionMode(),
      fileWritePermission: this.getFileWritePermission(),
      outsideWorkspaceRead: this.getOutsideWorkspaceRead(),
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
      fileWritePermission: 'fileWritePermission',
      outsideWorkspaceRead: 'outsideWorkspaceRead',
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
