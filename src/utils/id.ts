/**
 * 通用工具函数
 */
import * as crypto from 'crypto';

/** 生成唯一 ID */
export function randomId(): string {
  return crypto.randomBytes(8).toString('hex');
}

/** 截断文本（按字符数，保留头部） */
export function truncate(text: string, maxLen: number, suffix = '…(已截断)'): { text: string; truncated: boolean } {
  if (text.length <= maxLen) {
    return { text, truncated: false };
  }
  return { text: text.slice(0, maxLen) + suffix, truncated: true };
}
