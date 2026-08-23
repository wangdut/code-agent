/**
 * Code Agent 核心服务
 * 职责：全局编排 —— 会话路由、Agent 运行生命周期、权限请求桥接、
 * 多 WebView 消息广播、@文件引用加载、用量统计
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  AttachedFileRef, ChatMessage, DailyUsage, ExtensionToWebviewMessage, ImageRef, IMAGE_MAX_SIZE, ModelMeta,
  PermissionRequest, ProviderInfo, RunMode, Session, SessionContextStats, SessionListItem
} from '../types';
import { ConfigManager, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_OUTPUT_TOKENS, PRESET_PROVIDER_CATALOG, PRESET_PROVIDER_ID } from '../config/configManager';
import { SecurityManager } from '../security/securityManager';
import { AuditLogger } from '../security/auditLogger';
import { SessionManager } from '../sessions/sessionManager';
import { UsageTracker } from '../sessions/usageTracker';
import { ContextManager } from '../context/contextManager';
import { ToolRegistry } from '../tools/toolRegistry';
import { AdapterRegistry } from '../models/modelAdapter';
import { AgentEngine, SYSTEM_PROMPT as ENGINE_SYSTEM_PROMPT } from '../agent/agentEngine';
import { estimateTokens } from '../context/tokenCounter';
import { EditorDiffDecorator } from '../editor/editorDiffDecorator';
import { WebviewController } from '../webview/webviewController';
import { randomId, truncate } from '../utils/id';

const MAX_ATTACH_FILE_SIZE = 50 * 1024; // 单个引用文件 50KB
const MAX_ATTACH_TOTAL_SIZE = 200 * 1024; // 引用总大小 200KB
const MAX_ATTACH_FILES = 30;
const PERMISSION_TIMEOUT = 10 * 60 * 1000; // 权限确认超时 10 分钟

/** 图片扩展名 → MIME 映射（V1.4.0 多模态输入：@ 引用图片文件的格式判定基准） */
const IMAGE_EXT_MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

interface PendingPermission {
  resolve: (approved: boolean) => void;
  controller: WebviewController;
  timer: NodeJS.Timeout;
}

export class CodeAgentService {
  readonly extensionUri: vscode.Uri;
  readonly config: ConfigManager;
  readonly security: SecurityManager;
  readonly sessions: SessionManager;
  readonly usage: UsageTracker;
  readonly audit: AuditLogger;
  readonly tools: ToolRegistry;
  readonly context: ContextManager;
  readonly engine: AgentEngine;
  readonly decorator: EditorDiffDecorator;

  private readonly adapters: AdapterRegistry;
  private readonly controllers = new Set<WebviewController>();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private disposables: vscode.Disposable[] = [];
  private historyWatcher: vscode.FileSystemWatcher | undefined;
  private historyRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  /** 暂存的选区注入请求（编辑器右键触发时侧边栏/面板尚未就绪，就绪后自动下发） */
  private readonly pendingInjections: AttachedFileRef[][] = [];

  constructor(context: vscode.ExtensionContext) {
    this.extensionUri = context.extensionUri;
    this.config = new ConfigManager(context.secrets);
    this.security = new SecurityManager(this.config);
    this.sessions = new SessionManager(this.config.getHistoryRoot());
    this.usage = new UsageTracker(this.config.getHistoryRoot());
    this.audit = new AuditLogger(this.config.getHistoryRoot());
    this.tools = new ToolRegistry();
    this.adapters = new AdapterRegistry();
    this.context = new ContextManager(
      modelId => this.createAdapter(modelId),
      id => this.config.getModel(id),
      () => this.config.getAutoCompressThreshold()
    );
    this.context.setSystemPrompt(ENGINE_SYSTEM_PROMPT);
    this.engine = new AgentEngine({
      config: this.config,
      security: this.security,
      audit: this.audit,
      sessions: this.sessions,
      usage: this.usage,
      context: this.context,
      tools: this.tools,
      getAdapter: modelId => this.createAdapter(modelId)
    });
    // 编辑器 diff 装饰：文件写入后自动打开文件并标记增删行
    this.decorator = new EditorDiffDecorator();
    this.disposables.push(this.decorator);

    // V1.1.0 启动时自动增量同步各服务商模型列表（失败时回退本地缓存，不阻塞主流程）
    void this.syncAllProviders();

    // 配置变更：historyPath 变化时重建存储目录并刷新会话列表，其余设置广播刷新
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('codeAgent')) {
          const root = this.config.getHistoryRoot();
          if (root !== this.sessions.getHistoryRoot()) {
            this.sessions.setRoot(root);
            this.usage.setRoot(root);
            this.audit.setRoot(root);
            // 存储目录迁移：重建文件监听到新目录
            this.setupHistoryWatcher();
            const list = this.sessions.loadAll();
            this.broadcast({ type: 'session:list', sessions: list });
          }
          this.broadcastSettings();
        }
      })
    );

    // 历史目录变更监听：新增/修改/删除会话文件时实时同步侧边栏列表
    this.setupHistoryWatcher();
  }

  /**
   * 建立历史目录文件监听（防抖 300ms 合并连续事件）。
   * historyPath 配置变更后需重建指向新目录。
   */
  private setupHistoryWatcher(): void {
    this.historyWatcher?.dispose();
    if (this.historyRefreshTimer) {
      clearTimeout(this.historyRefreshTimer);
      this.historyRefreshTimer = undefined;
    }
    const root = this.sessions.getHistoryRoot();
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '*.json'));
    const refresh = () => {
      // 防抖：原子写入（tmp→rename）会连续触发 change/create 事件
      if (this.historyRefreshTimer) {
        clearTimeout(this.historyRefreshTimer);
      }
      this.historyRefreshTimer = setTimeout(() => {
        const list = this.sessions.loadAll();
        this.broadcast({ type: 'session:list', sessions: list });
      }, 300);
    };
    watcher.onDidCreate(refresh);
    watcher.onDidChange(refresh);
    watcher.onDidDelete(refresh);
    this.historyWatcher = watcher;
    this.disposables.push(watcher);
  }

  dispose(): void {
    for (const c of [...this.controllers]) {
      c.dispose();
    }
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  // ---------- 适配器 ----------

  /**
   * 按模型创建适配器（V1.1.0 多服务商体系）：
   * 依据模型所属服务商路由 Base URL 与 API Key；未命中时回退预置 DeepSeek 服务商
   */
  async createAdapter(modelId?: string) {
    const provider = this.config.getProviderForModel(modelId);
    const apiKey = await this.config.getProviderApiKey(provider.id);
    if (!apiKey) {
      throw new Error(`服务商「${provider.name}」未配置 API Key，请在设置 → 模型配置中为该服务商填写密钥`);
    }
    return this.adapters.create({
      baseUrl: provider.baseUrl,
      apiKey,
      proxy: this.config.getProxy() || undefined,
      timeout: this.config.getRequestTimeout()
    });
  }

  // ---------- 控制器管理 ----------

  registerController(controller: WebviewController): void {
    this.controllers.add(controller);
  }

  unregisterController(controller: WebviewController): void {
    this.controllers.delete(controller);
    this.cancelPendingForController(controller);
  }

  /** 获取首个可用控制器（命令入口用） */
  firstController(): WebviewController | undefined {
    return [...this.controllers][0];
  }

  /** 控制器就绪：推送会话列表 + 设置 + 恢复当前会话 */
  async onControllerReady(controller: WebviewController): Promise<void> {
    this.registerController(controller);
    const list = this.sessions.loadAll();
    controller.post({ type: 'session:list', sessions: list });
    await this.sendSettings(controller);
    // 自动恢复最近会话（会话续接）
    if (!controller.activeSessionId && list.length > 0) {
      await this.handleSelectSession(controller, list[0].id);
    }
    // 刷新暂存的选区注入请求（编辑器右键「Add to Code Agent」早于面板就绪触发）
    if (this.pendingInjections.length > 0) {
      for (const refs of this.pendingInjections.splice(0)) {
        controller.post({ type: 'editor:inject', refs });
      }
    }
  }

  refreshForController(controller: WebviewController): void {
    controller.post({ type: 'session:list', sessions: this.sessions.loadAll() });
    if (controller.activeSessionId) {
      const session = this.sessions.get(controller.activeSessionId);
      if (session) {
        controller.post({
          type: 'session:loaded',
          session,
          stats: this.computeStats(session)
        });
      }
    }
  }

  private broadcast(msg: ExtensionToWebviewMessage): void {
    for (const c of this.controllers) {
      c.post(msg);
    }
  }

  /** 广播会话列表更新（使用内存元数据缓存，零磁盘 IO） */
  private broadcastSessionList(): void {
    const list = this.sessions.getMetaList();
    this.broadcast({ type: 'session:list', sessions: list });
  }

  private computeStats(session: Session): SessionContextStats {
    return this.context.computeStats(session, session.modelId || this.config.getDefaultModel());
  }

  // ---------- 会话操作 ----------

  async handleNewSession(controller: WebviewController): Promise<void> {
    const session = this.sessions.create('新对话', this.config.getDefaultModel(), this.config.getDefaultMode());
    controller.activeSessionId = session.id;
    controller.post({ type: 'session:new', session });
    this.broadcastSessionList();
  }

  async handleSelectSession(controller: WebviewController, sessionId: string): Promise<void> {
    // 惰性加载：未缓存时从磁盘按需读取完整会话（不触发全量扫描）
    const s = this.sessions.get(sessionId);
    if (!s) {
      controller.post({ type: 'chat:error', sessionId, messageId: '', error: '会话不存在' });
      return;
    }
    controller.activeSessionId = sessionId;
    // 续接时自动检测 Token 占用，超过阈值自动轻量压缩
    if (this.context.needsAutoCompress(s, s.modelId || this.config.getDefaultModel())) {
      await this.context.compress(s, s.modelId || this.config.getDefaultModel());
      this.sessions.save(s);
    }
    controller.post({ type: 'session:loaded', session: s, stats: this.computeStats(s) });
  }

  async handleRenameSession(controller: WebviewController, sessionId: string, title: string): Promise<void> {
    const s = this.sessions.rename(sessionId, title);
    if (s) {
      controller.post({ type: 'session:updated', session: s });
      this.broadcastSessionList();
    }
  }

  async handleDeleteSession(controller: WebviewController, sessionId: string): Promise<void> {
    this.engine.stop(sessionId);
    const wasActive = controller.activeSessionId === sessionId;
    this.sessions.delete(sessionId, this.audit);
    controller.post({ type: 'session:deleted', sessionId });
    const list = this.sessions.loadAll();
    if (wasActive) {
      controller.activeSessionId = list[0]?.id;
      const next = list[0] ? this.sessions.get(list[0].id) : undefined;
      if (next) {
        controller.post({ type: 'session:loaded', session: next, stats: this.computeStats(next) });
      }
    }
    controller.post({ type: 'session:list', sessions: list });
  }

  async handleExportSession(sessionId: string): Promise<void> {
    await this.sessions.exportTo(sessionId);
  }

  handleSearchSessions(controller: WebviewController, keyword: string): void {
    const results = this.sessions.search(keyword);
    controller.post({ type: 'session:list', sessions: results });
  }

  // ---------- 权限请求桥接 ----------

  private requestPermission(controller: WebviewController, req: Omit<PermissionRequest, 'id'>): Promise<boolean> {
    return new Promise(resolve => {
      const id = randomId();
      const full: PermissionRequest = { ...req, id };
      const timer = setTimeout(() => {
        this.pendingPermissions.delete(id);
        resolve(false);
      }, PERMISSION_TIMEOUT);
      this.pendingPermissions.set(id, { resolve, controller, timer });
      controller.post({ type: 'permission:request', request: full });
    });
  }

  handlePermissionResponse(requestId: string, approved: boolean): void {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pendingPermissions.delete(requestId);
    pending.resolve(approved);
  }

  cancelPendingForController(controller: WebviewController): void {
    for (const [id, pending] of this.pendingPermissions) {
      if (pending.controller === controller) {
        clearTimeout(pending.timer);
        this.pendingPermissions.delete(id);
        pending.resolve(false);
      }
    }
  }

  // ---------- @ 引用加载 ----------

  async handleFilesList(controller: WebviewController, query: string): Promise<void> {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) {
      controller.post({ type: 'files:result', query, paths: [] });
      return;
    }
    const files = await vscode.workspace.findFiles(
      '**/*',
      '**/{node_modules,.git,dist,out,build,.code-agent}/**',
      300
    );
    const rels = files
      .map(f => path.relative(ws.uri.fsPath, f.fsPath))
      .filter(p => !p.startsWith('..'));
    // 附加目录（供 @文件夹批量引用），目录以 / 结尾
    const dirs = this.listDirs(ws.uri.fsPath, 2, 100);
    const all = [...dirs, ...rels.sort()];
    controller.post({ type: 'files:result', query, paths: all });
  }

  /** 列出工作区目录（限制深度与数量） */
  private listDirs(root: string, maxDepth: number, maxCount: number): string[] {
    const out: string[] = [];
    const skip = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.code-agent', '__pycache__']);
    const walk = (dir: string, depth: number): void => {
      if (depth > maxDepth || out.length >= maxCount) {
        return;
      }
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (out.length >= maxCount) {
          return;
        }
        if (!e.isDirectory() || e.name.startsWith('.') || skip.has(e.name)) {
          continue;
        }
        const rel = path.relative(root, path.join(dir, e.name)).replace(/\\/g, '/');
        out.push(rel + '/');
        walk(path.join(dir, e.name), depth + 1);
      }
    };
    walk(root, 1);
    return out;
  }

  /** 加载附件内容（文件 + 文件夹批量引用；V0.9.0：读取权限完整开放，工作区内/外文件均可加载） */
  private loadAttachments(attachments: AttachedFileRef[]): AttachedFileRef[] {
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const result: AttachedFileRef[] = [];
    let totalSize = 0;

    for (const att of attachments) {
      if (totalSize >= MAX_ATTACH_TOTAL_SIZE) {
        break;
      }
      let absPath = att.path;
      if (!path.isAbsolute(absPath) && wsRoot) {
        absPath = path.join(wsRoot, att.path);
      }
      if (att.kind === 'file') {
        try {
          if (!fs.existsSync(absPath) || fs.statSync(absPath).isDirectory()) {
            result.push({ ...att, content: `(文件不存在或不是文件: ${att.path})` });
            continue;
          }
          const buf = fs.readFileSync(absPath, 'utf8');
          // 行范围引用：按 startLine/endLine 截取（1-based，含两端），与编辑器右键注入语义一致
          let content = buf;
          if (typeof att.startLine === 'number' && typeof att.endLine === 'number') {
            const lines = buf.split('\n');
            content = lines.slice(Math.max(0, att.startLine - 1), Math.min(lines.length, att.endLine)).join('\n');
          }
          const t = truncate(content, MAX_ATTACH_FILE_SIZE);
          totalSize += Buffer.byteLength(t.text, 'utf8');
          result.push({ ...att, content: t.text, truncated: t.truncated });
        } catch {
          result.push({ ...att, content: `(读取失败: ${att.path})` });
        }
      } else {
        // 文件夹批量引用
        const blocks: string[] = [];
        try {
          if (!fs.existsSync(absPath) || !fs.statSync(absPath).isDirectory()) {
            result.push({ ...att, content: `(目录不存在: ${att.path})` });
            continue;
          }
          const patterns = this.config.getFolderIncludePatterns();
          const files = this.walkForPatterns(absPath, patterns, MAX_ATTACH_FILES);
          for (const f of files) {
            if (totalSize >= MAX_ATTACH_TOTAL_SIZE) {
              blocks.push('…(达到引用大小上限，其余文件略)');
              break;
            }
            const rel = path.relative(absPath, f).replace(/\\/g, '/');
            const buf = fs.readFileSync(f, 'utf8');
            const t = truncate(buf, MAX_ATTACH_FILE_SIZE);
            totalSize += Buffer.byteLength(t.text, 'utf8');
            blocks.push(`## ${rel}${t.truncated ? '（已截断）' : ''}\n${t.text}`);
          }
          result.push({ ...att, content: blocks.join('\n\n') });
        } catch {
          result.push({ ...att, content: `(读取目录失败: ${att.path})` });
        }
      }
    }
    return result;
  }

  /**
   * 读取本地图片文件为 Base64 Data URL（V1.4.0 多模态输入，@ 文件引用路径）：
   * 格式（PNG/JPG/JPEG/WebP）与大小（≤10MB）在扩展侧统一前置校验，失败返回明确原因供前端提示
   */
  async readImageFile(relPath: string): Promise<{ name: string; mimeType: string; dataUrl: string } | { error: string }> {
    const wsFolders = vscode.workspace.workspaceFolders;
    // 无工作区场景（审查加固）：未打开文件夹时直接拒绝引用类读取，避免退化为任意路径直读
    if (!wsFolders || wsFolders.length === 0) {
      return { error: '当前未打开工作区文件夹，无法引用本地图片文件' };
    }
    const wsRoot = wsFolders[0].uri.fsPath;
    const absPath = path.isAbsolute(relPath) ? relPath : path.join(wsRoot, relPath);
    // 工作区路径收敛：消息通道输入不视为可信，拒绝越界（../ 逃逸）读取工作区外图片；
    // 多根工作区对任一根通过即放行（审查加固），避免第 2/3 个文件夹内图片被误拒
    const within = (base: string, target: string): boolean => {
      const rel = path.relative(base, target);
      return !rel.startsWith('..') && !path.isAbsolute(rel);
    };
    const resolved = path.resolve(absPath);
    if (!wsFolders.some(f => within(f.uri.fsPath, resolved))) {
      return { error: `图片不在当前工作区内，仅支持引用工作区内的图片文件: ${relPath}` };
    }
    try {
      if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
        return { error: `图片文件不存在: ${relPath}` };
      }
      // 符号链接复核（审查加固）：收敛判定为词法计算而 stat/read 跟随链接，
      // 需以真实路径复核，防止工作区内植入的链接指向工作区外图片
      const real = fs.realpathSync(resolved);
      if (!wsFolders.some(f => {
        let realRoot = f.uri.fsPath;
        try { realRoot = fs.realpathSync(f.uri.fsPath); } catch { /* 根目录不可解析时退回词法路径 */ }
        return within(realRoot, real);
      })) {
        return { error: `图片链接实际目标不在工作区内，无法引用: ${relPath}` };
      }
      const ext = path.extname(absPath).toLowerCase();
      const mimeType = IMAGE_EXT_MIME[ext];
      if (!mimeType) {
        return { error: '不支持的图片格式：仅支持 PNG / JPG / JPEG / WebP，请转换格式后重试' };
      }
      const size = fs.statSync(absPath).size;
      if (size > IMAGE_MAX_SIZE) {
        return { error: `图片大小 ${(size / 1024 / 1024).toFixed(1)}MB 超过 10MB 上限，请压缩后再上传` };
      }
      const buf = fs.readFileSync(absPath);
      return { name: path.basename(absPath), mimeType, dataUrl: `data:${mimeType};base64,${buf.toString('base64')}` };
    } catch {
      return { error: `图片读取失败: ${relPath}` };
    }
  }

  /** 按 include 规则遍历目录收集文件 */
  private walkForPatterns(root: string, patterns: string[], maxFiles: number): string[] {
    const out: string[] = [];
    const skip = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.code-agent']);
    const walk = (dir: string): void => {
      if (out.length >= maxFiles) {
        return;
      }
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (out.length >= maxFiles) {
          return;
        }
        if (e.name.startsWith('.') || skip.has(e.name)) {
          continue;
        }
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          walk(full);
        } else if (e.isFile()) {
          const rel = path.relative(root, full).replace(/\\/g, '/');
          if (this.matchesAny(rel, patterns)) {
            out.push(full);
          }
        }
      }
    };
    walk(root);
    return out;
  }

  private matchesAny(relPath: string, patterns: string[]): boolean {
    for (const p of patterns) {
      try {
        const regex = new RegExp(
          '^' + p.replace(/\./g, '\\.').replace(/\*\*/g, '\u0001').replace(/\*/g, '[^/]*').replace(/\u0001/g, '.*') + '$'
        );
        if (regex.test(relPath)) {
          return true;
        }
      } catch {
        if (relPath.endsWith(p.replace(/^\*\*\//, ''))) {
          return true;
        }
      }
    }
    return false;
  }

  // ---------- 聊天核心流程 ----------

  async handleChatSend(
    controller: WebviewController,
    sessionId: string,
    text: string,
    attachments: AttachedFileRef[],
    images: ImageRef[],
    modelId: string,
    mode: RunMode
  ): Promise<void> {
    await this.startChat(controller, sessionId, text, attachments, images, modelId, mode, false);
  }

  /** 重新生成：移除该助手消息及其后的工具消息，用上一条用户消息重新执行 */
  async handleChatRegenerate(controller: WebviewController, sessionId: string, messageId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    if (this.engine.isRunning(sessionId)) {
      controller.post({ type: 'chat:error', sessionId, messageId: '', error: '当前会话正在执行任务，请先停止' });
      return;
    }
    const idx = session.messages.findIndex(m => m.id === messageId);
    if (idx < 0) {
      return;
    }
    // 查找该助手消息之前最近的用户消息
    let userIdx = -1;
    for (let i = idx - 1; i >= 0; i--) {
      if (session.messages[i].role === 'user') {
        userIdx = i;
        break;
      }
    }
    if (userIdx < 0) {
      controller.post({ type: 'chat:error', sessionId, messageId: '', error: '未找到可重新生成的用户消息' });
      return;
    }
    const userMsg = session.messages[userIdx];
    const userText = userMsg.content;
    const userAttachments = (userMsg.attachments ?? []).map(a => ({ path: a.path, kind: a.kind }));
    // 移除该助手消息及之后的全部消息（含工具结果）
    session.messages = session.messages.slice(0, idx);
    // 链收缩后 Token 校准快照失配，清除避免误用旧基准（回退为启发式估算）
    delete session.lastPromptTokens;
    delete session.lastStatsMessageCount;
    this.sessions.save(session);
    // 同步 WebView 视图
    controller.post({ type: 'session:updated', session });
    await this.startChat(
      controller,
      sessionId,
      userText,
      userAttachments,
      // 图片已随原用户消息持久化为 Base64，直接复用（无需重读文件），重新生成时多模态语义与首轮一致
      userMsg.images ?? [],
      session.modelId || this.config.getDefaultModel(),
      session.mode || this.config.getDefaultMode(),
      true
    );
  }

  private async startChat(
    controller: WebviewController,
    sessionId: string,
    text: string,
    attachments: AttachedFileRef[],
    images: ImageRef[],
    modelId: string,
    mode: RunMode,
    skipUserAppend: boolean
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      controller.post({ type: 'chat:error', sessionId, messageId: '', error: '会话不存在' });
      return;
    }
    if (this.engine.isRunning(sessionId)) {
      controller.post({ type: 'chat:error', sessionId, messageId: '', error: '当前会话正在执行任务，请等待完成或停止后再发送' });
      return;
    }
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0 && images.length === 0) {
      return;
    }
    // V1.4.0 多模态前置校验：输入含图片时先校验模型能力，不支持则拦截请求（不产生 Token 消耗、无接口报错）；
    // 纯文本输入不受影响，所有模型均可正常发起对话
    if (images.length > 0) {
      const chatModel = this.config.getModel(modelId);
      if (!chatModel?.multimodal) {
        controller.post({ type: 'chat:error', sessionId, messageId: '', error: `当前模型「${chatModel?.name ?? modelId}」不支持图片输入，请更换支持多模态的模型后重试` });
        return;
      }
    }
    // V1.3.0 密钥校验对齐服务商体系：按当前模型所属服务商实时读取 SecretStorage（无内存缓存），
    // 密钥重配置保存后即时生效；修复旧版读全局密钥导致重填密钥后仍报「未配置 API Key」的缺陷
    const chatProvider = this.config.getProviderForModel(modelId);
    const apiKey = await this.config.getProviderApiKey(chatProvider.id);
    if (!apiKey) {
      controller.post({ type: 'chat:error', sessionId, messageId: '', error: `服务商「${chatProvider.name}」未配置 API Key，请点击右上角设置按钮，在「模型配置」中为该服务商填写密钥` });
      return;
    }

    // 加载附件内容（引用资源层；读取权限完整开放，工作区外附件同样加载）
    const loadedAttachments = this.loadAttachments(attachments);
    const messageId = randomId();
    const abortController = new AbortController();
    // 原子先占注册：与检查之间无 await 窗口，杜绝并发执行同一会话
    if (!this.engine.tryRegisterRun(sessionId, abortController)) {
      controller.post({ type: 'chat:error', sessionId, messageId: '', error: '当前会话正在执行任务，请等待完成或停止后再发送' });
      return;
    }

    controller.post({ type: 'chat:start', sessionId, messageId });
    controller.activeSessionId = sessionId;

    this.broadcastSessionList();

    // 流式增量合并：chunk/reasoning/insight 缓冲 16ms 批量下发，降低高频 postMessage 主线程阻塞
    let chunkBuf = '';
    // 思考段缓冲（按 segmentId 分组：跨段时不混合同一消息，保证前端段边界准确）
    let reasoningBufs: { segmentId: string; text: string }[] = [];
    // 推理节点段缓冲（V0.8.0：按 segmentId 分组；carry 消息不入缓冲，立即冲刷保证先于工具节点到达）
    let insightBufs: { segmentId: string; text: string }[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    // 实时 Token 统计：流式片段到达后节流重算（未落盘内容按启发式估算叠加）
    let statsTimer: ReturnType<typeof setTimeout> | null = null;
    let streamedChars = '';
    const flushStream = () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (chunkBuf) {
        controller.post({ type: 'chat:chunk', sessionId, messageId, text: chunkBuf });
        chunkBuf = '';
      }
      for (const b of reasoningBufs) {
        controller.post({ type: 'chat:reasoning', sessionId, messageId, segmentId: b.segmentId, text: b.text });
      }
      reasoningBufs = [];
      for (const b of insightBufs) {
        controller.post({ type: 'chat:insight', sessionId, messageId, segmentId: b.segmentId, text: b.text });
      }
      insightBufs = [];
    };
    // 实时 Token 统计推送（V0.6.0 P1）：每段流式输出后立即重算上下文占用，节流 500ms 避免高频全量遍历
    const scheduleStats = () => {
      if (statsTimer) {
        return;
      }
      statsTimer = setTimeout(() => {
        statsTimer = null;
        const stats = this.computeStats(session);
        // 未落盘的流式内容（思考/回复）补充计入：落盘前 computeStats 无法感知正在生成的部分
        if (streamedChars) {
          const delta = estimateTokens(streamedChars);
          stats.usedTokens += delta;
          stats.layers.active += delta;
        }
        controller.post({ type: 'stats:update', stats });
      }, 500);
    };
    const sendChunk = (t: string) => {
      chunkBuf += t;
      streamedChars += t;
      scheduleStats();
      if (!flushTimer) {
        flushTimer = setTimeout(flushStream, 16);
      }
    };
    const sendReasoning = (segmentId: string, t: string) => {
      const last = reasoningBufs[reasoningBufs.length - 1];
      if (last && last.segmentId === segmentId) {
        last.text += t;
      } else {
        reasoningBufs.push({ segmentId, text: t });
      }
      streamedChars += t;
      scheduleStats();
      if (!flushTimer) {
        flushTimer = setTimeout(flushStream, 16);
      }
    };
    // 推理节点桥接（V0.8.0）：carry（flush 迁移正文）立即冲刷，保证 insight 段先于工具节点消息到达前端
    const sendInsight = (segmentId: string, t: string, carry: string | null) => {
      if (carry !== null) {
        flushStream();
        // 注意：carry 内容此前已通过 chat:chunk 计入 streamedChars，此处仅迁移展示位置，不重复计数
        controller.post({ type: 'chat:insight', sessionId, messageId, segmentId, text: '', carry });
        return;
      }
      const last = insightBufs[insightBufs.length - 1];
      if (last && last.segmentId === segmentId) {
        last.text += t;
      } else {
        insightBufs.push({ segmentId, text: t });
      }
      streamedChars += t;
      scheduleStats();
      if (!flushTimer) {
        flushTimer = setTimeout(flushStream, 16);
      }
    };
    // 流式结束收尾：冲刷节流定时器并清空流式增量缓冲（落盘后 computeStats 已含完整内容，避免竞态重复计数）
    const finishStream = () => {
      if (statsTimer) {
        clearTimeout(statsTimer);
        statsTimer = null;
      }
      streamedChars = '';
    };

    try {
      const status = await this.engine.runTurn(
        session,
        trimmed,
        loadedAttachments,
        images,
        modelId,
        mode,
        {
          onChunk: sendChunk,
          onReasoning: sendReasoning,
          onInsight: sendInsight,
          onStep: step => {
            // 文件写入完成：编辑器侧 diff 装饰（自动打开文件 + 增删行可视化标记）
            if (step.type === 'toolResult' && step.filePath && step.diff) {
              void this.decorator.applyDiff(step.filePath, step.diff);
            }
            scheduleStats();
            controller.post({ type: 'chat:step', sessionId, messageId, step });
          },
          requestPermission: req => this.requestPermission(controller, req),
          onCommandOutput: () => undefined,
          onCompressed: s => {
            controller.post({ type: 'compressed', sessionId, record: s.compressLog[s.compressLog.length - 1] });
            // 同步压缩后的消息列表视图
            controller.post({ type: 'session:updated', session: s });
            controller.post({ type: 'stats:update', stats: this.computeStats(s) });
          },
          // 运行期轻量提示（429 限流退避等待等）：仅前端瞬时展示，不写入会话历史
          onNotice: text => controller.post({ type: 'chat:notice', sessionId, messageId, text })
        },
        abortController.signal,
        messageId,
        skipUserAppend
      );

      // 先冲涮残余增量，保证 chat:done 到达前消息内容完整
      flushStream();
      finishStream();
      const finalMessage = session.messages.find(m => m.id === messageId);
      if (finalMessage) {
        controller.post({ type: 'chat:done', sessionId, messageId, message: finalMessage });
      }
      controller.post({ type: 'stats:update', stats: this.computeStats(session) });
      if (status === 'stopped') {
        controller.post({ type: 'chat:stopped', sessionId, messageId });
      }
      this.broadcastSessionList();
    } catch (err) {
      flushStream();
      finishStream();
      const raw = err instanceof Error ? err.message : String(err);
      controller.post({
        type: 'chat:error',
        sessionId,
        messageId,
        // V1.3.0：运行期鉴权失败精准提示（发起前已拦截未配置密钥，此处必为密钥无效/鉴权失败）
        error: classifyRuntimeModelError(raw)
      });
      this.broadcastSessionList();
    }
  }

  handleChatStop(sessionId: string): void {
    this.engine.stop(sessionId);
  }

  /** 手动压缩 */
  async handleCompress(controller: WebviewController, sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    const record = await this.context.compress(session, session.modelId || this.config.getDefaultModel());
    if (record) {
      this.sessions.save(session);
      controller.post({ type: 'compressed', sessionId, record });
      controller.post({ type: 'session:updated', session });
      controller.post({ type: 'stats:update', stats: this.computeStats(session) });
    } else {
      controller.post({ type: 'chat:error', sessionId, messageId: '', error: '对话内容较少，暂无需压缩' });
    }
  }

  /** 会话切换模型：持久化 modelId 并按新模型窗口口径刷新 Token 统计 */
  async handleSetSessionModel(controller: WebviewController, sessionId: string, modelId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    if (this.engine.isRunning(sessionId)) {
      controller.post({ type: 'chat:error', sessionId, messageId: '', error: '当前会话正在执行任务，请等待完成或停止后再切换模型' });
      return;
    }
    session.modelId = modelId;
    // V1.2.0 服务商联动：切换模型后默认服务商跟随该模型所属服务商，底部下拉框与实际使用模型保持一致；
    // 写入完成后立即广播最新设置，避免 WebView 侧停留在旧服务商导致下拉框过滤不刷新
    const model = this.config.getModel(modelId);
    if (model?.providerId && model.providerId !== this.config.getDefaultProvider()) {
      await this.config.updateSetting('defaultProvider', model.providerId);
      this.broadcastSettings();
    }
    // Tokenizer 口径随模型变化，上一次真实校准值失效，回退启发式估算
    delete session.lastPromptTokens;
    delete session.lastStatsMessageCount;
    this.sessions.save(session);
    controller.post({ type: 'session:updated', session });
    controller.post({ type: 'stats:update', stats: this.computeStats(session) });
    this.broadcastSessionList();
  }

  /**
   * 编辑器右键「Add to Code Agent」：将选中代码段以行范围引用注入对话输入框。
   * 多段选区（多光标）分别生成引用；侧边栏/面板未打开时暂存，就绪后自动注入。
   */
  handleAddSelection(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selections.length === 0) {
      return;
    }
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const docPath = editor.document.uri.fsPath;
    // 相对工作区路径（与 @ 全文件引用一致）；无工作区时退化为文件名
    const relPath = wsRoot
      ? (path.relative(wsRoot, docPath).replace(/\\/g, '/') || path.basename(docPath))
      : path.basename(docPath);
    const refs: AttachedFileRef[] = [];
    for (const sel of editor.selections) {
      if (sel.isEmpty) {
        continue;
      }
      const startLine = Math.max(1, sel.start.line + 1);
      const endLine = Math.max(startLine, sel.end.line + 1);
      refs.push({
        path: relPath,
        kind: 'file',
        content: editor.document.getText(sel),
        startLine,
        endLine
      });
    }
    if (refs.length === 0) {
      return;
    }
    const controller = this.firstController();
    if (controller) {
      controller.post({ type: 'editor:inject', refs });
    } else {
      this.pendingInjections.push(refs);
      void vscode.commands.executeCommand('codeAgent.openPanel');
    }
  }

  /** 打开文件并跳转到最近一次修改位置（对话框变更节点点击联动），打开即应用最近变更高亮 */
  async openFileInEditor(filePath: string): Promise<void> {
    try {
      const doc = await vscode.workspace.openTextDocument(filePath);
      const editor = await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });
      // 跳转联动即时生效（V0.6.0）：打开即重新应用最近一次变更的高亮装饰
      this.decorator.reapply(editor);
      const line = this.decorator.getFirstChangeLine(filePath);
      if (line > 0 && doc.lineCount > 0) {
        const pos = new vscode.Position(Math.min(line - 1, doc.lineCount - 1), 0);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        editor.selection = new vscode.Selection(pos, pos);
      }
    } catch (err) {
      vscode.window.showErrorMessage(`无法打开文件: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---------- 设置与模型 ----------

  async sendSettings(controller: WebviewController): Promise<void> {
    controller.post({ type: 'settings:state', settings: await this.config.getSettingsSnapshot() });
  }

  private broadcastSettings(): void {
    void this.config.getSettingsSnapshot().then(settings => {
      this.broadcast({ type: 'settings:state', settings });
    });
  }

  async handleSettingsUpdate(controller: WebviewController, settings: Record<string, unknown>, apiKey?: string, clearApiKey?: boolean): Promise<void> {
    await this.config.updateSettings(settings, apiKey, clearApiKey);
    await this.sendSettings(controller);
    void vscode.window.showInformationMessage('Code Agent 设置已保存');
  }

  // ---------- 模型服务商与模型列表同步（V1.1.0 多模型接入体系） ----------

  /** 同步队列：串行化各服务商的拉取请求，避免并发重入 */
  private syncQueue: Promise<void> = Promise.resolve();

  /**
   * 同步全部服务商模型列表（启动时自动执行一次增量同步）
   * 单个服务商失败不影响其他服务商；结果通过广播 settings:state 通知各面板
   */
  syncAllProviders(): Promise<void> {
    const run = async (): Promise<void> => {
      for (const p of this.config.getProviders()) {
        await this.syncProviderModels(p.id);
      }
      this.broadcastSettings();
    };
    this.syncQueue = this.syncQueue.then(run, run);
    return this.syncQueue;
  }

  /**
   * 拉取指定服务商的模型列表并同步到本地缓存（V1.2.0 重构）。
   * 无密钥且预置兜底数据存在时：直接以官方标准模型列表兜底（多数厂商 /models 需鉴权，无密钥拉取无意义）；
   * 成功：整体替换该服务商模型（用户校准过的元数据保留），记录同步时间；
   * 失败：保留本地缓存（离线兜底），记录分类后的错误原因供设置页展示；
   * 未配置 API Key 且接口要求鉴权（401/403）且无兜底数据时静默跳过，不标记为错误。
   */
  async syncProviderModels(providerId: string): Promise<{ ok: boolean; error?: string; usedFallback?: boolean }> {
    let provider = this.config.getProvider(providerId);
    if (!provider) {
      // 配置传播延迟兜底：重读一次服务商列表再判定，避免误报「服务商不存在」
      provider = this.config.getProviders().find(p => p.id === providerId);
    }
    if (!provider) {
      return { ok: false, error: '服务商配置未持久化，请重试；如反复出现，请检查工作区设置是否锁定了 codeAgent.providers 配置项' };
    }
    const apiKey = await this.config.getProviderApiKey(providerId);
    const fallbacks = this.config.getProviderFallbackModels(providerId);
    // 无密钥 + 存在预置兜底模型：仅在该服务商无模型缓存时以官方标准列表兜底入库（不覆盖用户手动添加的自定义模型），配置密钥后动态拉取自动覆盖；
    // 兜底未发生真实网络拉取，不记录 lastSyncAt，避免设置页展示误导性的同步时间
    if (!apiKey && fallbacks.length > 0) {
      const cached = this.config.getModels().filter(m => m.providerId === providerId);
      if (cached.length === 0) {
        await this.config.replaceProviderModels(providerId, fallbacks);
      }
      await this.followDefaultModel();
      return { ok: true, usedFallback: true };
    }
    let fetched: ModelMeta[];
    try {
      const adapter = this.adapters.create({
        baseUrl: provider.baseUrl,
        apiKey,
        proxy: this.config.getProxy() || undefined,
        timeout: this.config.getRequestTimeout()
      });
      if (!adapter.listModels) {
        throw new Error('当前适配器不支持模型列表接口');
      }
      const items = await adapter.listModels();
      // 元数据兜底：接口未返回元数据时套用全局默认（300k 上下文 / 100k 输出）
      fetched = items.map(it => ({
        id: it.id,
        name: humanizeModelName(it.id),
        contextWindow: it.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
        maxOutputTokens: it.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        pricing: '按量计费',
        // 多模态能力：接口返回能力信息则同步；未返回默认不支持（用户可在模型校准弹层手动开启）
        multimodal: it.multimodal,
        providerId
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 无密钥且鉴权失败：待配置密钥的常态，不算同步错误
      if (!apiKey && /401|403/.test(msg)) {
        this.config.setProviderSyncState(providerId, {});
        return { ok: false };
      }
      const friendly = classifySyncError(msg);
      this.config.setProviderSyncState(providerId, { syncError: friendly });
      return { ok: false, error: friendly };
    }
    await this.config.replaceProviderModels(providerId, fetched);
    this.config.setProviderSyncState(providerId, { lastSyncAt: Date.now() });
    await this.followDefaultModel();
    return { ok: true };
  }
  
  /** 默认模型跟随：当前 defaultModel 不在模型列表中时回退，优先取默认服务商名下首个模型，避免默认模型与默认服务商分属不同服务商的悬空态 */
  private async followDefaultModel(): Promise<void> {
    const list = this.config.getModels();
    if (!list.some(m => m.id === this.config.getRawDefaultModel())) {
      const defaultProviderId = this.config.getDefaultProvider();
      const candidate = list.find(m => m.providerId === defaultProviderId) ?? list[0];
      await this.config.updateSettings({ defaultModel: candidate?.id ?? '' });
    }
  }

  // ---------- 服务商管理 ----------

  /** 校验服务商配置：名称必填、Base URL 必填且为 http(s) 协议（无任何厂商白名单/名称匹配限制，全量开放自定义接入） */
  private validateProviderInput(name: string, baseUrl: string): string | undefined {
    if (!name.trim()) {
      return '服务商名称不能为空';
    }
    if (!/^https?:\/\/.+/i.test(baseUrl.trim())) {
      return '接口 Base URL 格式不正确，请检查输入';
    }
    return undefined;
  }

  async handleProviderAdd(controller: WebviewController, name: string, baseUrl: string, apiKey?: string, presetId?: string, forceCreate?: boolean): Promise<void> {
    const invalid = this.validateProviderInput(name, baseUrl);
    if (invalid) {
      controller.post({ type: 'chat:error', sessionId: '', messageId: '', error: invalid });
      return;
    }
    // V1.2.0 预置厂商快捷接入：从下拉建议选中的预置厂商使用稳定 id（匹配官方兜底模型数据），其余随机 id
    const catalogHit = presetId ? PRESET_PROVIDER_CATALOG.find(p => p.id === presetId) : undefined;
    const id = catalogHit ? catalogHit.id : randomId();
    if (this.config.getProvider(id)) {
      controller.post({ type: 'chat:error', sessionId: '', messageId: '', error: `服务商「${this.config.getProvider(id)?.name ?? name}」已添加，请在服务商列表中直接编辑或刷新模型` });
      return;
    }
    await this.config.addProvider({ id, name: name.trim(), baseUrl: baseUrl.trim().replace(/\/+$/, '') });
    const hasKey = apiKey !== undefined && apiKey.trim().length > 0;
    if (hasKey) {
      await this.config.setProviderApiKey(id, apiKey as string);
    }
    await this.sendSettings(controller);
    // 新增完成后立即拉取该服务商模型列表（无密钥时使用预置兜底列表，拉取失败返回精准错误原因）
    const res = await this.syncProviderModels(id);
    // V1.3.0 强制创建兜底：拉取失败默认回滚新增（避免无效服务商残留）；勾选「仍要创建」后保留服务商，用户手动添加模型后即可正常调用
    if (!res.ok) {
      if (!forceCreate) {
        await this.config.deleteProvider(id);
        await this.config.clearProviderApiKey(id);
        // 清除拉取失败残留的同步错误状态：预置目录稳定 id 重试新增时不会短暂误展示上一轮错误
        this.config.setProviderSyncState(id, {});
        await this.sendSettings(controller);
        this.broadcastSettings();
        controller.post({ type: 'chat:error', sessionId: '', messageId: '', error: `服务商新增失败：${res.error ?? '模型列表拉取失败'}。如确认 Base URL 与密钥无误，可勾选「仍要创建（手动添加模型）」重试` });
        return;
      }
      await this.sendSettings(controller);
      this.broadcastSettings();
      void vscode.window.showWarningMessage(`「${name.trim()}」已强制创建：模型列表拉取失败（${res.error ?? '未知原因'}），请在模型参数配置区手动添加模型后即可正常调用`);
      return;
    }
    await this.sendSettings(controller);
    this.broadcastSettings();
    if (res.usedFallback) {
      void vscode.window.showInformationMessage(`「${name.trim()}」已添加：未配置 API 密钥，使用预置模型列表；配置密钥后可自动同步最新模型`);
      if (catalogHit?.note) {
        void vscode.window.showWarningMessage(`「${name.trim()}」接入提示：${catalogHit.note}`);
      }
    } else {
      void vscode.window.showInformationMessage(`「${name.trim()}」已添加，模型列表同步成功`);
    }
  }

  async handleProviderUpdate(
    controller: WebviewController,
    id: string,
    name: string,
    baseUrl: string,
    apiKey?: string,
    clearApiKey?: boolean
  ): Promise<void> {
    const provider = this.config.getProvider(id);
    if (!provider) {
      controller.post({ type: 'chat:error', sessionId: '', messageId: '', error: '服务商不存在' });
      return;
    }
    const invalid = this.validateProviderInput(name, baseUrl);
    if (invalid) {
      controller.post({ type: 'chat:error', sessionId: '', messageId: '', error: invalid });
      return;
    }
    const baseUrlChanged = provider.baseUrl !== baseUrl.trim().replace(/\/+$/, '');
    await this.config.updateProvider(id, { name: name.trim(), baseUrl: baseUrl.trim().replace(/\/+$/, '') });
    // V1.2.0 密钥清除专属分支：先彻底删除旧密钥（含预置服务商的旧全局密钥回退源），再写入新密钥，避免清除失效
    if (clearApiKey) {
      await this.config.clearProviderApiKey(id);
    }
    const hasNewKey = apiKey !== undefined && apiKey.trim().length > 0;
    if (hasNewKey) {
      await this.config.setProviderApiKey(id, apiKey as string);
    }
    await this.sendSettings(controller);
    // 修改 Base URL 或密钥状态变化（新配置/清除后补新值）后自动重新拉取模型列表（动态拉取覆盖兜底数据）
    if (baseUrlChanged || clearApiKey || hasNewKey) {
      await this.syncProviderModels(id);
      await this.sendSettings(controller);
    }
    this.broadcastSettings();
  }

  async handleProviderDelete(controller: WebviewController, id: string): Promise<void> {
    if (id === PRESET_PROVIDER_ID) {
      controller.post({ type: 'chat:error', sessionId: '', messageId: '', error: '预置服务商 DeepSeek 不可删除（可修改名称与 Base URL）' });
      return;
    }
    const provider = this.config.getProvider(id);
    if (!provider) {
      return;
    }
    await this.config.deleteProvider(id);
    await this.config.removeProviderModels(id);
    await this.config.clearProviderApiKey(id);
    // 默认模型跟随：被删服务商的模型为默认模型时回退为剩余列表首个模型
    await this.followDefaultModel();
    await this.sendSettings(controller);
    this.broadcastSettings();
  }

  /** 手动刷新服务商模型列表 */
  async handleProviderRefresh(controller: WebviewController, id: string): Promise<void> {
    if (!this.config.getProvider(id)) {
      controller.post({ type: 'chat:error', sessionId: '', messageId: '', error: '服务商不存在' });
      return;
    }
    const res = await this.syncProviderModels(id);
    await this.sendSettings(controller);
    this.broadcastSettings();
    if (!res.ok && res.error) {
      controller.post({ type: 'chat:error', sessionId: '', messageId: '', error: `模型列表拉取失败：${res.error}` });
    } else if (res.ok && res.usedFallback) {
      void vscode.window.showInformationMessage(`未配置 API 密钥，已使用预置模型列表；配置密钥后再次刷新可同步最新模型`);
    } else if (res.ok) {
      void vscode.window.showInformationMessage(`「${this.config.getProvider(id)?.name}」模型列表已同步`);
    }
  }

  async handleModelAdd(controller: WebviewController, model: ModelMeta): Promise<void> {
    const models = this.config.getModels();
    if (models.some(m => m.id === model.id)) {
      controller.post({ type: 'chat:error', sessionId: '', messageId: '', error: `模型 ${model.id} 已存在` });
      return;
    }
    models.push(model);
    await this.config.setModels(models);
    await this.sendSettings(controller);
    this.broadcastSettings();
  }

  async handleModelUpdate(controller: WebviewController, oldId: string, model: ModelMeta): Promise<void> {
    const models = this.config.getModels();
    const idx = models.findIndex(m => m.id === oldId);
    if (idx < 0) {
      return;
    }
    if (oldId !== model.id && models.some(m => m.id === model.id)) {
      controller.post({ type: 'chat:error', sessionId: '', messageId: '', error: `模型 ${model.id} 已存在` });
      return;
    }
    models[idx] = model;
    await this.config.setModels(models);
    // 默认模型跟随更新（读取原始配置值判断，避免列表回退值干扰比较）
    if (this.config.getRawDefaultModel() === oldId) {
      await this.config.updateSettings({ defaultModel: model.id });
    }
    await this.sendSettings(controller);
    this.broadcastSettings();
  }

  async handleModelDelete(controller: WebviewController, modelId: string): Promise<void> {
    let models = this.config.getModels();
    if (models.length <= 1) {
      controller.post({ type: 'chat:error', sessionId: '', messageId: '', error: '至少保留一个模型' });
      return;
    }
    models = models.filter(m => m.id !== modelId);
    await this.config.setModels(models);
    // 读取原始配置值判断，避免回退值干扰
    if (this.config.getRawDefaultModel() === modelId) {
      await this.config.updateSettings({ defaultModel: models[0].id });
    }
    await this.sendSettings(controller);
    this.broadcastSettings();
  }

  // ---------- 用量统计 ----------

  async handleUsageQuery(controller: WebviewController): Promise<void> {
    const today: DailyUsage | null = this.usage.getToday();
    let balance: string | undefined;
    let balanceError: string | undefined;
    try {
      // 余额接口为 DeepSeek 专属能力：使用默认模型所属服务商（预置 DeepSeek）查询
      const adapter = await this.createAdapter(this.config.getDefaultModel());
      balance = await adapter.queryBalance();
      // 已用金额：本地按 Token 用量 × 模型单价累计（自然日口径），无法从余额接口直接推导
      const used = today?.usedAmount ?? 0;
      const reqs = today?.requests ?? 0;
      balance = `${balance}（已用 ${used.toFixed(2)} CNY · 今日调用 ${reqs} 次）`;
    } catch (err) {
      balanceError = err instanceof Error ? err.message : String(err);
    }
    controller.post({ type: 'usage:result', usage: { today, balance, balanceError } });
  }
}

/**
 * 模型 id 人性化展示名：分割符切分并首字母大写（如 deepseek-chat → Deepseek Chat）
 * 无分割符或纯符号 id 时原样返回
 */
function humanizeModelName(id: string): string {
  const tokens = id.split(/[-_./]+/).filter(Boolean);
  if (tokens.length <= 1) {
    return id;
  }
  return tokens.map(t => (t[0] ? t[0].toUpperCase() + t.slice(1) : t)).join(' ');
}

/**
 * 模型列表拉取错误分类（V1.2.0）：将原始错误信息归类为鉴权失败/接口不兼容/网络异常，
 * 返回可定位问题原因的精准提示，不再笼统报错
 */
function classifySyncError(msg: string): string {
  if (/\b(401|403)\b/.test(msg) || /unauthorized|forbidden|invalid.*key|api.?key/i.test(msg)) {
    return `API Key 鉴权失败，请检查密钥有效性（${msg}）`;
  }
  if (/\b404\b/.test(msg) || /not found/i.test(msg)) {
    return `接口未兼容 OpenAI 协议规范，无法拉取模型列表（${msg}）`;
  }
  if (/超时|timeout|timed out/i.test(msg)) {
    return `无法连接至接口地址，请检查网络与 Base URL 是否正确（请求超时：${msg}）`;
  }
  if (/ECONNREFUSED|ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|网络请求失败/i.test(msg)) {
    return `无法连接至接口地址，请检查网络与 Base URL 是否正确（${msg}）`;
  }
  return msg;
}

/**
 * 运行期模型调用错误分类（V1.3.0）：发起前已拦截「未配置密钥」场景，
 * 运行期命中鉴权类错误必为密钥无效/过期，与未配置场景区分提示
 */
function classifyRuntimeModelError(msg: string): string {
  if (/\b(401|403)\b/.test(msg) || /unauthorized|forbidden|invalid.*key/i.test(msg)) {
    return `API Key 鉴权失败，请检查密钥有效性（${msg}）`;
  }
  return msg;
}
