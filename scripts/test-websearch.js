/**
 * 联网搜索源可用性冒烟测试（V1.5.0）
 * 验证 web_search 工具的搜索源可达性与结果解析有效性（离线/断网环境下会如实报告失败）
 * 用法：node scripts/test-websearch.js [关键词]
 */
const https = require('https');

const query = process.argv[2] || 'VSCode extension API';

function httpGet(url, depth = 0) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      new URL(url),
      {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
        },
        timeout: 15000
      },
      res => {
        // 3xx 跳转：与工具实现一致，手动跟随一跳
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (depth >= 3) {
            reject(new Error('重定向次数超限'));
            return;
          }
          try {
            const next = new URL(res.headers.location, url).toString();
            httpGet(next, depth + 1).then(resolve, reject);
          } catch {
            reject(new Error(`搜索源重定向地址无效 (HTTP ${res.statusCode})`));
          }
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error('超时')));
    req.on('error', reject);
    req.end();
  });
}

function strip(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseDdg(html) {
  const out = [];
  const blocks = html.split(/class="[^"]*result results_links/).slice(1);
  for (const block of blocks) {
    const link = block.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    const snippet = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    let url = link[1];
    try {
      const u = new URL(url.startsWith('//') ? `https:${url}` : url);
      const uddg = u.searchParams.get('uddg');
      url = uddg ? decodeURIComponent(uddg) : u.toString();
    } catch { /* 保持原样 */ }
    out.push({ title: strip(link[2]).slice(0, 100), snippet: strip(snippet ? snippet[1] : '').slice(0, 120), url });
  }
  return out;
}

function parseBing(html) {
  const out = [];
  const blocks = html.split(/<li[^>]*class="[^"]*b_algo/).slice(1);
  for (const block of blocks) {
    const link = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    const snippet = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    out.push({ title: strip(link[2]).slice(0, 100), snippet: strip(snippet ? snippet[1] : '').slice(0, 120), url: link[1] });
  }
  return out;
}

(async () => {
  const sources = [
    { name: 'DuckDuckGo（主源）', url: `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`, parse: parseDdg },
    { name: 'Bing（备源）', url: `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-CN`, parse: parseBing }
  ];
  let ok = false;
  for (const s of sources) {
    console.log(`\n=== ${s.name} ===`);
    try {
      const html = await httpGet(s.url);
      const results = s.parse(html);
      console.log(`解析到 ${results.length} 条结果（页面体积 ${(html.length / 1024).toFixed(1)} KB）`);
      results.slice(0, 3).forEach((r, i) => {
        console.log(`${i + 1}. ${r.title}`);
        console.log(`   摘要: ${r.snippet}`);
        console.log(`   来源: ${r.url}`);
      });
      if (results.length > 0) {
        ok = true;
      } else {
        console.log('⚠ 可达但解析到 0 条结果（页面结构可能变化或被反爬拦截）');
      }
    } catch (err) {
      console.log(`✗ 请求失败: ${err.message}`);
    }
  }
  console.log(ok ? '\n✓ 至少一个搜索源可用，web_search 工具链路正常' : '\n✗ 全部搜索源不可用（工具将按设计降级为「未获取到有效搜索结果」）');
})();
