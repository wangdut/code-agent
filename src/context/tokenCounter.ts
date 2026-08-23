/**
 * Token 估算器
 * 无外部依赖的启发式估算：CJK 字符按约 0.6 token/字符（DeepSeek 中文分词实测量级），
 * 其余文本按 4 字符/token
 * 定位：兜底估算——模型请求完成后以返回的 prompt_tokens 校准为真实口径
 * （与请求体一致），本估算仅在消息链变化（校准快照失配）或分层展示时使用（非计费精确值）
 */

/** CJK 字符的 token 折算系数（估算：中文平均约 1.7 字符/token，取 0.6 token/字符，避免高估 60%+） */
const CJK_TOKENS_PER_CHAR = 0.6;

export function estimateTokens(text: string): number {
  if (!text) {
    return 0;
  }
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    // CJK 统一表意文字、日文假名、韩文、全角标点等
    if (
      (code >= 0x2e80 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      cjk++;
    } else {
      other++;
    }
  }
  return Math.max(1, Math.round(cjk * CJK_TOKENS_PER_CHAR + other / 4));
}
