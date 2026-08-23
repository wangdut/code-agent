/**
 * 会话管理模块
 * 职责：会话 CRUD、本地 JSON 持久化、导出、搜索
 * 默认存储路径：工作区 .code-agent/history；支持自定义全局路径
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ChatMessage, RunMode, Session, SessionListItem } from '../types';
import { randomId } from '../utils/id';
import { AuditLogger } from '../security/auditLogger';

/** 惰性缓存上限：同时驻留内存的完整会话数（超出后 LRU 淘汰） */
const MAX_CACHED_SESSIONS = 8;

/** 会话文件命名规则：`<时间戳>-<随机id>.json`（与 create 生成规则一致），严格匹配过滤日志类文件 */
const SESSION_FILE_RE = /^\d+-[a-zA-Z0-9_-]+\.json$/;

export class SessionManager {
  private historyRoot: string;
  /** 已打开会话的完整缓存（惰性加载：非激活会话的消息体不常驻内存） */
  private sessions = new Map<string, Session>();
  /** 全部会话元数据缓存（列表/搜索用，仅含 id/标题/时间/消息数） */
  private metaById = new Map<string, SessionListItem>();
  /** 已删除会话 id（防止删除后正在收尾的运行再次落盘"复活"会话） */
  private deletedIds = new Set<string>();

  constructor(historyRoot: string) {
    this.historyRoot = historyRoot;
    fs.mkdirSync(this.historyRoot, { recursive: true });
  }

  getHistoryRoot(): string {
    return this.historyRoot;
  }

  /** 更新存储根目录（historyPath 配置变更时调用） */
  setRoot(historyRoot: string): void {
    this.historyRoot = historyRoot;
    fs.mkdirSync(this.historyRoot, { recursive: true });
    this.sessions.clear();
    this.metaById.clear();
  }

  private sessionPath(id: string): string {
    // id 含时间戳前缀，文件名即 id，禁止路径穿越
    const safe = id.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.historyRoot, `${safe}.json`);
  }

  /** 新建会话 */
  create(title: string, modelId: string, mode: RunMode): Session {
    const now = Date.now();
    const session: Session = {
      id: `${now}-${randomId()}`,
      title,
      createdAt: now,
      updatedAt: now,
      modelId,
      mode,
      messageCount: 0,
      messages: [],
      summaries: [],
      compressLog: []
    };
    this.sessions.set(session.id, session);
    this.save(session);
    return session;
  }

  get(id: string): Session | undefined {
    const cached = this.sessions.get(id);
    if (cached) {
      // 刷新 LRU 顺序（Map 迭代序 = 插入序）
      this.sessions.delete(id);
      this.sessions.set(id, cached);
      return cached;
    }
    // 惰性加载：仅在打开会话时从磁盘读取完整消息体
    if (!this.metaById.has(id)) {
      return undefined;
    }
    try {
      const raw = fs.readFileSync(this.sessionPath(id), 'utf8');
      const s = JSON.parse(raw) as Session;
      if (!s.id || !Array.isArray(s.messages)) {
        console.error(`[code-agent] 会话文件结构非法，无法续接: ${id}`);
        return undefined;
      }
      // 兼容旧结构
      if (!s.summaries) s.summaries = [];
      if (!s.compressLog) s.compressLog = [];
      this.sessions.set(s.id, s);
      // 惰性缓存上限：淘汰最久未访问的会话，保证非激活数据不长期驻留内存
      while (this.sessions.size > MAX_CACHED_SESSIONS) {
        const oldest = this.sessions.keys().next().value;
        if (oldest) {
          this.sessions.delete(oldest);
        }
      }
      return s;
    } catch (err) {
      // 单文件损坏：记录错误日志，上层走「会话不存在」兜底
      console.error(`[code-agent] 会话文件读取失败，无法续接: ${id}`, err);
      return undefined;
    }
  }

  /**
   * 扫描磁盘重建元数据缓存并返回列表（按更新时间倒序）。
   * 仅解析文件头部元数据（截断解析），消息体不读入内存——大体积会话按需读取。
   * 严格匹配会话文件命名规则，自动过滤 audit-log.jsonl、usage-log.json 等日志文件；
   * 单文件损坏仅记录错误日志并跳过，不中断整体加载。
   */
  loadAll(): SessionListItem[] {
    this.metaById.clear();
    let files: string[] = [];
    try {
      files = fs.readdirSync(this.historyRoot).filter(f => SESSION_FILE_RE.test(f));
    } catch (err) {
      console.error('[code-agent] 历史目录扫描失败:', err);
      return [];
    }
    for (const f of files) {
      try {
        const meta = this.readMeta(path.join(this.historyRoot, f));
        if (meta) {
          this.metaById.set(meta.id, meta);
        }
      } catch (err) {
        // 单文件损坏：记录错误日志并跳过，其余合法会话正常加载
        console.error(`[code-agent] 会话文件解析失败，已跳过: ${f}`, err);
      }
    }
    return this.getMetaList();
  }

  /** 由内存元数据缓存构造排序列表（高频广播路径，零磁盘 IO） */
  getMetaList(): SessionListItem[] {
    return [...this.metaById.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * 读取会话文件头部元数据（截断解析）。
   * 会话 JSON 为固定两空格缩进格式，"messages" 键位于行首且排在 messageCount 之后，
   * 截断到该键之前即可解析出全部列表所需字段，避免启动时解析大体积消息体。
   */
  private readMeta(filePath: string): SessionListItem | null {
    const raw = fs.readFileSync(filePath, 'utf8');
    const marker = '\n  "messages":';
    const idx = raw.indexOf(marker);
    // 截断后上一字段的尾随逗号必须移除，否则 JSON.parse 抛错导致会话被误判损坏
    const head = (idx > 0 ? raw.slice(0, idx) : raw).replace(/,\s*$/, '');
    const s = JSON.parse(head + '\n}') as Partial<Session>;
    if (!s.id) {
      return null;
    }
    return {
      id: s.id,
      title: s.title || '未命名会话',
      createdAt: s.createdAt ?? 0,
      updatedAt: s.updatedAt ?? 0,
      messageCount: typeof s.messageCount === 'number' ? s.messageCount : (s.messages?.length ?? 0)
    };
  }

  /** 搜索会话（标题 + 消息内容）；未打开会话的内容匹配按需读盘，用完即弃不驻留内存 */
  search(keyword: string): SessionListItem[] {
    const kw = keyword.trim().toLowerCase();
    if (!kw) {
      return this.getMetaList();
    }
    const results: SessionListItem[] = [];
    for (const [id, meta] of this.metaById) {
      if (meta.title.toLowerCase().includes(kw)) {
        results.push(meta);
        continue;
      }
      if (this.contentMatch(id, kw)) {
        results.push(meta);
      }
    }
    results.sort((a, b) => b.updatedAt - a.updatedAt);
    return results;
  }

  /** 会话消息内容匹配：已缓存会话搜内存，未缓存会话临时读盘（不写入缓存） */
  private contentMatch(id: string, kw: string): boolean {
    const cached = this.sessions.get(id);
    if (cached) {
      return cached.messages.some(m => m.content.toLowerCase().includes(kw));
    }
    try {
      const raw = fs.readFileSync(this.sessionPath(id), 'utf8');
      const s = JSON.parse(raw) as Session;
      return Array.isArray(s.messages) && s.messages.some(m => m.content.toLowerCase().includes(kw));
    } catch {
      return false;
    }
  }

  /** 持久化会话（JSON 格式），并同步内存元数据缓存（高频广播路径零 IO） */
  save(session: Session): void {
    if (this.deletedIds.has(session.id)) {
      return; // 会话已删除，忽略收尾落盘
    }
    session.updatedAt = Date.now();
    session.messageCount = session.messages.length;
    try {
      const tmp = this.sessionPath(session.id) + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(session, null, 2), 'utf8');
      fs.renameSync(tmp, this.sessionPath(session.id));
      this.metaById.set(session.id, {
        id: session.id,
        title: session.title || '未命名会话',
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messageCount: session.messageCount
      });
    } catch (err) {
      console.error('[code-agent] 会话保存失败:', err);
    }
  }

  rename(id: string, title: string): Session | undefined {
    const s = this.sessions.get(id);
    if (!s) {
      return undefined;
    }
    s.title = title.trim() || s.title;
    this.save(s);
    return s;
  }

  delete(id: string, audit: AuditLogger): boolean {
    this.deletedIds.add(id);
    const existed = this.sessions.delete(id);
    this.metaById.delete(id);
    try {
      const p = this.sessionPath(id);
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
      }
      const tmp = p + '.tmp';
      if (fs.existsSync(tmp)) {
        fs.unlinkSync(tmp);
      }
    } catch {
      // 忽略文件删除失败
    }
    if (existed) {
      audit.log({ type: 'session', action: 'delete', target: id, result: 'success' });
    }
    return existed;
  }

  /** 导出会话为 JSON 文件 */
  async exportTo(id: string): Promise<boolean> {
    const s = this.sessions.get(id);
    if (!s) {
      vscode.window.showErrorMessage('会话不存在');
      return false;
    }
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(this.historyRoot, `${(s.title || 'session').replace(/[\\/:*?"<>|]/g, '_')}.json`)),
      filters: { 'JSON 文件': ['json'] }
    });
    if (!uri) {
      return false;
    }
    fs.writeFileSync(uri.fsPath, JSON.stringify(s, null, 2), 'utf8');
    vscode.window.showInformationMessage(`会话已导出到 ${uri.fsPath}`);
    return true;
  }

  /** 自动生成会话标题（取首条用户消息前 30 字） */
  static deriveTitle(text: string): string {
    const clean = text.replace(/@\[[^\]]+\]\([^)]*\)/g, '').trim();
    const firstLine = clean.split('\n')[0].slice(0, 30);
    return firstLine || '新对话';
  }

  /** 添加消息并持久化 */
  appendMessage(session: Session, msg: ChatMessage): void {
    session.messages.push(msg);
    if (msg.role === 'user' && session.messages.filter(m => m.role === 'user').length === 1) {
      session.title = SessionManager.deriveTitle(msg.content);
    }
    this.save(session);
  }
}
