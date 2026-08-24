/**
 * 联网搜索工具模块（V1.5.0）
 * 职责：为 Agent 提供自主决策式联网搜索能力 —— 搜索请求、结果多层过滤压缩、结构化注入上下文
 *
 * 设计原则：
 * - 独立封装：搜索为独立工具层，与模型服务商解耦（所有 OpenAI 兼容模型均可用），不触碰文件权限体系
 * - Token 效率：结果数量限流（Top N）+ 多层过滤压缩（清洗/摘要/结构化）+ 关键词相关性淘汰，禁止全量原始网页塞入消息链
 * - 容错降级：全链路异常捕获（网络不可用/接口失败/解析错误/无有效结果），异常仅记录本地审计日志，
 *   不向上抛出业务异常；失败时弱标注「未获取到有效搜索结果」，Agent 回退无搜索模式继续作答
 */
import * as http from 'http';
import * as https from 'https';
import { WebSearchResultItem } from '../types';
import { ToolContext, ToolResult } from './fileTools';

/** 单次搜索返回的最大结果条数（结果数量限流：3-5 条高相关结果，从源头控制数据体量） */
const MAX_RESULTS = 5;
/** 单条摘要最大字符数（摘要层：语义截断，保留核心信息点） */
const SNIPPET_MAX_LEN = 220;
/** 单条标题最大字符数 */
const TITLE_MAX_LEN = 120;
/** 单源请求超时（毫秒）：搜索为辅助能力，短超时避免拖慢任务主链路 */
const SOURCE_TIMEOUT = 15000;
/** 重定向跟随最大跳数：防止搜索源重定向循环导致无限递归 */
const MAX_REDIRECTS = 3;
/** 注入上下文的结果文本总长硬上限（Token 安全兜底） */
const MAX_OUTPUT_LEN = 6000;

/** 结构化搜索结果（附带相关性评分，供淘汰排序） */
interface ScoredResult extends WebSearchResultItem {
  score: number;
}

/** 失败降级统一文案前缀（工具节点弱标注基准，模型据此回退无搜索模式） */
const NO_RESULT_PREFIX = '未获取到有效搜索结果';

/** 复用代理配置创建请求 Agent（与模型适配层同口径，支持 codeAgent.proxy 配置） */
function getProxyAgent(proxy: string | undefined): https.Agent | undefined {
  if (!proxy) {
    return undefined;
  }
  try {
    const { HttpsProxyAgent } = require('https-proxy-agent');
    const proxyUrl = proxy.includes('://') ? proxy : `http://${proxy}`;
    return new HttpsProxyAgent(proxyUrl);
  } catch {
    return undefined;
  }
}

/** 发起 HTTP(S) GET 请求（短超时 + 取消信号 + 体积限流，全异常以 reject 收敛由上层统一捕获） */
function httpGet(url: string, proxy: string | undefined, signal?: AbortSignal, depth = 0): Promise<string> {
  return new Promise((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      reject(new Error(`无效的搜索地址: ${url}`));
      return;
    }
    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
      reject(new Error('仅支持 http/https 搜索源'));
      return;
    }
    const mod = target.protocol === 'https:' ? https : http;
    const agent = target.protocol === 'https:' ? getProxyAgent(proxy) : undefined;
    const req = mod.request(
      target,
      {
        method: 'GET',
        headers: {
          // 常规浏览器 UA：避免被搜索源按爬虫直接拒绝
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
        },
        timeout: SOURCE_TIMEOUT,
        ...(agent ? { agent } : {})
      },
      res => {
        // 3xx 跳转：手动跟随（搜索源重定向常见），带深度计数防止重定向循环无限递归
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (depth >= MAX_REDIRECTS) {
            reject(new Error(`搜索源重定向次数超限（${MAX_REDIRECTS} 跳）`));
            return;
          }
          try {
            const next = new URL(res.headers.location, target).toString();
            httpGet(next, proxy, signal, depth + 1).then(resolve, reject);
          } catch {
            reject(new Error(`搜索源重定向地址无效 (HTTP ${res.statusCode})`));
          }
          return;
        }
        if (!res.statusCode || res.statusCode !== 200) {
          res.resume();
          reject(new Error(`搜索源返回 HTTP ${res.statusCode ?? '未知状态'}`));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (c: Buffer) => {
          total += c.length;
          // 体积限流：搜索结果页超过 1MB 即截断，防止异常响应占满内存
          if (total <= 1024 * 1024) {
            chunks.push(c);
          } else {
            res.destroy();
            resolve(Buffer.concat(chunks).toString('utf8'));
          }
        });
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error('搜索请求超时'));
    });
    req.on('error', reject);
    if (signal) {
      signal.addEventListener('abort', () => {
        req.destroy(new Error('搜索已取消'));
      });
    }
    req.end();
  });
}

/** HTML 实体解码（常见命名实体 + 十进制/十六进制数字实体） */
function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
      try {
        return String.fromCodePoint(parseInt(h, 16));
      } catch {
        return '';
      }
    })
    .replace(/&#(\d+);/g, (_, d) => {
      try {
        return String.fromCodePoint(parseInt(d, 10));
      } catch {
        return '';
      }
    })
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/**
 * 清洗层：剔除 HTML 标签、脚本样式、导航/页脚类样板短语，折叠空白，提取正文核心内容
 */
function cleanText(html: string): string {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  text = decodeEntities(text);
  // 样板短语淘汰（导航栏/页脚/营销类无关元素）
  text = text.replace(/(登录|注册|收藏本站|加入收藏|分享到|关注我们|版权所有|All Rights Reserved|Copyright|隐私政策|Cookie (设置|政策)|订阅我们|Sign [Ii]n|Log [Ii]n|Subscribe|Newsletter)[^。.;；]*/g, ' ');
  return text.replace(/\s+/g, ' ').trim();
}

/** 摘要层：语义截断 —— 按句子边界压缩到上限以内，保留核心信息点 */
function compressSnippet(text: string, maxLen: number): string {
  if (text.length <= maxLen) {
    return text;
  }
  const cut = text.slice(0, maxLen);
  const boundary = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('. '), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf(';'));
  return (boundary > maxLen * 0.5 ? cut.slice(0, boundary + 1) : cut) + '…';
}

/** 解析 DuckDuckGo HTML 结果页（主搜索源：免密钥、无厂商限制） */
function parseDuckDuckGoHtml(html: string): WebSearchResultItem[] {
  const out: WebSearchResultItem[] = [];
  // 按结果块切分（每个 web-result 为一条结果）
  const blocks = html.split(/class="[^"]*result results_links/).slice(1);
  for (const block of blocks) {
    const link = block.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) {
      continue;
    }
    const snippet = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    const url = resolveDdgUrl(link[1]);
    const title = cleanText(link[2]);
    if (!url || !title) {
      continue;
    }
    out.push({ title: title.slice(0, TITLE_MAX_LEN), snippet: compressSnippet(cleanText(snippet?.[1] ?? ''), SNIPPET_MAX_LEN), url });
  }
  return out;
}

/** DuckDuckGo 跳转链接还原真实目标 URL（//duckduckgo.com/l/?uddg=<encoded>） */
function resolveDdgUrl(href: string): string {
  try {
    const normalized = href.startsWith('//') ? `https:${href}` : href;
    const u = new URL(normalized);
    const uddg = u.searchParams.get('uddg');
    if (uddg) {
      return decodeURIComponent(uddg);
    }
    return /^https?:\/\//i.test(normalized) ? normalized : '';
  } catch {
    return '';
  }
}

/** 解析 Bing 结果页（备用搜索源：主源异常时降级兜底） */
function parseBingHtml(html: string): WebSearchResultItem[] {
  const out: WebSearchResultItem[] = [];
  const blocks = html.split(/<li[^>]*class="[^"]*b_algo/).slice(1);
  for (const block of blocks) {
    const link = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) {
      continue;
    }
    const snippet = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    const url = link[1];
    const title = cleanText(link[2]);
    if (!/^https?:\/\//i.test(url) || !title) {
      continue;
    }
    out.push({ title: title.slice(0, TITLE_MAX_LEN), snippet: compressSnippet(cleanText(snippet?.[1] ?? ''), SNIPPET_MAX_LEN), url });
  }
  return out;
}

/** 查询词分词（英文按分隔符切分；中文按双字滑窗提取特征词，供相关性评分） */
function tokenize(query: string): string[] {
  const tokens = new Set<string>();
  for (const w of query.toLowerCase().split(/[^0-9a-z\u4e00-\u9fff]+/)) {
    if (!w) {
      continue;
    }
    if (/^[0-9a-z.+#-]+$/.test(w) && w.length >= 2) {
      tokens.add(w);
    } else {
      // CJK：单字区分度低，取双字滑窗；短词直接保留
      if (w.length <= 2) {
        tokens.add(w);
      }
      for (let i = 0; i + 2 <= w.length; i++) {
        tokens.add(w.slice(i, i + 2));
      }
    }
  }
  return [...tokens];
}

/**
 * 相关性淘汰：基于任务关键词对结果做二次评分排序，仅保留 Top N 高价值内容。
 * 标题命中权重高于摘要；无评分差异时保持搜索源原始排序（源侧已按相关性排序）
 */
function rankAndLimit(items: WebSearchResultItem[], query: string): ScoredResult[] {
  const tokens = tokenize(query);
  const scored: ScoredResult[] = items.map(it => {
    const haystackTitle = it.title.toLowerCase();
    const haystackBody = `${it.title} ${it.snippet}`.toLowerCase();
    let score = 0;
    for (const t of tokens) {
      if (haystackTitle.includes(t)) {
        score += 2;
      } else if (haystackBody.includes(t)) {
        score += 1;
      }
    }
    // 查询整体命中额外加权（短语级相关性）
    if (query && haystackBody.includes(query.toLowerCase())) {
      score += 3;
    }
    return { ...it, score };
  });
  scored.sort((a, b) => b.score - a.score);
  // URL 去重（同源重复条目淘汰）
  const seen = new Set<string>();
  const out: ScoredResult[] = [];
  for (const s of scored) {
    if (seen.has(s.url) || out.length >= MAX_RESULTS) {
      continue;
    }
    seen.add(s.url);
    out.push(s);
  }
  return out;
}

/** 结构化层：整理为「标题+核心摘要+来源链接」标准化文本，统一格式注入上下文 */
function formatOutput(query: string, results: ScoredResult[]): string {
  const lines: string[] = [`# 联网搜索 "${query}" 结果（${results.length} 条精简摘要）`];
  results.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.title}`);
    if (r.snippet) {
      lines.push(`   摘要: ${r.snippet}`);
    }
    lines.push(`   来源: ${r.url}`);
  });
  lines.push('（以上为搜索精简摘要，请结合任务甄别时效性与准确性；如需细节可基于来源链接的关键信息推理，无需再次搜索相同关键词）');
  const text = lines.join('\n');
  return text.length > MAX_OUTPUT_LEN ? text.slice(0, MAX_OUTPUT_LEN) + '\n…(结果已截断)' : text;
}

/** 搜索源列表（主源优先，异常逐源降级） */
const SEARCH_SOURCES: Array<{ name: string; buildUrl: (q: string) => string; parse: (html: string) => WebSearchResultItem[] }> = [
  { name: 'duckduckgo', buildUrl: q => `https://duckduckgo.com/html/?q=${encodeURIComponent(q)}`, parse: parseDuckDuckGoHtml },
  { name: 'bing', buildUrl: q => `https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=zh-CN`, parse: parseBingHtml }
];

/**
 * 联网搜索工具执行入口
 * 全链路异常捕获：任何网络/解析异常均降级为「未获取到有效搜索结果」的弱失败返回，
 * 不抛出业务异常、不中断 Agent 执行流程（模型收到失败结果后自动回退无搜索模式继续作答）
 */
export async function webSearchTool(args: any, ctx: ToolContext): Promise<ToolResult> {
  const query = String(args.query ?? '').trim();
  if (!query) {
    return { success: false, output: `${NO_RESULT_PREFIX}：缺少搜索关键词 query`, searchQuery: '' };
  }
  // 关键词长度收敛：超长查询截断，避免构造异常请求
  const q = query.slice(0, 200);

  let lastError = '';
  try {
    for (const source of SEARCH_SOURCES) {
      if (ctx.signal?.aborted) {
        break;
      }
      try {
        const html = await httpGet(source.buildUrl(q), ctx.proxy, ctx.signal);
        const parsed = source.parse(html);
        if (parsed.length === 0) {
          lastError = `${source.name} 返回内容无有效结果`;
          continue;
        }
        const ranked = rankAndLimit(parsed, q);
        ctx.audit.log({ type: 'search', action: 'web_search', target: q, result: 'success', detail: `源=${source.name}，${ranked.length} 条`, sessionId: ctx.sessionId });
        return {
          success: true,
          output: formatOutput(q, ranked),
          searchQuery: q,
          searchResults: ranked.map(({ title, snippet, url }) => ({ title, snippet, url }))
        };
      } catch (err) {
        // 单源失败不阻断：记录后尝试下一源
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
  } catch (err) {
    // 兜底捕获：确保任何异常都不上抛
    lastError = err instanceof Error ? err.message : String(err);
  }

  ctx.audit.log({ type: 'search', action: 'web_search', target: q, result: 'error', detail: lastError || '全部搜索源失败', sessionId: ctx.sessionId });
  return {
    success: false,
    output: `${NO_RESULT_PREFIX}（${ctx.signal?.aborted ? '任务已停止' : lastError || '网络异常'}）。请回退无搜索模式，基于已有知识与本地信息继续完成任务，不要重复搜索。`,
    searchQuery: q
  };
}
