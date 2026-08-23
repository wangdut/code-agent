/**
 * 模型计费单价表与消费金额估算
 * 已用金额无法从 DeepSeek 余额接口直接获取（接口仅返回三类余额快照，
 * 赠金优先扣费场景下「充值与赠金之和减当前余额」恒为 0），
 * 因此改为本地累计：每次模型调用完成后按 单价 × Token 用量 估算消费金额，
 * 与官方控制台量级一致，统计口径为自然日（与当日 Token 用量一致）。
 */

/** 输入/输出单价（元 / 百万 Token，未命中缓存的公开标准价） */
export interface ModelPrice {
  inputPerM: number;
  outputPerM: number;
}

/** DeepSeek 官方公开标准价（其他 OpenAI 兼容服务商回退使用 deepseek-chat 价格） */
const PRICE_TABLE: Array<{ match: (modelId: string) => boolean; price: ModelPrice }> = [
  {
    // deepseek-reasoner / deepseek-r1 系列：输入 ¥4/M，输出 ¥16/M
    match: id => id.startsWith('deepseek-reasoner') || id.startsWith('deepseek-r1'),
    price: { inputPerM: 4, outputPerM: 16 }
  },
  {
    // deepseek-chat / deepseek-v3 系列：输入 ¥2/M，输出 ¥8/M
    match: id => id.startsWith('deepseek-chat') || id.startsWith('deepseek-v3'),
    price: { inputPerM: 2, outputPerM: 8 }
  }
];

/** 兜底默认价（未匹配到价格表时按 deepseek-chat 标准价估算） */
const DEFAULT_PRICE: ModelPrice = { inputPerM: 2, outputPerM: 8 };

/** 查询模型单价（按模型 id 前缀匹配，未命中回退默认价） */
export function getModelPrice(modelId: string): ModelPrice {
  const hit = PRICE_TABLE.find(e => e.match(modelId));
  return hit ? hit.price : DEFAULT_PRICE;
}

/** 估算一次模型调用的消费金额（CNY，保留 6 位小数，累加展示时统一四舍五入） */
export function estimateCostCNY(modelId: string, inputTokens: number, outputTokens: number): number {
  const p = getModelPrice(modelId);
  return (inputTokens / 1e6) * p.inputPerM + (outputTokens / 1e6) * p.outputPerM;
}
