/**
 * 侧边栏会话列表
 * - 虚拟滚动：仅渲染可视窗口内的条目，100+ 会话依然流畅
 * - 右键菜单标准化：点击外部 / 按 ESC 关闭、位置对齐鼠标坐标
 * - 重命名：自动聚焦、Enter/失焦提交、ESC 取消
 * - 新建按钮、历史会话（时间倒序）、关键词搜索、重命名/删除/导出操作
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { SessionListItem } from '../../src/types';
import { post } from '../vscode';

/** 会话条目固定行高（与 app.css 中 .session-item 高度一致，虚拟滚动计算用） */
const ITEM_HEIGHT = 52;
/** 可视区域外的预渲染行数（减少快速滚动时的白屏） */
const OVERSCAN = 4;

interface Props {
  sessions: SessionListItem[];
  activeId: string | undefined;
  collapsed: boolean;
  /** 抽屉当前宽度（px），可由拖拽调整 */
  width: number;
  onCollapse: () => void;
  onSelect: (id: string) => void;
  onWidthChange: (w: number) => void;
}

/** 抽屉宽度范围（px） */
const MIN_DRAWER_WIDTH = 180;
const MAX_DRAWER_WIDTH = 480;

interface MenuState {
  id: string;
  x: number;
  y: number;
}

export function SessionList({ sessions, activeId, collapsed, width, onCollapse, onSelect, onWidthChange }: Props): React.ReactElement {
  const [keyword, setKeyword] = useState('');
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  // 删除两段式确认：记录待确认的会话 id。VSCode webview 禁用原生 window.confirm（恒返回 undefined），
  // 因此用内联二次确认代替：首次点击进入确认态，再次点击才真正删除。
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  // 虚拟滚动状态
  const [scrollTop, setScrollTop] = useState(0);
  const [listHeight, setListHeight] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const renameDoneRef = useRef(false);

  const filtered = useMemo(
    () => (keyword ? sessions.filter(s => s.title.toLowerCase().includes(keyword.toLowerCase())) : sessions),
    [sessions, keyword]
  );

  // 列表容器高度测量（窗口尺寸变化时同步，虚拟滚动计算依据）。
  // 依赖 collapsed：收起态挂载时列表 DOM 不存在，展开后需重新建立测量；
  // 否则 listHeight 恒为 0，可视窗口退化为 1 行，长列表滚动异常。
  useEffect(() => {
    if (collapsed) {
      return;
    }
    const el = listRef.current;
    if (!el) {
      return;
    }
    const update = () => setListHeight(el.clientHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [collapsed]);

  // 删除确认态自动还原：5 秒内未再次点击则恢复普通「删除」按钮
  useEffect(() => {
    if (!confirmDeleteId) {
      return;
    }
    const timer = setTimeout(() => setConfirmDeleteId(null), 5000);
    return () => clearTimeout(timer);
  }, [confirmDeleteId]);

  // 菜单关闭时同步清除删除确认态，避免状态残留
  useEffect(() => {
    if (!menu) {
      setConfirmDeleteId(null);
    }
  }, [menu]);

  // 菜单全局关闭：点击外部 / 按 ESC
  useEffect(() => {
    if (!menu) {
      return;
    }
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenu(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenu(null);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  // 打开菜单：位置对齐鼠标坐标并限制在视口内
  const openMenu = (e: React.MouseEvent, s: SessionListItem) => {
    e.preventDefault();
    e.stopPropagation();
    const x = Math.max(4, Math.min(e.clientX, window.innerWidth - 132));
    const y = Math.max(4, Math.min(e.clientY, window.innerHeight - 104));
    setMenu({ id: s.id, x, y });
  };

  // 重命名提交（Enter 或失焦触发；renameDoneRef 防止双提交）
  const submitRename = (s: SessionListItem) => {
    if (renameDoneRef.current) {
      return;
    }
    renameDoneRef.current = true;
    post({ type: 'session:rename', sessionId: s.id, title: renameText.trim() || s.title });
    setRenamingId(null);
  };

  const beginRename = (s: SessionListItem) => {
    renameDoneRef.current = false;
    setRenamingId(s.id);
    setRenameText(s.title);
    setMenu(null);
  };

  // 拖拽调整抽屉宽度
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev: MouseEvent) => {
      onWidthChange(Math.min(MAX_DRAWER_WIDTH, Math.max(MIN_DRAWER_WIDTH, startW + (ev.clientX - startX))));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  if (collapsed) {
    // 收起时无残留占位：仅悬浮一个展开把手（覆盖在对话区域左侧）
    return (
      <button className="session-drawer-tab" title="展开会话列表" onClick={onCollapse}>
        ☰
      </button>
    );
  }

  // 虚拟滚动窗口计算
  const total = filtered.length;
  const visibleCount = Math.max(1, Math.ceil(listHeight / ITEM_HEIGHT));
  const startIdx = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - OVERSCAN);
  const endIdx = Math.min(total, startIdx + visibleCount + OVERSCAN * 2);
  const windowItems = filtered.slice(startIdx, endIdx);
  const menuSession = menu ? sessions.find(s => s.id === menu.id) : undefined;

  return (
    <div className="session-list session-drawer" style={{ width }}>
      <div className="session-list-header">
        <span className="session-list-title">历史会话</span>
        <button className="icon-btn" title="新建对话" onClick={() => post({ type: 'session:new' })}>
          ＋
        </button>
        <button className="icon-btn" title="收起列表" onClick={onCollapse}>
          «
        </button>
      </div>
      <div className="session-search">
        <input
          placeholder="🔍 搜索会话"
          value={keyword}
          onChange={e => {
            const v = e.target.value;
            setKeyword(v);
            setMenu(null);
            post({ type: 'session:search', keyword: v });
          }}
        />
      </div>
      <div
        className="session-items"
        ref={listRef}
        onScroll={e => setScrollTop((e.target as HTMLDivElement).scrollTop)}
      >
        {total === 0 && <div className="session-empty">暂无历史会话</div>}
        {total > 0 && (
          <div className="session-items-vscroll" style={{ height: total * ITEM_HEIGHT }}>
            {windowItems.map((s, i) => (
              <div
                key={s.id}
                className={`session-item${s.id === activeId ? ' session-active' : ''}`}
                style={{ position: 'absolute', top: (startIdx + i) * ITEM_HEIGHT, left: 0, right: 0, height: ITEM_HEIGHT }}
                onClick={() => {
                  setMenu(null);
                  onSelect(s.id);
                }}
                onContextMenu={e => openMenu(e, s)}
              >
                <div className="session-item-main">
                  {renamingId === s.id ? (
                    <input
                      className="rename-input"
                      autoFocus
                      value={renameText}
                      onChange={e => setRenameText(e.target.value)}
                      onClick={e => e.stopPropagation()}
                      onBlur={() => submitRename(s)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          submitRename(s);
                        }
                        if (e.key === 'Escape') {
                          renameDoneRef.current = true;
                          setRenamingId(null);
                        }
                      }}
                    />
                  ) : (
                    <div className="session-title" title={s.title}>
                      {s.title}
                    </div>
                  )}
                  <div className="session-meta">
                    {formatTime(s.updatedAt)} · {s.messageCount} 条消息
                  </div>
                </div>
                <button className="session-menu-btn" title="会话操作" onClick={e => openMenu(e, s)}>
                  ⋯
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 右键菜单：fixed 定位对齐鼠标坐标，不随列表滚动/卸载 */}
      {menu && menuSession && (
        <div className="session-menu session-menu-fixed" ref={menuRef} style={{ left: menu.x, top: menu.y }}>
          <button
            onClick={e => {
              e.stopPropagation();
              beginRename(menuSession);
            }}
          >
            重命名
          </button>
          <button
            onClick={e => {
              e.stopPropagation();
              post({ type: 'session:export', sessionId: menuSession.id });
              setMenu(null);
            }}
          >
            导出 JSON
          </button>
          <button
            className="menu-danger"
            onClick={e => {
              e.stopPropagation();
              // 两段式确认：VSCode webview 禁用原生 window.confirm，改用按钮内联二次确认
              if (confirmDeleteId === menuSession.id) {
                post({ type: 'session:delete', sessionId: menuSession.id });
                setConfirmDeleteId(null);
                setMenu(null);
              } else {
                setConfirmDeleteId(menuSession.id);
              }
            }}
          >
            {confirmDeleteId === menuSession.id ? '确认删除？' : '删除'}
          </button>
        </div>
      )}

      {/* 右侧拖拽调整宽度把手 */}
      <div className="session-resize-handle" onMouseDown={startResize} title="拖拽调整列表宽度" />
    </div>
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const pad = (n: number) => String(n).padStart(2, '0');
  if (sameDay) {
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
