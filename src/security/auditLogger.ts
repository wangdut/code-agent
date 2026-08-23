/**
 * 操作审计模块
 * 所有文件修改、终端执行操作写入本地操作日志（JSON Lines 格式），支持回溯排查
 */
import * as fs from 'fs';
import * as path from 'path';

export interface AuditEntry {
  time: string;
  type: 'file' | 'command' | 'permission' | 'session';
  action: string;
  target: string;
  result: 'success' | 'error' | 'denied' | 'cancelled';
  detail?: string;
  sessionId?: string;
}

export class AuditLogger {
  private logPath: string;

  constructor(historyRoot: string) {
    this.logPath = path.join(historyRoot, 'audit-log.jsonl');
  }

  /** 更新日志存储根目录（historyPath 配置变更时调用） */
  setRoot(historyRoot: string): void {
    this.logPath = path.join(historyRoot, 'audit-log.jsonl');
  }

  private ensureDir(): void {
    fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
  }

  log(entry: Omit<AuditEntry, 'time'>): void {
    try {
      this.ensureDir();
      const record: AuditEntry = { ...entry, time: new Date().toISOString() };
      fs.appendFileSync(this.logPath, JSON.stringify(record) + '\n', 'utf8');
    } catch {
      // 审计失败不阻断主流程
    }
  }

  /** 读取最近的审计记录（用于排查） */
  readRecent(limit = 200): AuditEntry[] {
    try {
      if (!fs.existsSync(this.logPath)) {
        return [];
      }
      const lines = fs.readFileSync(this.logPath, 'utf8').split('\n').filter(Boolean);
      return lines
        .slice(-limit)
        .reverse()
        .map(l => {
          try {
            return JSON.parse(l) as AuditEntry;
          } catch {
            return null;
          }
        })
        .filter((e): e is AuditEntry => e !== null);
    } catch {
      return [];
    }
  }
}
