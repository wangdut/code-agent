/**
 * 安全权限体系
 * - 文件操作分级权限：工作区内（全自动/询问）、工作区外（强制只读 + 读取提示）
 * - 终端操作权限：默认确认、工作区内命令可免确认、高危命令强制二次确认
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ConfigManager } from '../config/configManager';
import { PermissionRequest } from '../types';

/** 高危命令拦截规则（破坏性操作，统一对命令小写形式匹配） */
const HIGH_RISK_PATTERNS: Array<{ pattern: RegExp; desc: string }> = [
  { pattern: /\brm\s+((-[a-z]*r[a-z]*f)|-rf|--recursive|--force|(-r\s+-f)|(-f\s+-r))/, desc: '递归强制删除文件/目录' },
  { pattern: /\brmdir\s+(\/s|-\w*s|--recursive)/, desc: '递归删除目录' },
  { pattern: /\bdel\s+[^\n]*\/[sq]\b/, desc: '递归删除文件' },
  { pattern: /\bformat\b/, desc: '磁盘格式化' },
  { pattern: /\bmkfs\b/, desc: '创建文件系统（格式化）' },
  { pattern: /\bshutdown\b|\breboot\b|\bpoweroff\b|\bhalt\b/, desc: '关机/重启系统' },
  { pattern: /\bgit\s+(push|reset)\b[^\n]*(--force|--hard|-f\b)/, desc: 'Git 强制推送/硬重置' },
  { pattern: /\bsudo\s+rm\b|\bdoas\s+rm\b/, desc: '提权删除操作' },
  { pattern: /\bchmod\s+777\b|\bchmod\s+-r\s+777\b/, desc: '开放全部文件权限' },
  { pattern: /\bdd\s+if=/, desc: '磁盘写入操作' },
  { pattern: /:\(\)\s*\{/, desc: 'Fork 炸弹' },
  { pattern: /curl[^\n|]*\|\s*(ba)?sh|\bwget[^\n|]*\|\s*(ba)?sh/, desc: '下载并直接执行远程脚本' },
  { pattern: />\s*\/dev\/(sd|nvme|hd)[a-z]/, desc: '向磁盘设备直接写入' },
  { pattern: /\bgit\s+clean\b[^\n]*-f/, desc: 'Git 强制清理未跟踪文件' },
  { pattern: /\bnpm\s+(unpublish|deprecate)\b/, desc: 'npm 包发布破坏操作' },
  { pattern: /\bdrop\s+table\b|\btruncate\s+table\b/, desc: '数据库破坏性操作' },
  { pattern: /\bremove-item\b[^\n]*(-recurse|-force)/, desc: 'PowerShell 递归强制删除' }
];

export interface RiskCheckResult {
  isHighRisk: boolean;
  descriptions: string[];
}

export class SecurityManager {
  constructor(private readonly config: ConfigManager) {}

  /** 工作区根目录列表 */
  private getWorkspaceRoots(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).map(f => path.normalize(f.uri.fsPath));
  }

  /** 判断路径是否在工作区内（含符号链接真实路径解析，防 symlink 逃逸） */
  isInWorkspace(absPath: string): boolean {
    const normalized = path.normalize(absPath);
    const roots = this.getWorkspaceRoots();
    if (!roots.some(root => normalized === root || normalized.startsWith(root + path.sep))) {
      return false;
    }
    // 前缀校验通过后解析真实路径，拦截指向工作区外的符号链接
    const realRoots = roots.map(r => {
      try {
        return fs.realpathSync(r);
      } catch {
        return r;
      }
    });
    let real: string;
    try {
      real = fs.realpathSync(normalized);
    } catch {
      // 路径不存在（如新建文件）：解析最近存在的父目录后再拼接
      let dir = path.dirname(normalized);
      while (dir && !fs.existsSync(dir)) {
        const parent = path.dirname(dir);
        if (parent === dir) {
          return false;
        }
        dir = parent;
      }
      try {
        real = path.join(fs.realpathSync(dir), path.relative(dir, normalized));
      } catch {
        return false;
      }
    }
    return realRoots.some(r => real === r || real.startsWith(r + path.sep));
  }

  /** 解析路径（相对路径基于工作区） */
  resolvePath(p: string): string {
    if (path.isAbsolute(p)) {
      return path.normalize(p);
    }
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) {
      return path.normalize(p);
    }
    return path.normalize(path.join(ws.uri.fsPath, p));
  }

  /** 高危命令检测（对命令小写归一化后匹配，防止大小写绕过） */
  checkCommandRisk(command: string): RiskCheckResult {
    const lower = command.toLowerCase();
    const descriptions: string[] = [];
    for (const { pattern, desc } of HIGH_RISK_PATTERNS) {
      if (pattern.test(lower)) {
        descriptions.push(desc);
      }
    }
    // 组合绕过检测：shell 分隔符 + 破坏性关键词同时出现（防拆分/管道/变量展开写法）
    if (/[;&|]/.test(lower) && /\b(rm|del|format|mkfs|dd|shutdown|reboot|poweroff|remove-item)\b/.test(lower)) {
      descriptions.push('组合命令中包含破坏性操作');
    }
    return { isHighRisk: descriptions.length > 0, descriptions };
  }

  /**
   * 文件写入权限判定
   * @returns 'allow' 直接允许 | 'deny' 直接拒绝 | 'confirm' 需要确认
   */
  checkFileWrite(absPath: string, content: string, oldContent?: string): { decision: 'allow' | 'deny' | 'confirm'; request?: PermissionRequest } {
    if (!this.isInWorkspace(absPath)) {
      // 工作区外文件强制只读
      return { decision: 'deny' };
    }
    const mode = this.config.getFileWritePermission();
    // 全自动模式：常规文件写入直接放行
    if (mode === 'auto' || this.config.getPermissionMode() === 'auto') {
      return { decision: 'allow' };
    }
    const request: PermissionRequest = {
      id: '',
      type: 'fileWrite',
      title: '文件修改确认',
      detail: `Agent 请求${oldContent !== undefined ? '修改' : '写入'}文件：${absPath}`,
      impact: `文件大小 ${Buffer.byteLength(content, 'utf8')} 字节，修改后将覆盖原内容`,
      payload: { path: absPath, content, oldContent, isNew: oldContent === undefined }
    };
    return { decision: 'confirm', request };
  }

  /** 工作区外文件读取判定 */
  checkFileReadOutside(absPath: string): { decision: 'allow' | 'deny' | 'confirm'; request?: PermissionRequest } {
    if (this.isInWorkspace(absPath)) {
      return { decision: 'allow' };
    }
    const policy = this.config.getOutsideWorkspaceRead();
    // 全自动模式：工作区外读取放行（读操作低风险，工作区外写入仍强制禁止）
    if (policy === 'deny' && this.config.getPermissionMode() !== 'auto') {
      return { decision: 'deny' };
    }
    if (this.config.getPermissionMode() === 'auto') {
      return { decision: 'allow' };
    }
    const request: PermissionRequest = {
      id: '',
      type: 'fileReadOutside',
      title: '工作区外文件读取',
      detail: `Agent 请求读取工作区外文件：${absPath}`,
      impact: '该文件位于当前工作区之外，读取内容可能包含敏感信息',
      payload: { path: absPath }
    };
    return { decision: 'confirm', request };
  }

  /** 终端命令权限判定 */
  checkCommand(cwd: string, command: string): { decision: 'allow' | 'deny' | 'confirm'; request?: PermissionRequest; highRisk: boolean } {
    const risk = this.checkCommandRisk(command);
    const highRiskBlocked = this.config.getHighRiskCommandsEnabled() && risk.isHighRisk;
    const inWorkspace = this.isInWorkspace(cwd);

    if (highRiskBlocked) {
      // 高危命令强制二次确认
      const request: PermissionRequest = {
        id: '',
        type: 'highRiskCommand',
        title: '高危命令二次确认',
        detail: `Agent 请求执行高危命令：${command}`,
        impact: `风险：${risk.descriptions.join('、')}。该操作可能造成不可逆的数据损失`,
        payload: { command, cwd }
      };
      return { decision: 'confirm', request, highRisk: true };
    }
    if (inWorkspace && (this.config.getTerminalAutoApprove() || this.config.getPermissionMode() === 'auto')) {
      return { decision: 'allow', highRisk: false };
    }
    const request: PermissionRequest = {
      id: '',
      type: 'command',
      title: '终端命令确认',
      detail: `Agent 请求执行命令：${command}`,
      impact: `执行目录：${cwd}，命令将继承当前系统用户权限`,
      payload: { command, cwd }
    };
    return { decision: 'confirm', request, highRisk: false };
  }
}
