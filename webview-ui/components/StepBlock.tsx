/**
 * 执行步骤可视化组件（React.memo 增量更新：仅目标步骤引用变化时重渲染，同消息其他步骤跳过 diff）
 * 展示规划、工具调用、执行结果全链路；终端输出等宽字体风格；
 * 文件修改仅精简展示文件名 + 变更行统计（+N/-N），点击跳转编辑器联动
 */
import React, { useState } from 'react';
import { AgentStep } from '../../src/types';
import { post } from '../vscode';

/** 统计 diff 增删行数 */
function countDiff(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of diff.split('\n')) {
    if (l.startsWith('+ ')) {
      added++;
    } else if (l.startsWith('- ')) {
      removed++;
    }
  }
  return { added, removed };
}

/** 提取文件名（去掉目录前缀） */
function baseName(p?: string): string {
  if (!p) {
    return '文件';
  }
  return p.split(/[\\/]/).pop() ?? p;
}

/** 提取来源域名（联网搜索结果来源弱标注展示；非法 URL 原样返回） */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function StepIcon({ status }: { status: AgentStep['status'] }): React.ReactElement {
  const map: Record<string, string> = {
    pending: '…',
    running: '⟳',
    success: '✓',
    error: '✗',
    waiting: '⏸'
  };
  return <span className={`step-icon step-${status}`}>{map[status] ?? '·'}</span>;
}

export const StepBlock = React.memo(function StepBlock({ step }: { step: AgentStep }): React.ReactElement {
  // V0.8.0 区块折叠：默认展开，可手动收起为单行标题条目（折叠不影响流式内容更新）
  const [blockOpen, setBlockOpen] = useState(true);

  const isTerminal = step.toolName === 'execute_command';
  const isDiff = !!step.diff;
  // 联网搜索节点（V1.5.0）：执行中展示关键词简报，完成后展示结构化精简结果（标题+摘要+来源）
  const isWebSearch = step.toolName === 'web_search';

  let body: React.ReactNode = null;
  if (step.type === 'toolResult' || step.type === 'toolCall') {
    if (isDiff && step.diff) {
      // 精简展示：仅文件名 + 变更行统计，点击跳转编辑器对应文件（不展示全文内容）
      const { added, removed } = countDiff(step.diff);
      body = (
        <div
          className="file-change-node"
          title={`${step.filePath ?? ''}：+${added} 新增 / -${removed} 删除，点击跳转编辑器`}
          onClick={() => {
            if (step.filePath) {
              post({ type: 'editor:open', filePath: step.filePath });
            }
          }}
        >
          <span className="file-change-name">📄 {baseName(step.filePath)}</span>
          {added > 0 && <span className="file-change-stat add">+{added} 新增</span>}
          {removed > 0 && <span className="file-change-stat del">-{removed} 删除</span>}
          <span className="file-change-jump">↗ 跳转编辑器</span>
        </div>
      );
    } else if (isTerminal) {
      body = (
        <div className="terminal-output scrollable-block">
          {step.command && <div className="terminal-command">$ {step.command}</div>}
          <pre>{step.result ?? ''}</pre>
        </div>
      );
    } else if (isWebSearch && step.searchResults && step.searchResults.length > 0) {
      // 搜索完成：默认展示 3-5 条精简结果（标题+核心摘要+来源），整体高度受控（二级滚动），区块折叠复用统一规范
      body = (
        <div className="search-results scrollable-block">
          {step.searchResults.map((r, i) => (
            <div className="search-result-item" key={`${step.id}-${i}`}>
              <a className="search-result-title" href={r.url} title={r.url}>
                {i + 1}. {r.title}
              </a>
              {r.snippet && <div className="search-result-snippet">{r.snippet}</div>}
              <div className="search-result-url">{hostOf(r.url)}</div>
            </div>
          ))}
        </div>
      );
    } else if (isWebSearch && step.type === 'toolCall') {
      // 搜索执行中：加载态（头部图标旋转）+ 当前搜索关键词简报，让用户明确知晓正在执行搜索
      body = step.searchQuery ? <div className="search-query-brief">🔍 正在搜索：{step.searchQuery}</div> : null;
    } else if (step.type === 'toolCall' && step.toolArgs) {
      body = (
        <div className="step-args scrollable-block">
          <pre>{formatArgs(step.toolArgs)}</pre>
        </div>
      );
    } else if (step.result) {
      body = (
        <div className="step-result scrollable-block">
          <pre>{step.result}</pre>
        </div>
      );
    }
  }

  return (
    <div className={`step-block step-${step.status}${blockOpen ? '' : ' block-collapsed'}`}>
      <div className="step-header">
        <StepIcon status={step.status} />
        <span className="step-title">{step.title}</span>
        {step.toolName && <span className="step-tool">{step.toolName}</span>}
        <button className="block-toggle" title={blockOpen ? '折叠' : '展开'} onClick={() => setBlockOpen(o => !o)}>
          <span className="block-caret">{blockOpen ? '▾' : '▸'}</span>
        </button>
      </div>
      {blockOpen && body}
    </div>
  );
});

function formatArgs(args: string): string {
  try {
    const obj = JSON.parse(args);
    return JSON.stringify(obj, null, 2);
  } catch {
    return args;
  }
}
