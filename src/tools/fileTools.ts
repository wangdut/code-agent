/**
 * 工具执行模块 - 文件操作
 * 职责：文件读取、写入/编辑、目录遍历、代码检索、diff 对比
 * 所有操作经过 SecurityManager 权限校验
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { exec, execFile } from 'child_process';
import { SecurityManager } from '../security/securityManager';
import { AuditLogger } from '../security/auditLogger';
import { PermissionRequest, RunMode, WebSearchResultItem } from '../types';
import { truncate } from '../utils/id';

/** 工具执行结果 */
export interface ToolResult {
  success: boolean;
  output: string;
  /** 文件写入产生的 diff（供 inline diff 展示） */
  diff?: string;
  /** 文件写入的目标文件路径（编辑器 diff 装饰与跳转定位） */
  filePath?: string;
  /** 终端命令（终端工具） */
  command?: string;
  /** 是否因权限被拒绝 */
  denied?: boolean;
  /** 是否被用户取消 */
  cancelled?: boolean;
  /** 联网搜索关键词（V1.5.0 web_search 工具，供节点简报展示） */
  searchQuery?: string;
  /** 联网搜索结构化结果（V1.5.0 过滤压缩后的精简条目，随步骤持久化） */
  searchResults?: WebSearchResultItem[];
}

/** 权限申请回调（由 Agent 引擎注入，桥接 WebView 确认面板） */
export type PermissionRequester = (req: PermissionRequest) => Promise<boolean>;

/** 工具执行上下文 */
export interface ToolContext {
  security: SecurityManager;
  audit: AuditLogger;
  requestPermission: PermissionRequester;
  sessionId: string;
  /** 当前运行模式（V1.0.0 双层体系第一层：写入/终端工具执行前按模式拦截） */
  mode: RunMode;
  /** 终端输出流回调（实时展示） */
  onCommandOutput?: (command: string, chunk: string) => void;
  /** 网络代理地址（V1.5.0 联网搜索复用全局代理配置） */
  proxy?: string;
  signal?: AbortSignal;
}

const MAX_READ_SIZE = 256 * 1024; // 单文件读取上限 256KB
const MAX_LIST_ENTRIES = 500;
const MAX_SEARCH_FILES = 300;
const MAX_SEARCH_MATCHES = 200;
const MAX_COMMAND_OUTPUT = 60000;

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.code-agent', '__pycache__', '.venv', 'venv', 'target', 'bin', 'obj', '.next', '.nuxt', 'coverage']);
const SKIP_EXT = new Set(['.exe', '.dll', '.so', '.dylib', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.eot', '.mp3', '.mp4', '.zip', '.tar', '.gz', '.7z', '.rar', '.pdf', '.class', '.pyc', '.lock', '.vsix']);

function absWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function isBinaryFile(p: string): boolean {
  return SKIP_EXT.has(path.extname(p).toLowerCase());
}

/** 文件读取工具 */
export async function readFileTool(args: any, ctx: ToolContext): Promise<ToolResult> {
  const filePath = ctx.security.resolvePath(String(args.path ?? ''));
  const startLine = args.startLine !== undefined ? Number(args.startLine) : undefined;
  const endLine = args.endLine !== undefined ? Number(args.endLine) : undefined;

  if (!fs.existsSync(filePath)) {
    return { success: false, output: `文件不存在: ${filePath}` };
  }
  if (fs.statSync(filePath).isDirectory()) {
    return { success: false, output: `目标是一个目录: ${filePath}，请使用 list_dir 工具` };
  }
  if (fs.statSync(filePath).size > MAX_READ_SIZE && startLine === undefined) {
    return { success: false, output: `文件过大（>256KB），请使用 startLine/endLine 分段读取` };
  }
  if (isBinaryFile(filePath)) {
    return { success: false, output: `不支持读取二进制文件: ${filePath}` };
  }

  // 读取权限完整开放（V0.9.0）：工作区内/外文件均可直接读取，无需确认
  const content = fs.readFileSync(filePath, 'utf8');
  let lines = content.split('\n');
  if (startLine !== undefined || endLine !== undefined) {
    const s = Math.max(1, startLine ?? 1);
    const e = Math.min(lines.length, endLine ?? lines.length);
    lines = lines.slice(s - 1, e);
    const numbered = lines.map((l, i) => `${s + i}: ${l}`).join('\n');
    ctx.audit.log({ type: 'file', action: 'read', target: filePath, result: 'success', detail: `行 ${s}-${e}`, sessionId: ctx.sessionId });
    return { success: true, output: `# 文件: ${filePath}（第 ${s}-${e} 行，共 ${content.split('\n').length} 行）\n${numbered}` };
  }
  ctx.audit.log({ type: 'file', action: 'read', target: filePath, result: 'success', sessionId: ctx.sessionId });
  return { success: true, output: `# 文件: ${filePath}（共 ${lines.length} 行）\n${content}` };
}

/** 简单行级 diff（LCS 算法） */
export function lineDiff(oldText: string, newText: string): string {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const n = a.length;
  const m = b.length;
  // LCS 表
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push(`- ${a[i]}`);
      i++;
    } else {
      out.push(`+ ${b[j]}`);
      j++;
    }
  }
  while (i < n) {
    out.push(`- ${a[i++]}`);
  }
  while (j < m) {
    out.push(`+ ${b[j++]}`);
  }
  return out.join('\n');
}

/** 文件写入/编辑工具（支持全量写入与精确替换两种模式） */
export async function writeFileTool(args: any, ctx: ToolContext): Promise<ToolResult> {
  const rawPath = String(args.path ?? '');
  const filePath = ctx.security.resolvePath(rawPath);
  const newContent = String(args.content ?? '');
  const oldContent = args.oldContent !== undefined ? String(args.oldContent) : undefined;

  // 工作区外强制只读
  if (!ctx.security.isInWorkspace(filePath)) {
    ctx.audit.log({ type: 'file', action: 'write', target: filePath, result: 'denied', detail: '工作区外文件禁止写入', sessionId: ctx.sessionId });
    return { success: false, output: `权限拒绝：工作区外文件禁止写入（${filePath}）。工作区外文件强制只读。`, denied: true };
  }

  let finalContent = newContent;
  const existed = fs.existsSync(filePath);
  const originalContent = existed ? fs.readFileSync(filePath, 'utf8') : undefined;

  if (oldContent !== undefined && existed) {
    // 精确替换模式：oldContent 必须在文件中唯一
    const count = originalContent!.split(oldContent).length - 1;
    if (count === 0) {
      return { success: false, output: `替换失败：oldContent 未在文件 ${filePath} 中找到。请先读取文件确认内容。` };
    }
    if (count > 1) {
      return { success: false, output: `替换失败：oldContent 在文件中出现 ${count} 次，不唯一。请提供更长的上下文片段。` };
    }
    finalContent = originalContent!.replace(oldContent, newContent);
  }

  // 权限判定（V1.0.0 双层体系：第一层模式拦截 + 第二层权限管理，执行层统一校验）
  const check = ctx.security.checkFileWrite(filePath, finalContent, ctx.mode, existed ? originalContent : undefined);
  if (check.decision === 'deny') {
    const detail = check.reason ?? (existed ? '工作区外文件禁止写入' : '当前模式禁止写入');
    ctx.audit.log({ type: 'file', action: 'write', target: filePath, result: 'denied', detail, sessionId: ctx.sessionId });
    return { success: false, output: check.reason ? `权限拒绝：${check.reason}` : `权限拒绝：禁止写入 ${filePath}`, denied: true };
  }
  if (check.decision === 'confirm' && check.request) {
    const approved = await ctx.requestPermission(check.request);
    if (!approved) {
      ctx.audit.log({ type: 'file', action: 'write', target: filePath, result: 'cancelled', detail: '用户拒绝文件修改', sessionId: ctx.sessionId });
      return { success: false, output: `用户拒绝了文件修改操作`, cancelled: true };
    }
  }

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, finalContent, 'utf8');
  } catch (err) {
    ctx.audit.log({ type: 'file', action: 'write', target: filePath, result: 'error', detail: String(err), sessionId: ctx.sessionId });
    return { success: false, output: `写入失败: ${err}` };
  }

  const diff = lineDiff(originalContent ?? '', finalContent);
  ctx.audit.log({ type: 'file', action: 'write', target: filePath, result: 'success', detail: existed ? '修改文件' : '新建文件', sessionId: ctx.sessionId });
  return {
    success: true,
    output: `${existed ? '已修改' : '已创建'}文件 ${filePath}（${finalContent.split('\n').length} 行）`,
    diff,
    filePath
  };
}

/** 目录遍历工具 */
export async function listDirTool(args: any, ctx: ToolContext): Promise<ToolResult> {
  const rawPath = String(args.path ?? '.');
  const dirPath = ctx.security.resolvePath(rawPath);
  // 目录列举权限完整开放（V0.9.0）：工作区内/外目录均可直接遍历
  if (!fs.existsSync(dirPath)) {
    return { success: false, output: `目录不存在: ${dirPath}` };
  }
  const stat = fs.statSync(dirPath);
  if (!stat.isDirectory()) {
    return { success: false, output: `${dirPath} 不是目录` };
  }
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const lines: string[] = [`# 目录: ${dirPath}`];
  let count = 0;
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.code-agent') {
      continue;
    }
    if (count >= MAX_LIST_ENTRIES) {
      lines.push(`…（条目过多，已截断，共 ${entries.length} 项）`);
      break;
    }
    const full = path.join(dirPath, e.name);
    const isDir = e.isDirectory() || (e.isSymbolicLink() && (() => { try { return fs.statSync(full).isDirectory(); } catch { return false; } })());
    lines.push(`${isDir ? '[目录]' : '[文件]'} ${e.name}${!isDir ? ` (${fs.statSync(full).size} bytes)` : ''}`);
    count++;
  }
  ctx.audit.log({ type: 'file', action: 'list', target: dirPath, result: 'success', sessionId: ctx.sessionId });
  return { success: true, output: lines.join('\n') };
}

/** 代码检索工具（内置 JS 实现，不依赖外部 rg） */
export async function searchCodeTool(args: any, ctx: ToolContext): Promise<ToolResult> {
  const pattern = String(args.pattern ?? '');
  if (!pattern) {
    return { success: false, output: '缺少检索关键词 pattern' };
  }
  const searchRoot = args.path ? ctx.security.resolvePath(String(args.path)) : (absWorkspaceRoot() ?? process.cwd());
  // 检索权限完整开放（V0.9.0）：工作区内/外路径均可检索，只读无副作用
  const caseSensitive = !!args.caseSensitive;

  let regex: RegExp;
  try {
    // 不带全局标志：避免 g 标志 lastIndex 状态化导致隔行漏匹配
    regex = new RegExp(pattern, caseSensitive ? '' : 'i');
  } catch {
    // 非法正则时按字面量处理
    regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? '' : 'i');
  }

  const matches: string[] = [];
  let filesScanned = 0;

  const walk = (dir: string): void => {
    if (filesScanned >= MAX_SEARCH_FILES || matches.length >= MAX_SEARCH_MATCHES || ctx.signal?.aborted) {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (filesScanned >= MAX_SEARCH_FILES || matches.length >= MAX_SEARCH_MATCHES) {
        return;
      }
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) {
          walk(full);
        }
      } else if (e.isFile()) {
        if (isBinaryFile(full)) {
          continue;
        }
        filesScanned++;
        try {
          if (fs.statSync(full).size > 512 * 1024) {
            continue;
          }
          const content = fs.readFileSync(full, 'utf8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (matches.length >= MAX_SEARCH_MATCHES) {
              break;
            }
            if (regex.test(lines[i])) {
              const rel = path.relative(absWorkspaceRoot() ?? searchRoot, full);
              matches.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
            }
          }
        } catch {
          // 忽略不可读文件
        }
      }
    }
  };

  if (fs.statSync(searchRoot).isDirectory()) {
    walk(searchRoot);
  }
  ctx.audit.log({ type: 'file', action: 'search', target: searchRoot, result: 'success', detail: `pattern=${pattern}`, sessionId: ctx.sessionId });
  if (matches.length === 0) {
    return { success: true, output: `未找到匹配 "${pattern}" 的内容（已扫描 ${filesScanned} 个文件）` };
  }
  const out = matches.length >= MAX_SEARCH_MATCHES ? matches.concat([`…（匹配过多，仅展示前 ${MAX_SEARCH_MATCHES} 条）`]) : matches;
  return { success: true, output: `# 检索 "${pattern}" 结果（${matches.length} 条匹配）\n${out.join('\n')}` };
}

/** diff 对比工具（通过 git diff 获取工作区变更） */
export async function diffTool(args: any, ctx: ToolContext): Promise<ToolResult> {
  const ws = absWorkspaceRoot();
  if (!ws) {
    return { success: false, output: '当前没有打开的工作区' };
  }
  // 路径参数校验：仅允许工作区内路径；通过 execFile 传参（不经过 shell，杜绝命令注入）
  let relFilter = '';
  if (args.path !== undefined && args.path !== '') {
    const absFilter = ctx.security.resolvePath(String(args.path));
    if (!ctx.security.isInWorkspace(absFilter)) {
      ctx.audit.log({ type: 'command', action: 'diff', target: absFilter, result: 'denied', detail: '工作区外路径被拒绝', sessionId: ctx.sessionId });
      return { success: false, output: `权限拒绝：diff 仅限工作区内路径（${absFilter}）`, denied: true };
    }
    relFilter = path.relative(ws, absFilter);
  }
  const gitArgs = ['diff', ...(relFilter ? ['--', relFilter] : [])];

  return new Promise(resolve => {
    execFile('git', gitArgs, { cwd: ws, maxBuffer: 10 * 1024 * 1024, timeout: 15000 }, (err, stdout, stderr) => {
      if (err && !stdout) {
        resolve({ success: false, output: `获取 diff 失败（工作区可能不是 git 仓库）: ${stderr.slice(0, 300) || err.message}` });
        return;
      }
      ctx.audit.log({ type: 'command', action: 'diff', target: ws, result: 'success', sessionId: ctx.sessionId });
      if (!stdout.trim()) {
        resolve({ success: true, output: '当前工作区无未提交的变更' });
        return;
      }
      const t = truncate(stdout, 30000);
      resolve({ success: true, output: `# git diff 结果${relFilter ? `（文件: ${relFilter}）` : ''}${t.truncated ? '（已截断）' : ''}\n${t.text}` });
    });
  });
}

/** 终端命令执行工具（支持实时流式输出） */
export async function executeCommandTool(args: any, ctx: ToolContext): Promise<ToolResult> {
  const command = String(args.command ?? '').trim();
  if (!command) {
    return { success: false, output: '缺少命令 command' };
  }
  const cwdRaw = args.cwd ? ctx.security.resolvePath(String(args.cwd)) : (absWorkspaceRoot() ?? process.cwd());
  const cwd = fs.existsSync(cwdRaw) ? cwdRaw : (absWorkspaceRoot() ?? process.cwd());

  // 权限判定（V1.0.0 双层体系：对话模式终端全局禁用）
  const check = ctx.security.checkCommand(cwd, command, ctx.mode);
  if (check.decision === 'confirm' && check.request) {
    const approved = await ctx.requestPermission(check.request);
    if (!approved) {
      ctx.audit.log({ type: 'command', action: 'execute', target: command, result: 'cancelled', detail: '用户拒绝执行', sessionId: ctx.sessionId });
      return { success: false, output: '用户拒绝了命令执行', cancelled: true };
    }
  }
  if (check.decision === 'deny') {
    ctx.audit.log({ type: 'command', action: 'execute', target: command, result: 'denied', detail: check.reason ?? '命令执行被拒绝', sessionId: ctx.sessionId });
    return { success: false, output: check.reason ? `权限拒绝：${check.reason}` : '命令执行被拒绝', denied: true };
  }

  return new Promise(resolve => {
    let stdoutBuf = '';
    let stderrBuf = '';
    const child = exec(command, { cwd, maxBuffer: 50 * 1024 * 1024, timeout: 300000, windowsHide: true }, (err, stdout, stderr) => {
      stdoutBuf = stdout;
      stderrBuf = stderr;
      const exitInfo = err && typeof (err as any).code === 'number' ? `（退出码 ${(err as any).code}）` : err ? `（${err.message}）` : '';
      const combined = (stdoutBuf + (stderrBuf ? `\n[stderr]\n${stderrBuf}` : '')).trim() || '(无输出)';
      const t = truncate(combined, MAX_COMMAND_OUTPUT);
      const success = !err || typeof (err as any).code === 'number' && (err as any).code === 0;
      ctx.audit.log({ type: 'command', action: 'execute', target: command, result: success ? 'success' : 'error', detail: exitInfo, sessionId: ctx.sessionId });
      resolve({
        success: !!success,
        output: `$ ${command}\n执行目录: ${cwd}${exitInfo}\n${t.text}${t.truncated ? '\n…(输出已截断)' : ''}`,
        command
      });
    });

    child.stdout?.on('data', d => {
      ctx.onCommandOutput?.(command, d.toString());
    });
    child.stderr?.on('data', d => {
      ctx.onCommandOutput?.(command, d.toString());
    });
    if (ctx.signal) {
      ctx.signal.addEventListener('abort', () => {
        try {
          child.kill();
        } catch {
          // 忽略
        }
      });
    }
  });
}
