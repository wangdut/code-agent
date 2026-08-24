/**
 * 联网搜索工具模块（V1.5.5）
 * 职责：为 Agent 提供自主决策式联网搜索能力 —— 多组查询词互补召回、结果二次相关性校验、多层过滤压缩、结构化注入上下文
 *
 * 设计原则：
 * - 独立封装：搜索为独立工具层，与模型服务商解耦（所有 OpenAI 兼容模型均可用），不触碰文件权限体系
 * - 精准召回：多组差异化查询词互补召回 + 权威信源加权 + 低相关/导航/首页类页面淘汰，搜索动作与任务目标对齐
 * - Token 效率：结果条数动态浮动（2-20，上限硬控制）+ 多层过滤压缩（清洗/摘要/结构化），禁止全量原始网页塞入消息链
 * - 链接直达：过滤首页/域名级链接，链接有效性前置校验（校验异常不误伤召回）
 * - 容错降级：全链路异常捕获（网络不可用/接口失败/解析错误/无有效结果），异常仅记录本地审计日志，
 *   不向上抛出业务异常；失败时弱标注「未获取到有效搜索结果」，Agent 回退无搜索模式继续作答
 */
import * as http from 'http';
import * as https from 'https';
import { WebSearchResultItem } from '../types';
import { ToolContext, ToolResult } from './fileTools';

/** 结果条数动态区间下限（V1.5.5：简单查询至少保留 2 条高相关结果） */
const MIN_RESULTS = 2;
/** 结果条数默认值（Agent 未显式指定 maxResults 时的兜底口径） */
const DEFAULT_MAX_RESULTS = 5;
/** 结果条数动态区间上限（复杂多维度查询可扩展至此，硬上限防止 Token 失控） */
const MAX_RESULTS_UPPER = 20;
/** 单条摘要最大字符数（V1.5.5 摘要密度提升：保留关键参数、代码片段、方案步骤、版本说明等技术细节） */
const SNIPPET_MAX_LEN = 480;
/** 单条标题最大字符数 */
const TITLE_MAX_LEN = 120;
/** 单源请求超时（毫秒）：搜索为辅助能力，短超时避免拖慢任务主链路 */
const SOURCE_TIMEOUT = 15000;
/** 重定向跟随最大跳数：防止搜索源重定向循环导致无限递归 */
const MAX_REDIRECTS = 3;
/** 注入上下文的结果文本总长硬上限（动态条数扩容后仍有严格上限控制，Token 安全兜底） */
const MAX_OUTPUT_LEN = 12000;
/** 差异化备选查询词上限（单次搜索多组查询词互补召回，避免单一关键词信息偏差） */
const MAX_ALT_QUERIES = 2;
/** 链接有效性校验单链接超时（毫秒）：轻量 HEAD 探测，不拖慢主链路 */
const LINK_CHECK_TIMEOUT = 5000;
/** 二次相关性校验最低分（低于该分视为低相关淘汰；候选不足时放宽保证基础召回） */
const RELEVANT_MIN_SCORE = 1;

/** 结构化搜索结果（附带相关性评分，供淘汰排序） */
interface ScoredResult extends WebSearchResultItem {
  score: number;
}

/** 权威高信源域名（官方文档/权威技术社区/开源仓库）：二次排序加权，降低低质量内容权重 */
const AUTHORITATIVE_HOST_PATTERNS = [
  'github.com', 'gitlab.com', 'stackoverflow.com', 'stackexchange.com',
  'developer.mozilla.org', 'learn.microsoft.com', 'docs.microsoft.com',
  'docs.python.org', 'developer.android.com', 'developer.apple.com', 'developer.chrome.com',
  'react.dev', 'nodejs.org', 'typescriptlang.org', 'webpack.js.org', 'vitejs.dev', 'vuejs.org',
  'kubernetes.io', 'docker.com', 'code.visualstudio.com', 'docs.oracle.com', 'docs.spring.io',
  'juejin.cn', 'segmentfault.com', 'cnblogs.com', 'oschina.net', 'developer.aliyun.com'
];

/** 导航/广告/跳转中转类无效链接特征（二次校验淘汰，仅保留可直达详情页的结果） */
const NOISE_URL_PATTERNS = [/\/redirect/i, /\bad[sv]?\.doubleclick\b/i, /\/(tags?|category|categories|topics)\/[^/]*\/?$/i, /\?ref=/i];

/** 常规浏览器 UA：避免被搜索源/目标站点按爬虫直接拒绝 */
const UA_BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

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
          'User-Agent': UA_BROWSER,
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

/** 链接直达性校验：剔除首页/域名级与导航/广告中转链接（无详情页可直达） */
function isDirectLink(url: string): boolean {
  if (NOISE_URL_PATTERNS.some(p => p.test(url))) {
    return false;
  }
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, '');
    return path.length > 0 || u.search.length > 0;
  } catch {
    return false;
  }
}

/**
 * 链接可达性轻量探测（HEAD 优先，被拒时降级 GET 仅取状态码，不读取正文）
 * 2xx/3xx 视为可达，4xx/5xx 死链淘汰；全异常 reject 由上层收敛
 */
function probeUrl(url: string, proxy: string | undefined, signal?: AbortSignal, depth = 0, method: 'HEAD' | 'GET' = 'HEAD'): Promise<void> {
  return new Promise((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      reject(new Error('无效链接'));
      return;
    }
    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
      reject(new Error('不支持的链接协议'));
      return;
    }
    const mod = target.protocol === 'https:' ? https : http;
    const agent = target.protocol === 'https:' ? getProxyAgent(proxy) : undefined;
    const req = mod.request(
      target,
      {
        method,
        headers: { 'User-Agent': UA_BROWSER, Accept: 'text/html,*/*' },
        timeout: LINK_CHECK_TIMEOUT,
        ...(agent ? { agent } : {})
      },
      res => {
        res.resume();
        const status = res.statusCode ?? 0;
        if (status >= 200 && status < 300) {
          resolve();
          return;
        }
        // 重定向链跟随（带深度护栏）：确保最终落地页可达而非无效跳转
        if (status >= 300 && status < 400 && res.headers.location) {
          if (depth >= MAX_REDIRECTS) {
            reject(new Error('链接重定向次数超限'));
            return;
          }
          try {
            probeUrl(new URL(res.headers.location, target).toString(), proxy, signal, depth + 1, method).then(resolve, reject);
          } catch {
            reject(new Error('链接重定向地址无效'));
          }
          return;
        }
        // 部分站点拒绝 HEAD（403/405/501）：降级 GET 复核一次，避免误杀有效链接
        if (method === 'HEAD' && (status === 403 || status === 405 || status === 501)) {
          probeUrl(url, proxy, signal, depth, 'GET').then(resolve, reject);
          return;
        }
        reject(new Error(`链接失效 (HTTP ${status})`));
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error('链接校验超时'));
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

/**
 * 链接有效性前置校验（并行探测，过滤死链/无效跳转）
 * 校验全部失败时（如探测出口受限）保留原结果降级，不误伤召回
 */
async function validateLinks(items: ScoredResult[], proxy: string | undefined, signal?: AbortSignal): Promise<ScoredResult[]> {
  if (items.length === 0) {
    return items;
  }
  try {
    const alive = await Promise.all(
      items.map(async it => {
        try {
          await probeUrl(it.url, proxy, signal);
          return true;
        } catch {
          return false;
        }
      })
    );
    const kept = items.filter((_, i) => alive[i]);
    return kept.length > 0 ? kept : items;
  } catch {
    return items;
  }
}

/**
 * 二次相关性校验与重排序（V1.5.5 召回质量优化）：
 * - 链接直达性预筛（首页/域名级/导航广告类淘汰，误杀过多时放宽保证基础召回）
 * - 多组查询词语义匹配打分（标题命中加权，多组共同命中额外加权）
 * - 权威高信源（官方文档/权威社区/开源仓库）加权，低质量内容降权
 * - 零相关低价值页面淘汰（候选不足时放宽）；URL 去重后按动态条数上限截取
 */
function rankAndLimit(items: WebSearchResultItem[], queries: string[], maxResults: number): ScoredResult[] {
  const direct = items.filter(it => isDirectLink(it.url));
  const work = direct.length >= MIN_RESULTS ? direct : items;
  const tokenSets = queries.map(tokenize);
  const scored: ScoredResult[] = work.map(it => {
    const haystackTitle = it.title.toLowerCase();
    const haystackBody = `${it.title} ${it.snippet}`.toLowerCase();
    let score = 0;
    for (const tokens of tokenSets) {
      for (const t of tokens) {
        if (haystackTitle.includes(t)) {
          score += 2;
        } else if (haystackBody.includes(t)) {
          score += 1;
        }
      }
    }
    // 查询短语整体命中额外加权（任一组命中即可）
    for (const query of queries) {
      if (query && haystackBody.includes(query.toLowerCase())) {
        score += 3;
        break;
      }
    }
    // 权威高信源加权：官方文档、权威技术社区、开源仓库优先
    try {
      const host = new URL(it.url).hostname.toLowerCase();
      if (AUTHORITATIVE_HOST_PATTERNS.some(p => host === p || host.endsWith(`.${p}`))) {
        score += 3;
      }
    } catch {
      /* 非法 URL 不加权 */
    }
    return { ...it, score };
  });
  // 低相关淘汰：零分页面剔除；候选池不足下限时放宽保证基础召回
  const relevant = scored.filter(s => s.score >= RELEVANT_MIN_SCORE);
  const pool = relevant.length >= MIN_RESULTS ? relevant : scored;
  pool.sort((a, b) => b.score - a.score);
  // URL 去重（多组查询互补召回的跨源重复条目淘汰）
  const seen = new Set<string>();
  const out: ScoredResult[] = [];
  for (const s of pool) {
    if (seen.has(s.url) || out.length >= maxResults) {
      continue;
    }
    seen.add(s.url);
    out.push(s);
  }
  return out;
}

/** 结构化层：整理为「标题+核心摘要+来源链接」标准化文本，保留段落层级统一格式注入上下文 */
function formatOutput(query: string, results: ScoredResult[]): string {
  const lines: string[] = [`# 联网搜索 "${query}" 结果（${results.length} 条精简摘要，均已经过链接有效性校验）`];
  results.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.title}`);
    if (r.snippet) {
      lines.push(`   摘要: ${r.snippet}`);
    }
    lines.push(`   来源: ${r.url}`);
  });
  lines.push('（以上为搜索精简摘要，请结合任务甄别时效性与准确性；如信息不足可调整关键词二次检索，勿重复相同关键词）');
  const text = lines.join('\n');
  return text.length > MAX_OUTPUT_LEN ? text.slice(0, MAX_OUTPUT_LEN) + '\n…(结果已截断)' : text;
}

/** 搜索源列表（主源优先，异常逐源降级） */
const SEARCH_SOURCES: Array<{ name: string; buildUrl: (q: string) => string; parse: (html: string) => WebSearchResultItem[] }> = [
  { name: 'duckduckgo', buildUrl: q => `https://duckduckgo.com/html/?q=${encodeURIComponent(q)}`, parse: parseDuckDuckGoHtml },
  { name: 'bing', buildUrl: q => `https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=zh-CN`, parse: parseBingHtml }
];

/**
 * 联网搜索工具执行入口（V1.5.5）
 * 链路：多组查询词互补召回 → 二次相关性校验重排 → 动态条数截取 → 链接有效性前置校验 → 结构化注入
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
  // 差异化查询集（互补召回）：主查询词 + 至多 MAX_ALT_QUERIES 组备选，去重
  const queries = [q];
  if (Array.isArray(args.altQueries)) {
    for (const a of args.altQueries) {
      const s = String(a ?? '').trim().slice(0, 200);
      if (s && !queries.includes(s) && queries.length < 1 + MAX_ALT_QUERIES) {
        queries.push(s);
      }
    }
  }
  // 动态结果条数（2-20）：Agent 按任务复杂度自主决定，非法值回退默认口径
  const parsedLimit = Number.parseInt(String(args.maxResults ?? ''), 10);
  const maxResults = Number.isFinite(parsedLimit)
    ? Math.min(MAX_RESULTS_UPPER, Math.max(MIN_RESULTS, parsedLimit))
    : DEFAULT_MAX_RESULTS;

  let lastError = '';
  try {
    // 多组查询词逐组召回：候选池按 URL 去重累加，单组异常不阻断后续组；候选池足够时提前停止
    const candidates: WebSearchResultItem[] = [];
    const seenUrl = new Set<string>();
    let sourceName = '';
    for (const cur of queries) {
      if (ctx.signal?.aborted) {
        break;
      }
      for (const source of SEARCH_SOURCES) {
        if (ctx.signal?.aborted) {
          break;
        }
        try {
          const html = await httpGet(source.buildUrl(cur), ctx.proxy, ctx.signal);
          const parsedItems = source.parse(html);
          if (parsedItems.length === 0) {
            lastError = `${source.name} 返回内容无有效结果`;
            continue;
          }
          sourceName = source.name;
          for (const it of parsedItems) {
            if (!seenUrl.has(it.url)) {
              seenUrl.add(it.url);
              candidates.push(it);
            }
          }
          lastError = '';
          break; // 当前查询组召回成功（双源降级链已生效），继续下一组互补补充
        } catch (err) {
          // 单源失败不阻断：记录后尝试下一源
          lastError = err instanceof Error ? err.message : String(err);
        }
      }
      // 候选池足以支撑二次校验淘汰即提前停止，避免冗余请求
      if (candidates.length >= maxResults * 2) {
        break;
      }
    }
    if (candidates.length > 0) {
      // 二次相关性校验重排 + 动态条数截取 + 链接有效性前置校验（全部异常兜底，不上抛）
      const ranked = await validateLinks(rankAndLimit(candidates, queries, maxResults), ctx.proxy, ctx.signal);
      if (ranked.length > 0) {
        ctx.audit.log({ type: 'search', action: 'web_search', target: queries.join(' | '), result: 'success', detail: `源=${sourceName}，查询 ${queries.length} 组，${ranked.length} 条`, sessionId: ctx.sessionId });
        return {
          success: true,
          output: formatOutput(q, ranked),
          searchQuery: q,
          searchResults: ranked.map(({ title, snippet, url }) => ({ title, snippet, url }))
        };
      }
      lastError = lastError || '相关性校验后无高价值结果';
    }
  } catch (err) {
    // 兜底捕获：确保任何异常都不上抛
    lastError = err instanceof Error ? err.message : String(err);
  }

  ctx.audit.log({ type: 'search', action: 'web_search', target: queries.join(' | '), result: 'error', detail: lastError || '全部搜索源失败', sessionId: ctx.sessionId });
  return {
    success: false,
    output: `${NO_RESULT_PREFIX}（${ctx.signal?.aborted ? '任务已停止' : lastError || '网络异常'}）。请回退无搜索模式，基于已有知识与本地信息继续完成任务；若确认信息缺口仍存在，可调整关键词后再次检索，勿重复相同关键词。`,
    searchQuery: q
  };
}
