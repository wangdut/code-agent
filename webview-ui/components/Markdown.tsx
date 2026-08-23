/**
 * 轻量 Markdown 渲染器
 * 支持：标题、粗体/斜体、行内代码、代码块（语法高亮 + 行号 + 复制按钮）、
 * 有序/无序列表、表格、引用、链接、分隔线、深浅主题自适应
 * 富文本复制：剪贴板同时写入纯文本与 Markdown 源文本
 */
import React, { useMemo, useState } from 'react';

/**
 * 富文本复制：同时写入纯文本与 Markdown 源文本
 * VSCode 编辑器粘贴时优先取 text/markdown，其他场景降级纯文本
 */
export async function copyRichText(plain: string, markdown: string): Promise<void> {
  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([plain], { type: 'text/plain' }),
          'text/markdown': new Blob([markdown], { type: 'text/markdown' })
        })
      ]);
      return;
    }
  } catch {
    // ClipboardItem 不可用或写入失败时降级
  }
  await navigator.clipboard.writeText(plain);
}

function CopyButton({ plain, markdown }: { plain: string; markdown: string }): React.ReactElement {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="copy-btn"
      title="复制（含 Markdown 格式）"
      onClick={() => {
        void copyRichText(plain, markdown).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? '✓ 已复制' : '复制'}
    </button>
  );
}

/** 代码块折叠行数阈值：超过该行数默认仅渲染前 N 行，减少一次性 DOM 节点数量 */
const CODE_COLLAPSE_LINES = 30;

/** 代码块组件：支持超长代码默认折叠（流式生成中不折叠，保证实时可见） */
function CodeBlock({ lang, code, codeLines, live }: { lang: string; code: string; codeLines: string[]; live: boolean }): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const collapsed = !live && !expanded && codeLines.length > CODE_COLLAPSE_LINES;
  const shown = collapsed ? codeLines.slice(0, CODE_COLLAPSE_LINES) : codeLines;
  return (
    <div className="code-block">
      <div className="code-block-head">
        {lang && <div className="code-lang">{lang}</div>}
        <CopyButton plain={code} markdown={'```' + (lang || '') + '\n' + code + '\n```'} />
      </div>
      <pre className="code-pre">
        <code>
          {shown.map((l, li) => (
            <span className="code-line" key={li}>
              <span className="code-line-num">{li + 1}</span>
              <span className="code-line-text">{highlightLine(l, lang, `l${li}`)}</span>
            </span>
          ))}
        </code>
      </pre>
      {collapsed && (
        <button className="code-expand-btn" onClick={() => setExpanded(true)}>
          ▾ 展开全部 {codeLines.length} 行
        </button>
      )}
    </div>
  );
}

// ---------- 语法高亮（自研轻量 tokenizer） ----------

const KEYWORD_PATTERNS: Record<string, string> = {
  js: '\\b(?:const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|import|export|from|default|class|extends|new|this|super|async|await|try|catch|finally|throw|typeof|instanceof|in|of|delete|void|yield|null|undefined|true|false)\\b',
  py: '\\b(?:def|return|if|elif|else|for|while|import|from|class|try|except|finally|with|as|lambda|None|True|False|and|or|not|in|is|raise|pass|break|continue|yield|async|await|global|nonlocal|del|assert|self|print)\\b',
  sh: '\\b(?:if|then|else|fi|for|while|do|done|case|esac|in|function|echo|exit|return|local|export|source|cd|ls|mkdir|rm|mv|cp|cat|grep|sed|awk|sudo|chmod|chown|git|npm|node|python|set|unset)\\b',
  json: '\\b(?:true|false|null)\\b',
  java: '\\b(?:public|private|protected|static|final|class|interface|extends|implements|void|int|long|double|float|boolean|char|String|return|if|else|for|while|new|this|super|try|catch|finally|throw|throws|import|package|null|true|false)\\b',
  go: '\\b(?:func|package|import|return|if|else|for|range|var|const|type|struct|interface|map|chan|go|defer|select|switch|case|break|continue|nil|true|false)\\b',
  rust: '\\b(?:fn|let|mut|pub|struct|enum|impl|trait|match|if|else|for|while|loop|return|use|mod|self|Self|true|false|Some|None|Ok|Err|async|await)\\b',
  cpp: '\\b(?:int|long|short|char|float|double|bool|void|unsigned|signed|const|static|struct|class|template|typename|namespace|using|return|if|else|for|while|switch|case|break|continue|new|delete|this|public|private|protected|virtual|override|nullptr|true|false|auto)\\b',
  html: '\\b(?:div|span|p|a|img|ul|ol|li|table|tr|td|th|head|body|html|script|style|link|meta|title|h1|h2|h3|h4|h5|h6|button|input|form|class|id|href|src)\\b',
  css: '\\b(?:color|background|display|flex|grid|margin|padding|border|width|height|font|position|absolute|relative|fixed|top|left|right|bottom|z-index|overflow|text-align|justify-content|align-items|transition|animation)\\b'
};

/** 语言别名归一化 */
function langKey(lang: string): string {
  const l = lang.toLowerCase();
  if (['js', 'jsx', 'ts', 'tsx', 'javascript', 'typescript', 'mjs', 'cjs'].includes(l)) {
    return 'js';
  }
  if (['py', 'python', 'python3'].includes(l)) {
    return 'py';
  }
  if (['sh', 'bash', 'shell', 'zsh', 'powershell', 'ps1', 'cmd', 'bat', 'terminal'].includes(l)) {
    return 'sh';
  }
  if (['json', 'jsonc', 'yaml', 'yml', 'toml'].includes(l)) {
    return l === 'jsonc' ? 'json' : l;
  }
  if (['c', 'cpp', 'cc', 'cxx', 'h', 'hpp', 'c++'].includes(l)) {
    return 'cpp';
  }
  if (['golang'].includes(l)) {
    return 'go';
  }
  return l;
}

/** 行级 token 化：字符串 / 行注释 / 数字优先，其余部分再匹配关键字 */
function highlightLine(line: string, lang: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // 每次创建新正则实例，避免共享 lastIndex 状态（复用同一实例会漏匹配）
  const re = new RegExp("(\\/\\/[^\\n]*|#[^\\n]*|'[^']*'|\"[^\"]*\"|`[^`]*`|\\b\\d+(?:\\.\\d+)?\\b)", 'g');
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(line))) {
    if (m.index > last) {
      nodes.push(...keywordize(line.slice(last, m.index), lang, `${keyPrefix}-w${k}`));
    }
    const token = m[0];
    const cls =
      token.startsWith('//') || token.startsWith('#')
        ? 'tok-comment'
        : token.startsWith("'") || token.startsWith('"') || token.startsWith('`')
          ? 'tok-string'
          : 'tok-number';
    nodes.push(
      <span key={`${keyPrefix}-s${k}`} className={cls}>
        {token}
      </span>
    );
    last = m.index + token.length;
    k++;
  }
  if (last < line.length) {
    nodes.push(...keywordize(line.slice(last), lang, `${keyPrefix}-e`));
  }
  return nodes;
}

function keywordize(text: string, lang: string, keyPrefix: string): React.ReactNode[] {
  const pattern = KEYWORD_PATTERNS[langKey(lang)];
  if (!pattern) {
    return [
      <span key={keyPrefix} className="tok-plain">
        {text}
      </span>
    ];
  }
  const nodes: React.ReactNode[] = [];
  const re = new RegExp(pattern, 'g');
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) {
      nodes.push(
        <span key={`${keyPrefix}-t${k}`} className="tok-plain">
          {text.slice(last, m.index)}
        </span>
      );
    }
    nodes.push(
      <span key={`${keyPrefix}-k${k}`} className="tok-keyword">
        {m[0]}
      </span>
    );
    last = m.index + m[0].length;
    k++;
  }
  if (last < text.length) {
    nodes.push(
      <span key={`${keyPrefix}-end`} className="tok-plain">
        {text.slice(last)}
      </span>
    );
  }
  return nodes;
}

// ---------- 行内渲染 ----------

function inline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // 按行内代码切分
  const parts = text.split(/(`[^`]+`)/g);
  parts.forEach((part, i) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      nodes.push(
        <code className="inline-code" key={`${keyPrefix}-c${i}`}>
          {part.slice(1, -1)}
        </code>
      );
      return;
    }
    // 粗体/斜体/链接
    const sub = part.split(/(\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]*\))/g);
    sub.forEach((s, j) => {
      if (s.startsWith('**') && s.endsWith('**') && s.length > 4) {
        nodes.push(
          <strong key={`${keyPrefix}-b${i}-${j}`}>{s.slice(2, -2)}</strong>
        );
      } else if (s.startsWith('*') && s.endsWith('*') && s.length > 2 && !s.startsWith('**')) {
        nodes.push(<em key={`${keyPrefix}-i${i}-${j}`}>{s.slice(1, -1)}</em>);
      } else if (s.startsWith('[') && s.includes('](')) {
        const m = s.match(/\[([^\]]+)\]\(([^)]*)\)/);
        if (m) {
          nodes.push(
            <a key={`${keyPrefix}-a${i}-${j}`} href={m[2]} title={m[2]}>
              {m[1]}
            </a>
          );
        } else {
          nodes.push(<span key={`${keyPrefix}-t${i}-${j}`}>{s}</span>);
        }
      } else if (s) {
        nodes.push(<span key={`${keyPrefix}-t${i}-${j}`}>{s}</span>);
      }
    });
  });
  return nodes;
}

// ---------- 主渲染 ----------

export function Markdown({ content, live }: { content: string; live?: boolean }): React.ReactElement {
  const blocks = useMemo(() => {
    const lines = content.split('\n');
    const out: React.ReactNode[] = [];
    let i = 0;
    let listItems: string[] = [];
    let ordered = false;

    const flushList = () => {
      if (listItems.length > 0) {
        const items = [...listItems];
        if (ordered) {
          out.push(
            <ol key={`ol-${out.length}`}>
              {items.map((it, k) => (
                <li key={k}>{inline(it, `li${k}`)}</li>
              ))}
            </ol>
          );
        } else {
          out.push(
            <ul key={`ul-${out.length}`}>
              {items.map((it, k) => (
                <li key={k}>{inline(it, `li${k}`)}</li>
              ))}
            </ul>
          );
        }
        listItems = [];
      }
    };

    while (i < lines.length) {
      const line = lines[i];
      // 代码块
      if (line.trim().startsWith('```')) {
        flushList();
        const lang = line.trim().slice(3).trim();
        const codeLines: string[] = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith('```')) {
          codeLines.push(lines[i]);
          i++;
        }
        i++; // 跳过结束 ```
        const code = codeLines.join('\n');
        out.push(<CodeBlock key={`cb-${out.length}`} lang={lang} code={code} codeLines={codeLines} live={!!live} />);
        continue;
      }
      // 表格：当前行含 |，下一行为分隔行（---）
      if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
        flushList();
        const headerCells = splitTableRow(line);
        const alignCells = splitTableRow(lines[i + 1]);
        const aligns = alignCells.map(c => {
          const t = c.trim();
          if (t.startsWith(':') && t.endsWith(':')) {
            return 'center' as const;
          }
          if (t.endsWith(':')) {
            return 'right' as const;
          }
          return 'left' as const;
        });
        const rows: string[][] = [headerCells];
        i += 2;
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
          rows.push(splitTableRow(lines[i]));
          i++;
        }
        out.push(
          <div className="markdown-table-wrap" key={`tb-${out.length}`}>
            <table className="markdown-table">
              <thead>
                <tr>
                  {headerCells.map((c, ci) => (
                    <th key={ci} style={{ textAlign: aligns[ci] ?? 'left' }}>
                      {inline(c.trim(), `th${ci}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.slice(1).map((r, ri) => (
                  <tr key={ri}>
                    {headerCells.map((_, ci) => (
                      <td key={ci} style={{ textAlign: aligns[ci] ?? 'left' }}>
                        {inline((r[ci] ?? '').trim(), `td${ri}-${ci}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
        continue;
      }
      // 列表
      const ulMatch = line.match(/^\s*[-*+]\s+(.*)$/);
      const olMatch = line.match(/^\s*\d+\.\s+(.*)$/);
      if (ulMatch) {
        flushList();
        ordered = false;
        listItems.push(ulMatch[1]);
        i++;
        continue;
      }
      if (olMatch) {
        flushList();
        ordered = true;
        listItems.push(olMatch[1]);
        i++;
        continue;
      }
      flushList();
      // 标题
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) {
        const level = h[1].length;
        const text = h[2];
        out.push(
          React.createElement(`h${Math.min(level + 1, 4)}`, { key: `h-${out.length}` }, inline(text, `h${out.length}`))
        );
        i++;
        continue;
      }
      // 引用
      if (line.trim().startsWith('>')) {
        const quoteLines: string[] = [];
        while (i < lines.length && lines[i].trim().startsWith('>')) {
          quoteLines.push(lines[i].trim().replace(/^>\s?/, ''));
          i++;
        }
        out.push(
          <blockquote key={`q-${out.length}`}>
            {quoteLines.map((q, k) => (
              <p key={k}>{inline(q, `q${k}`)}</p>
            ))}
          </blockquote>
        );
        continue;
      }
      // 分隔线
      if (/^\s*([-*_]\s*){3,}$/.test(line)) {
        out.push(<hr key={`hr-${out.length}`} />);
        i++;
        continue;
      }
      // 空行
      if (!line.trim()) {
        i++;
        continue;
      }
      // 普通段落（合并连续行）
      const paraLines: string[] = [line];
      i++;
      while (
        i < lines.length &&
        lines[i].trim() &&
        !lines[i].trim().startsWith('```') &&
        !lines[i].trim().startsWith('>') &&
        !lines[i].match(/^(#{1,4})\s+/) &&
        !lines[i].match(/^\s*[-*+]\s+/) &&
        !lines[i].match(/^\s*\d+\.\s+/) &&
        !/^\s*([-*_]\s*){3,}$/.test(lines[i]) &&
        !(lines[i].includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]))
      ) {
        paraLines.push(lines[i]);
        i++;
      }
      out.push(<p key={`p-${out.length}`}>{inline(paraLines.join(' '), `p${out.length}`)}</p>);
    }
    flushList();
    return out;
    // live 变化需重新解析：流式结束（live true→false）后超长代码块自动进入折叠态
  }, [content, live]);

  return <div className="markdown">{blocks}</div>;
}

/** 拆分表格行（去除首尾空单元格） */
function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) {
    s = s.slice(1);
  }
  if (s.endsWith('|')) {
    s = s.slice(0, -1);
  }
  return s.split('|');
}
