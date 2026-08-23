/**
 * 消息气泡组件（React.memo 增量更新：仅目标消息引用变化时重渲染，其他消息跳过 diff）
 * 差异化视觉样式：用户消息、AI 回复、工具调用步骤
 * V0.6.0 时序化分段渲染：存在 segments 时按实际执行顺序交替展示思考段/工具节点/执行结果；
 * 旧消息（无 segments）回退 reasoning + steps 渲染，兼容历史会话
 * AI 消息附带快捷操作：复制、重新生成
 */
import React, { useMemo, useState } from 'react';
import { ChatMessage, MessageSegment } from '../../src/types';
import { Markdown, copyRichText } from './Markdown';
import { StepBlock } from './StepBlock';

export const MessageBubble = React.memo(
  function MessageBubble({
    message,
    generating,
    onRegenerate
  }: {
    message: ChatMessage;
    generating: boolean;
    onRegenerate?: (text: string) => void;
  }): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const [thinkingOpen, setThinkingOpen] = useState(true);
  const [textExpanded, setTextExpanded] = useState(false);
  const isUser = message.role === 'user';

  // 思考区块：默认展开以展示完整执行链路（V0.6.0），可手动折叠
  const hasReasoning = !!message.reasoning;
  const showThinking = hasReasoning && (generating || thinkingOpen);

  // 长文本默认折叠：超长且不含代码围栏的纯文本消息，避免一次性渲染大量 DOM（流式生成中不折叠）
  const longTextCollapsed =
    !generating &&
    !message.content.includes('```') &&
    message.content.length > LONG_TEXT_LIMIT &&
    !textExpanded;
  const displayContent = longTextCollapsed ? message.content.slice(0, LONG_TEXT_LIMIT) : message.content;
  const expandTextBtn = longTextCollapsed && (
    <button className="text-expand-btn" onClick={() => setTextExpanded(true)}>
      ▾ 展开全文（共 {Math.round(message.content.length / 1000)}K 字符）
    </button>
  );

  // 富文本复制：剪贴板同时写入纯文本与 Markdown 源文本
  const copyAll = () => {
    void copyRichText(message.content, message.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  // 时序化分段渲染（V0.6.0）：思考段/工具节点/执行结果按实际执行顺序交替展示
  if (message.segments && message.segments.length > 0) {
    return renderSegmented(
      message,
      generating,
      displayContent,
      expandTextBtn,
      copied,
      copyAll,
      onRegenerate
    );
  }

  if (isUser) {
    return (
      <div className="message message-user">
        <div className="message-avatar user-avatar">我</div>
        <div className="message-body">
          {message.attachments && message.attachments.length > 0 && (
            <div className="attachment-chips">
              {message.attachments.map((a, i) => (
                <span key={i} className={`attach-chip attach-${a.kind}`} title={a.path}>
                  {a.kind === 'folder' ? '📁' : '📄'} {shortName(a.path)}
                </span>
              ))}
            </div>
          )}
          <div className="bubble user-bubble">
            <Markdown content={displayContent} />
          </div>
          {expandTextBtn}
        </div>
      </div>
    );
  }

  return (
    <div className="message message-assistant">
      <div className="message-avatar ai-avatar">AI</div>
      <div className="message-body">
        {hasReasoning && (
          <div className={`thinking-block${showThinking ? ' thinking-open' : ''}`}>
            <button className="thinking-toggle" onClick={() => setThinkingOpen(o => !o)}>
              <span className="thinking-caret">{showThinking ? '▾' : '▸'}</span>
              <span className="thinking-icon">🧠</span>
              <span className="thinking-label">{generating && showThinking ? '思考中…' : '思考过程'}</span>
            </button>
            {showThinking && (
              <div className="thinking-content scrollable-block">
                {splitThinkingParas(message.reasoning ?? '').map((p, i) => (
                  <p key={i} className="thinking-para">{p}</p>
                ))}
              </div>
            )}
          </div>
        )}
        {message.steps && message.steps.length > 0 && (
          <div className="steps-container">
            {message.steps.map(s => (
              <StepBlock key={s.id} step={s} />
            ))}
          </div>
        )}
        {generating && !message.content && <div className="typing-indicator"><span /><span /><span /></div>}
        {message.content && (
          <div className="bubble ai-bubble">
            <Markdown content={displayContent} live={generating} />
          </div>
        )}
        {expandTextBtn}
        {generating && message.content && <span className="cursor-blink" />}
        {!generating && message.content && (
          <div className="message-actions">
            <button className="action-btn" title="复制回复" onClick={copyAll}>
              {copied ? '✓ 已复制' : '复制'}
            </button>
            {onRegenerate && message.role === 'assistant' && (
              <button
                className="action-btn"
                title="重新生成"
                onClick={() => onRegenerate(message.content)}
              >
                重新生成
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
  },
  // 自定义比较：message 引用不变时跳过重渲染（onRegenerate 为内联闭包，其行为由 message 决定，忽略其引用变化）
  (prev, next) => prev.message === next.message && prev.generating === next.generating
);

/**
 * 时序化分段渲染：思考、工具调用、执行结果按实际执行顺序逐段交替输出
 * 规划步骤（plan）单独置顶展示整体任务状态，segments 保留完整分步执行链路
 */
function renderSegmented(
  message: ChatMessage,
  generating: boolean,
  displayContent: string,
  expandTextBtn: React.ReactNode,
  copied: boolean,
  copyAll: () => void,
  onRegenerate?: (text: string) => void
): React.ReactElement {
  const planSteps = (message.steps ?? []).filter(s => s.type === 'plan');
  return (
    <div className="message message-assistant">
      <div className="message-avatar ai-avatar">AI</div>
      <div className="message-body">
        {planSteps.length > 0 && (
          <div className="steps-container">
            {planSteps.map(s => (
              <StepBlock key={s.id} step={s} />
            ))}
          </div>
        )}
        {message.segments!.map(seg =>
          seg.type === 'reasoning' ? (
            <ReasoningSegment key={seg.id} segment={seg} generating={generating} />
          ) : seg.type === 'insight' ? (
            <InsightSegment key={seg.id} segment={seg} generating={generating} />
          ) : seg.step ? (
            <div key={seg.id} className="steps-container">
              <StepBlock step={seg.step} />
            </div>
          ) : null
        )}
        {generating && !message.content && <div className="typing-indicator"><span /><span /><span /></div>}
        {message.content && (
          <div className="bubble ai-bubble">
            <Markdown content={displayContent} live={generating} />
          </div>
        )}
        {expandTextBtn}
        {generating && message.content && <span className="cursor-blink" />}
        {!generating && message.content && (
          <div className="message-actions">
            <button className="action-btn" title="复制回复" onClick={copyAll}>
              {copied ? '✓ 已复制' : '复制'}
            </button>
            {onRegenerate && message.role === 'assistant' && (
              <button
                className="action-btn"
                title="重新生成"
                onClick={() => onRegenerate(message.content)}
              >
                重新生成
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** 思考分段组件（React.memo：分段内容引用不变时跳过重渲染；默认展开，可独立折叠） */
const ReasoningSegment = React.memo(function ReasoningSegment({
  segment,
  generating
}: {
  segment: MessageSegment;
  generating: boolean;
}): React.ReactElement {
  const [open, setOpen] = useState(true);
  // 语义分段排版（V0.7.0）：按空行拆分为独立段落，段内换行保留，避免内容拥挤堆叠
  const paras = useMemo(
    () => splitThinkingParas(segment.content ?? ''),
    [segment.content]
  );
  return (
    <div className={`thinking-block${open ? ' thinking-open' : ''}`}>
      <button className="thinking-toggle" onClick={() => setOpen(o => !o)}>
        <span className="thinking-caret">{open ? '▾' : '▸'}</span>
        <span className="thinking-icon">🧠</span>
        <span className="thinking-label">{generating && open ? '思考中…' : '思考过程'}</span>
      </button>
      {open && (
        <div className="thinking-content scrollable-block">
          {paras.map((p, i) => (
            <p key={i} className="thinking-para">{p}</p>
          ))}
        </div>
      )}
    </div>
  );
});

/** 推理节点组件（V0.8.0 主干决策结论：轻量样式与正式回复视觉分层；默认展开，可折叠） */
const InsightSegment = React.memo(function InsightSegment({
  segment,
  generating
}: {
  segment: MessageSegment;
  generating: boolean;
}): React.ReactElement {
  const [open, setOpen] = useState(true);
  // 语义分段排版：按空行拆分为独立段落，段内换行保留（与思考区块同一规范）
  const paras = useMemo(
    () => splitThinkingParas(segment.content ?? ''),
    [segment.content]
  );
  return (
    <div className={`insight-block${open ? ' insight-open' : ''}`}>
      <button className="insight-toggle" onClick={() => setOpen(o => !o)}>
        <span className="insight-caret">{open ? '▾' : '▸'}</span>
        <span className="insight-icon">💡</span>
        <span className="insight-label">{generating && open ? '推理中…' : '推理'}</span>
      </button>
      {open && (
        <div className="insight-content">
          {paras.map((p, i) => (
            <p key={i} className="insight-para">{p}</p>
          ))}
        </div>
      )}
    </div>
  );
});

/** 思考内容语义分段：按空行拆分段落，滤除空白段（V0.7.0 分段排版，新旧渲染路径共用） */
function splitThinkingParas(content: string): string[] {
  return content.split(/\n{2,}/).filter(p => p.trim().length > 0);
}

function shortName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** 长文本折叠阈值：超过该字符数且不含代码围栏的纯文本消息默认折叠 */
const LONG_TEXT_LIMIT = 4000;
