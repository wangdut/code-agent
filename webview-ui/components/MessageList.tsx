/**
 * 消息列表虚拟滚动组件
 * 仅渲染视口内的消息区块：动态高度测量（ResizeObserver）+ 预估高度 + 窗口切片
 * 流式生成中自动跟随滚动到底部；打开会话时滚动稳定到底部（高度修正期持续校准）
 * 百轮以上长会话同样保持流畅（DOM 节点数量恒定于视口规模）
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChatMessage, CompressRecord } from '../../src/types';
import { MessageBubble } from './MessageBubble';

/** 未测量消息的预估高度（px），测量后由 ResizeObserver 修正 */
const ESTIMATED_HEIGHT = 160;
/** 视口外预渲染距离（px），减少快速滚动时的空白闪烁 */
const OVERSCAN = 500;
/** .message 的 margin-bottom（app.css），offsetHeight 不含 margin，测量时补偿 */
const MESSAGE_GAP = 16;

interface Props {
  messages: ChatMessage[];
  generating: boolean;
  streamingMessageId?: string;
  summaries: CompressRecord[];
  onViewCompress: () => void;
  onRegenerate: (id: string) => void;
  showTyping: boolean;
}

export function MessageList({
  messages,
  generating,
  streamingMessageId,
  summaries,
  onViewCompress,
  onRegenerate,
  showTyping
}: Props): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const heightsRef = useRef(new Map<string, number>());
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(600);
  const [version, setVersion] = useState(0);
  /** 打开会话后的高度修正稳定期：期间持续校准滚动到底 */
  const pendingScrollRef = useRef(false);

  // ---- V0.7.0 智能滚动：用户干预暂停跟随，静默 5 秒后平滑归位 ----
  /** 跟随模式：follow=新内容自动滚底；paused=用户主动调整视口，暂停跟随 */
  const modeRef = useRef<'follow' | 'paused'>('follow');
  /** 程序滚动标志：区分 scrollToBottom 触发的 scroll 事件与用户拖动 */
  const programmaticRef = useRef(false);
  /** 平滑归位动画中：动画产生的 scroll 事件不计为用户滚动 */
  const smoothRef = useRef(false);
  /** 静默归位计时器 */
  const resumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 归位序列号：用户新干预时递增，使进行中的归位动画兑底恢复失效 */
  const resumeSeqRef = useRef(0);
  /** generating 的 ref 镜像（滚轮/滚动事件处理器读取最新值，避免闭包过期） */
  const generatingRef = useRef(generating);

  // 生成状态同步：新一轮生成开始时恢复默认跟随模式
  useEffect(() => {
    const started = generating && !generatingRef.current;
    generatingRef.current = generating;
    if (started) {
      modeRef.current = 'follow';
      smoothRef.current = false;
    }
  }, [generating]);

  /** 静默超时归位：平滑滚动至最新输出位置，动画结束后恢复跟随 */
  const scheduleResume = useCallback(() => {
    if (resumeTimerRef.current !== null) {
      clearTimeout(resumeTimerRef.current);
    }
    resumeTimerRef.current = setTimeout(() => {
      resumeTimerRef.current = null;
      const el = containerRef.current;
      if (!el || !generatingRef.current) {
        modeRef.current = 'follow';
        return;
      }
      const seq = ++resumeSeqRef.current;
      smoothRef.current = true;
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
      // 兑底恢复：动画结束后解除平滑态恢复跟随（动画期间用户再次干预则不生效，避免打断回看）
      setTimeout(() => {
        if (resumeSeqRef.current === seq) {
          smoothRef.current = false;
          modeRef.current = 'follow';
        }
      }, 800);
    }, 5000);
  }, []);

  /** 用户主动视口调整：立即暂停跟随并重置静默计时器（倒计时内再次滚动重新计时） */
  const markUserScroll = useCallback(() => {
    if (!generatingRef.current) {
      return;
    }
    resumeSeqRef.current++; // 打断进行中的归位动画
    smoothRef.current = false;
    modeRef.current = 'paused';
    scheduleResume();
  }, [scheduleResume]);

  // 滚轮滚动 = 主动视口调整（wheel 先于 scroll 事件触发，保证即时暂停跟随）；
  // 二级滚动子块（V0.8.0）内部滚动不触发全局归位，避免交互冲突
  useEffect(() => {
    const el = containerRef.current;
    if (!el) {
      return;
    }
    const onWheel = (e: WheelEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && typeof t.closest === 'function' && t.closest('.scrollable-block')) {
        return; // 子块内部滚动
      }
      markUserScroll();
    };
    el.addEventListener('wheel', onWheel, { passive: true });
    return () => el.removeEventListener('wheel', onWheel);
  }, [markUserScroll]);

  // 卸载清理静默归位计时器
  useEffect(() => {
    return () => {
      if (resumeTimerRef.current !== null) {
        clearTimeout(resumeTimerRef.current);
      }
    };
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = containerRef.current;
    if (el) {
      const before = el.scrollTop;
      programmaticRef.current = true;
      el.scrollTop = el.scrollHeight;
      setScrollTop(el.scrollTop);
      // 已处于底部时赋值不产生 scroll 事件，主动清除标志防误吞用户后续滚动
      if (el.scrollTop === before) {
        programmaticRef.current = false;
      }
    }
  }, []);

  // 会话切换（首条消息变化）时清空高度缓存并滚动到底
  const firstId = messages[0]?.id ?? '';
  useLayoutEffect(() => {
    heightsRef.current.clear();
    pendingScrollRef.current = true;
    scrollToBottom();
  }, [firstId, scrollToBottom]);

  // 高度修正期：测量值变化时持续校准底部位置，静默后结束稳定期
  useLayoutEffect(() => {
    if (pendingScrollRef.current) {
      scrollToBottom();
    }
  }, [version, scrollToBottom]);
  useEffect(() => {
    if (!pendingScrollRef.current) {
      return;
    }
    const t = setTimeout(() => {
      pendingScrollRef.current = false;
    }, 250);
    return () => clearTimeout(t);
  }, [version]);

  // 容器视口尺寸测量
  useEffect(() => {
    const el = containerRef.current;
    if (!el) {
      return;
    }
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    setViewH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // 高度测量回调：子项高度变化时更新缓存并触发偏移重算
  const onMeasure = useCallback(() => setVersion(v => v + 1), []);

  // 消息偏移表：offsets[i] = 前 i 条消息的累计高度
  const offsets = useMemo(() => {
    const arr: number[] = [0];
    for (const m of messages) {
      const h = heightsRef.current.get(m.id) ?? ESTIMATED_HEIGHT;
      arr.push(arr[arr.length - 1] + h);
    }
    return arr;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, version]);

  const total = offsets[offsets.length - 1];

  // 可见窗口切片计算（含 overscan 预渲染）
  let start = 0;
  while (start < messages.length && offsets[start + 1] <= scrollTop - OVERSCAN) {
    start++;
  }
  let end = start;
  while (end < messages.length && offsets[end] < scrollTop + viewH + OVERSCAN) {
    end++;
  }

  // 流式生成中的消息强制渲染（保证实时内容不因窗口裁剪而丢失）
  const streamIdx = streamingMessageId ? messages.findIndex(m => m.id === streamingMessageId) : -1;
  const forceStream = streamIdx >= 0 && (streamIdx < start || streamIdx >= end);

  const visible = messages.slice(start, end);

  // 流式跟随滚动：生成中最后一条消息内容/高度变化时滚到底部（用户干预暂停期间不打扰）
  const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
  // 分段内容长度计入变化指纹（V0.6.0：思考段流式追加与工具节点插入同样触发跟随滚动）
  const segLen = lastMsg?.segments?.reduce((a, s) => a + (s.content?.length ?? 0) + (s.step?.result?.length ?? 0) + (s.step?.output?.length ?? 0), 0) ?? 0;
  const lastLen = lastMsg
    ? `${lastMsg.id}:${lastMsg.content.length}:${lastMsg.reasoning?.length ?? 0}:${lastMsg.steps?.length ?? 0}:${segLen}`
    : '';
  useEffect(() => {
    if (generating && modeRef.current === 'follow') {
      scrollToBottom();
    }
  }, [generating, lastLen, version, messages.length, scrollToBottom]);

  const onScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) {
      return;
    }
    setScrollTop(el.scrollTop);
    if (smoothRef.current) {
      return; // 平滑归位动画产生的滚动
    }
    if (programmaticRef.current) {
      programmaticRef.current = false; // 程序滚动到底产生的滚动
      return;
    }
    markUserScroll(); // 用户拖动滚动条
  }, [markUserScroll]);

  const renderBubble = (m: ChatMessage) => (
    <MeasuredItem key={m.id} id={m.id} onMeasure={onMeasure} heights={heightsRef.current}>
      <MessageBubble
        message={m}
        generating={generating && streamingMessageId === m.id}
        onRegenerate={m.role === 'assistant' ? () => onRegenerate(m.id) : undefined}
      />
    </MeasuredItem>
  );

  return (
    <div className="message-scroll" ref={containerRef} onScroll={onScroll}>
      <div className="messages">
        {summaries.length > 0 && (
          <div className="summary-banner">
            <span>🧩 本会话包含 {summaries.length} 段早期对话摘要（已压缩）</span>
            <button className="action-btn" onClick={onViewCompress}>
              查看压缩记录
            </button>
          </div>
        )}
        {/* 顶部占位（虚拟滚动） */}
        <div style={{ height: offsets[start] }} />
        {visible.map(renderBubble)}
        {forceStream && streamIdx >= 0 && renderBubble(messages[streamIdx])}
        {/* 底部占位（虚拟滚动） */}
        <div style={{ height: total - offsets[end] }} />
        {showTyping && (
          <div className="message message-assistant">
            <div className="message-avatar ai-avatar">AI</div>
            <div className="message-body">
              <div className="typing-indicator"><span /><span /><span /></div>
            </div>
          </div>
        )}
        <div className="chat-bottom-pad" />
      </div>
    </div>
  );
}

/** 高度测量包装：ResizeObserver 记录每条消息实际渲染高度，用于虚拟滚动偏移计算 */
function MeasuredItem({
  id,
  onMeasure,
  heights,
  children
}: {
  id: string;
  onMeasure: () => void;
  heights: Map<string, number>;
  children: React.ReactNode;
}): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    const ro = new ResizeObserver(() => {
      const h = el.offsetHeight + MESSAGE_GAP;
      if (h > MESSAGE_GAP && heights.get(id) !== h) {
        heights.set(id, h);
        onMeasure();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  return <div ref={ref}>{children}</div>;
}
