/**
 * Token 用量统计模块
 * 会话级实时统计 + 今日用量统计（按自然日自动重置，本地持久化）
 * 支持对接服务商余额接口
 */
import * as fs from 'fs';
import * as path from 'path';
import { DailyUsage } from '../types';

export class UsageTracker {
  private usageFile: string;
  private cache = new Map<string, DailyUsage>();

  constructor(historyRoot: string) {
    this.usageFile = path.join(historyRoot, 'usage-log.json');
    this.load();
  }

  /** 更新存储根目录（historyPath 配置变更时调用） */
  setRoot(historyRoot: string): void {
    this.usageFile = path.join(historyRoot, 'usage-log.json');
    this.cache.clear();
    this.load();
  }

  private todayKey(): string {
    // 按本地自然日重置（而非 UTC，避免时区偏移导致提前清零）
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  private load(): void {
    try {
      if (fs.existsSync(this.usageFile)) {
        const raw = JSON.parse(fs.readFileSync(this.usageFile, 'utf8'));
        if (Array.isArray(raw)) {
          for (const u of raw) {
            if (u?.date) {
              // 兼容旧版用量文件（无 usedAmount 字段时回退 0）
              this.cache.set(u.date, { ...u, usedAmount: u.usedAmount ?? 0 });
            }
          }
        }
      }
    } catch {
      // 忽略损坏的用量文件
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.usageFile), { recursive: true });
      const list = [...this.cache.values()].sort((a, b) => b.date.localeCompare(a.date));
      // 仅保留最近 90 天
      fs.writeFileSync(this.usageFile, JSON.stringify(list.slice(0, 90), null, 2), 'utf8');
    } catch {
      // 忽略
    }
  }

  /**
   * 累计一次模型调用用量（自然日口径）：Token 用量 + 消费金额估算（CNY）。
   * amount 为按模型单价计算的本次调用费用，与官方控制台量级一致。
   */
  addUsage(inputTokens: number, outputTokens: number, amount = 0): DailyUsage {
    const key = this.todayKey();
    const cur = this.cache.get(key) ?? { date: key, inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0, usedAmount: 0 };
    cur.inputTokens += inputTokens;
    cur.outputTokens += outputTokens;
    cur.totalTokens += inputTokens + outputTokens;
    cur.requests += 1;
    cur.usedAmount = (cur.usedAmount ?? 0) + amount;
    this.cache.set(key, cur);
    this.persist();
    return { ...cur };
  }

  getToday(): DailyUsage | null {
    const cur = this.cache.get(this.todayKey());
    return cur ? { ...cur } : null;
  }
}
