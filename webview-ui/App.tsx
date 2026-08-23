/**
 * 主应用组件
 * 布局：侧边栏会话列表 + 主区域对话面板
 * 面板分区：顶部功能按钮区 / 对话内容滚动区 / 底部输入与快捷操作区
 */
import React, { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import {
  AgentStep, AttachedFileRef, ChatMessage, CompressRecord, ExtensionToWebviewMessage, ImageRef,
  PermissionRequest, RunMode, Session, SessionContextStats, SessionListItem, SettingsSnapshot
} from '../src/types';
import { post, vscodeApi } from './vscode';
import { SessionList } from './components/SessionList';
import { HeaderBar } from './components/HeaderBar';
import { MessageList } from './components/MessageList';
import { InputArea } from './components/InputArea';

// 非核心模块懒加载：仅在首次需要时执行模块体（设置面板 / 权限弹窗），降低冷启动开销
const SettingsPanel = lazy(() => import('./components/SettingsPanel').then(m => ({ default: m.SettingsPanel })));
const PermissionModal = lazy(() => import('./components/PermissionModal').then(m => ({ default: m.PermissionModal })));

/** 就绪握手超时时间（毫秒） */
const BOOT_TIMEOUT = 5000;

type BootState = 'booting' | 'ready' | 'failed';

interface StreamingState {
  sessionId: string;
  messageId: string;
}

interface UsageState {
  today: { inputTokens: number; outputTokens: number; totalTokens: number; requests: number } | null;
  balance?: string;
  balanceError?: string;
}

export function App(): React.ReactElement {
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [stats, setStats] = useState<SessionContextStats | null>(null);
  const [settings, setSettings] = useState<SettingsSnapshot | null>(null);
  const [pendingRequests, setPendingRequests] = useState<PermissionRequest[]>([]);
  const [streaming, setStreaming] = useState<StreamingState | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [listCollapsed, setListCollapsed] = useState(false);
  const [listWidth, setListWidth] = useState(240);
  const [usage, setUsage] = useState<UsageState | null>(null);
  const [compressViewer, setCompressViewer] = useState<CompressRecord | null>(null);
  const [errorToast, setErrorToast] = useState<string | null>(null);
  /** 运行期轻量提示（如 429 限流退避等待）：流式内容恢复/结束或超时后自动消失 */
  const [noticeToast, setNoticeToast] = useState<string | null>(null);
  /** 编辑器右键注入的选区引用（传递给 InputArea 追加为附件） */
  const [injectRefs, setInjectRefs] = useState<AttachedFileRef[]>([]);

  // 打开设置面板时自动拉取最新今日用量与账户余额（V0.6.0：数据实时性，面板挂载即刷新）
  useEffect(() => {
    if (showSettings) {
      post({ type: 'usage:query' });
    }
  }, [showSettings]);

  // 冷启动握手状态机：webview 发 ready → 等待宿主 boot:ack（核心模块就绪确认）
  const [bootState, setBootState] = useState<BootState>('booting');
  const bootRetriedRef = useRef(false);
  const bootTimerRef = useRef<ReturnType<typeof setTimeout>>();

  // 启动握手：发 ready 并启动超时计时；超时或宿主就绪失败时自动重试 1 次
  const startBoot = useCallback(() => {
    setBootState('booting');
    clearTimeout(bootTimerRef.current);
    bootTimerRef.current = setTimeout(() => {
      if (!bootRetriedRef.current) {
        bootRetriedRef.current = true;
        post({ type: 'ready' });
        bootTimerRef.current = setTimeout(() => setBootState('failed'), BOOT_TIMEOUT);
      } else {
        setBootState('failed');
      }
    }, BOOT_TIMEOUT);
    post({ type: 'ready' });
  }, []);

  const onBootAck = useCallback((ok: boolean) => {
    clearTimeout(bootTimerRef.current);
    if (ok) {
      setBootState('ready');
      return;
    }
    // 宿主核心模块就绪失败：重试 1 次后进入失败界面
    if (!bootRetriedRef.current) {
      bootRetriedRef.current = true;
      post({ type: 'ready' });
      bootTimerRef.current = setTimeout(() => setBootState('failed'), BOOT_TIMEOUT);
    } else {
      setBootState('failed');
    }
  }, []);

  const pendingRef = useRef<PermissionRequest[]>([]);
  pendingRef.current = pendingRequests;

  // 错误提示自动消失
  useEffect(() => {
    if (!errorToast) {
      return;
    }
    const t = setTimeout(() => setErrorToast(null), 5000);
    return () => clearTimeout(t);
  }, [errorToast]);

  // 运行期提示自动消失（退避等待上限 10s + 重试请求耗时，15s 兜底；流恢复时会提前清除）
  useEffect(() => {
    if (!noticeToast) {
      return;
    }
    const t = setTimeout(() => setNoticeToast(null), 15000);
    return () => clearTimeout(t);
  }, [noticeToast]);

  // ---------- 消息处理 ----------
  const handleMessage = useCallback((msg: ExtensionToWebviewMessage) => {
    switch (msg.type) {
      case 'session:list':
        setSessions(msg.sessions);
        break;

      case 'session:loaded': {
        const s = msg.session;
        setActiveSession(prev => {
          if (streamingRef.current && streamingRef.current.sessionId === s.id) {
            return prev;
          }
          return s;
        });
        if (msg.stats) {
          setStats(msg.stats);
        }
        break;
      }

      case 'session:new':
      case 'session:updated': {
        const s = msg.session;
        setActiveSession(prev => {
          // 若当前正在流式输出且会话被整体更新，避免打断（流式消息以 chat:chunk 驱动）
          if (streamingRef.current && streamingRef.current.sessionId === s.id) {
            return prev;
          }
          return s;
        });
        break;
      }

      case 'session:deleted':
        setSessions(prev => prev.filter(s => s.id !== msg.sessionId));
        setActiveSession(prev => (prev && prev.id === msg.sessionId ? null : prev));
        break;

      case 'settings:state':
        setSettings(msg.settings);
        break;

      case 'chat:start':
        setStreaming({ sessionId: msg.sessionId, messageId: msg.messageId });
        setNoticeToast(null);
        setActiveSession(prev => {
          if (!prev || prev.id !== msg.sessionId) {
            return prev;
          }
          const emptyMsg: ChatMessage = {
            id: msg.messageId,
            role: 'assistant',
            content: '',
            steps: [],
            createdAt: Date.now()
          };
          return { ...prev, messages: [...prev.messages.filter(m => m.id !== msg.messageId), emptyMsg] };
        });
        break;

      case 'chat:chunk':
        setNoticeToast(null);
        setActiveSession(prev => {
          if (!prev || prev.id !== msg.sessionId) {
            return prev;
          }
          return {
            ...prev,
            messages: prev.messages.map(m => (m.id === msg.messageId ? { ...m, content: m.content + msg.text } : m))
          };
        });
        break;

      case 'chat:reasoning':
        setActiveSession(prev => {
          if (!prev || prev.id !== msg.sessionId) {
            return prev;
          }
          return {
            ...prev,
            messages: prev.messages.map(m => {
              if (m.id !== msg.messageId) {
                return m;
              }
              // 时序化分段：按 segmentId 追加或新建思考段（与工具节点交替构成分步链路）
              const segments = [...(m.segments ?? [])];
              const idx = segments.findIndex(s => s.id === msg.segmentId && s.type === 'reasoning');
              if (idx >= 0) {
                segments[idx] = { ...segments[idx], content: (segments[idx].content ?? '') + msg.text };
              } else {
                segments.push({ id: msg.segmentId, type: 'reasoning', content: msg.text, createdAt: Date.now() });
              }
              return { ...m, segments, reasoning: (m.reasoning ?? '') + msg.text };
            })
          };
        });
        break;

      case 'chat:insight':
        setActiveSession(prev => {
          if (!prev || prev.id !== msg.sessionId) {
            return prev;
          }
          return {
            ...prev,
            messages: prev.messages.map(m => {
              if (m.id !== msg.messageId) {
                return m;
              }
              // 推理节点分段（V0.8.0）：按 segmentId 追加或新建 insight 段；
              // carry（flush）为从回复气泡迁移的已推送正文，需从 m.content 尾部剔除并写入段内
              const segments = [...(m.segments ?? [])];
              const idx = segments.findIndex(s => s.id === msg.segmentId && s.type === 'insight');
              if (idx >= 0) {
                segments[idx] = { ...segments[idx], content: (segments[idx].content ?? '') + msg.text };
              } else {
                segments.push({ id: msg.segmentId, type: 'insight', content: msg.carry ?? msg.text, createdAt: Date.now() });
              }
              let content = m.content;
              if (msg.carry) {
                content = content.slice(0, Math.max(0, content.length - msg.carry.length));
              }
              return { ...m, segments, content };
            })
          };
        });
        break;

      case 'chat:step':
        setActiveSession(prev => {
          if (!prev || prev.id !== msg.sessionId) {
            return prev;
          }
          return {
            ...prev,
            messages: prev.messages.map(m => {
              if (m.id !== msg.messageId) {
                return m;
              }
              const steps = [...(m.steps ?? [])];
              const idx = steps.findIndex(s => s.id === msg.step.id);
              if (idx >= 0) {
                steps[idx] = msg.step;
              } else {
                steps.push(msg.step);
              }
              // 时序化分段同步：工具段（toolCall/toolResult）按 step id 原位更新或新插入
              const segments = [...(m.segments ?? [])];
              if (msg.step.type === 'toolCall' || msg.step.type === 'toolResult') {
                const si = segments.findIndex(s => s.id === msg.step.id && (s.type === 'toolCall' || s.type === 'toolResult'));
                if (si >= 0) {
                  segments[si] = { ...segments[si], type: msg.step.type, step: msg.step };
                } else {
                  segments.push({ id: msg.step.id, type: msg.step.type, step: msg.step, createdAt: Date.now() });
                }
              }
              return { ...m, steps, segments };
            })
          };
        });
        break;

      case 'chat:done':
        setStreaming(null);
        setNoticeToast(null);
        setActiveSession(prev => {
          if (!prev || prev.id !== msg.sessionId) {
            return prev;
          }
          if (!msg.message?.content && !msg.message?.steps?.length && !msg.message?.reasoning) {
            return prev;
          }
          return {
            ...prev,
            messages: prev.messages.map(m => (m.id === msg.messageId ? msg.message : m))
          };
        });
        break;

      case 'chat:stopped':
        setStreaming(null);
        setNoticeToast(null);
        break;

      case 'chat:error':
        setStreaming(null);
        setNoticeToast(null);
        setErrorToast(msg.error);
        break;

      case 'chat:notice':
        setNoticeToast(msg.text);
        break;

      case 'permission:request':
        setPendingRequests(prev => [...prev, msg.request]);
        break;

      case 'stats:update':
        setStats(msg.stats);
        break;

      case 'files:result':
        // 由 InputArea 自行监听
        break;

      case 'usage:result':
        setUsage(msg.usage);
        break;

      case 'editor:inject':
        // 编辑器右键「Add to Code Agent」：行范围引用注入输入框
        setInjectRefs(msg.refs);
        break;

      case 'compressed':
        setCompressViewer(msg.record);
        setActiveSession(prev => {
          if (!prev || prev.id !== msg.sessionId) {
            return prev;
          }
          return {
            ...prev,
            summaries: [...prev.summaries, msg.record],
            compressLog: [...prev.compressLog, msg.record]
          };
        });
        break;

      case 'boot:ack':
        onBootAck(msg.ok);
        break;
    }
  }, [onBootAck]);

  const streamingRef = useRef<StreamingState | null>(null);
  streamingRef.current = streaming;

  useEffect(() => {
    const handler = (e: MessageEvent) => handleMessage(e.data as ExtensionToWebviewMessage);
    window.addEventListener('message', handler);
    startBoot();
    // 恢复 UI 状态
    const saved = vscodeApi.getState<{ collapsed: boolean; listWidth: number }>();
    if (saved?.collapsed) {
      setListCollapsed(true);
    }
    if (saved?.listWidth) {
      setListWidth(saved.listWidth);
    }
    return () => {
      clearTimeout(bootTimerRef.current);
      window.removeEventListener('message', handler);
    };
  }, [handleMessage, startBoot]);

  // ---------- 操作 ----------

  const send = (text: string, attachments: AttachedFileRef[], images: ImageRef[]): boolean => {
    if (!activeSession || !settings) {
      setErrorToast('请先配置模型（点击右上角设置按钮）');
      return false;
    }
    if (!settings.apiKeyConfigured) {
      setErrorToast('未配置 API Key，请点击右上角设置按钮填写');
      setShowSettings(true);
      return false;
    }
    // V1.4.0 多模态前端预校验（与扩展侧同口径，扩展侧保留最终防线）：
    // 拦截时返回 false 使输入区保留文本/附件/图片，用户切换多模态模型后可直接重试，不丢失已插入的图片
    const sendModelId = activeSession.modelId || settings.defaultModel;
    if (images.length > 0) {
      const sendModel = settings.models.find(m => m.id === sendModelId);
      if (!sendModel?.multimodal) {
        setErrorToast(`当前模型「${sendModel?.name ?? sendModelId}」不支持图片输入，请更换支持多模态的模型后重试`);
        return false;
      }
    }
    // 本地即时显示用户消息（含多模态图片，V1.4.0）
    const userMsg: ChatMessage = {
      id: `local-${Date.now()}`,
      role: 'user',
      content: text,
      attachments: attachments.length > 0 ? attachments : undefined,
      images: images.length > 0 ? images : undefined,
      createdAt: Date.now()
    };
    setActiveSession(prev => (prev ? { ...prev, messages: [...prev.messages, userMsg] } : prev));
    post({
      type: 'chat:send',
      sessionId: activeSession.id,
      text,
      attachments,
      images: images.length > 0 ? images : undefined,
      modelId: sendModelId,
      mode: activeSession.mode || settings.defaultMode
    });
    return true;
  };

  const selectSession = (id: string) => {
    if (streamingRef.current) {
      setErrorToast('请先停止当前任务再切换会话');
      return;
    }
    post({ type: 'session:select', sessionId: id });
  };

  const newSession = () => {
    if (streamingRef.current) {
      setErrorToast('请先停止当前任务再新建会话');
      return;
    }
    post({ type: 'session:new' });
  };

  const compress = () => {
    if (activeSession && !streamingRef.current) {
      post({ type: 'chat:compress', sessionId: activeSession.id });
    }
  };

  const respondPermission = (requestId: string, approved: boolean) => {
    post({ type: 'permission:respond', requestId, approved });
    setPendingRequests(prev => prev.filter(r => r.id !== requestId));
  };

  const setModel = (id: string) => {
    setActiveSession(prev => (prev ? { ...prev, modelId: id } : prev));
    // 同步扩展侧：持久化会话模型选择并按新模型窗口口径刷新 Token 统计
    if (activeSession) {
      post({ type: 'session:setModel', sessionId: activeSession.id, modelId: id });
    }
  };
  const setMode = (mode: RunMode) => {
    setActiveSession(prev => (prev ? { ...prev, mode } : prev));
  };

  // 权限模式切换：写入全局设置，宿主回传 settings:state 完成双向同步
  const setPermissionMode = (permissionMode: 'ask' | 'auto') => {
    setSettings(prev => (prev ? { ...prev, permissionMode } : prev));
    post({ type: 'settings:update', settings: { permissionMode } });
  };

  // 会话侧边栏外部点击收起：主面板空白/内容区点击自动收起（例外：输入框、按钮等交互控件不触发）
  const handleMainPanelClick = (e: React.MouseEvent) => {
    if (listCollapsed) {
      return;
    }
    const target = e.target as HTMLElement;
    if (target.closest('button, textarea, input, select, .input-area, .header-actions, .msg-actions, .step-block, .file-change-node, .session-list')) {
      return;
    }
    setListCollapsed(true);
    vscodeApi.setState({ collapsed: true, listWidth });
  };

  // 重新生成：扩展侧移除该助手消息及其后工具消息，用上一条用户消息重试
  const regenerate = (messageId: string) => {
    if (!activeSession || streamingRef.current) {
      return;
    }
    post({ type: 'chat:regenerate', sessionId: activeSession.id, messageId });
  };

  // ---------- 渲染 ----------

  const visibleMessages = (activeSession?.messages ?? []).filter(m => m.role !== 'tool');
  const generating = !!streaming;
  const sessionModel = settings?.models.find(m => m.id === activeSession?.modelId);

  // 冷启动失败：错误提示 + 手动刷新
  if (bootState === 'failed') {
    return (
      <div className="boot-error">
        <div className="boot-error-icon">🔌</div>
        <div className="boot-error-title">插件初始化超时</div>
        <div className="boot-error-detail">
          扩展核心模块未响应。可能因扩展未完全激活或资源加载失败，请点击下方按钮重新加载。
        </div>
        <button className="btn btn-primary" onClick={() => window.location.reload()}>
          ↻ 重新加载
        </button>
      </div>
    );
  }

  // 启动中：骨架屏（等待宿主核心模块就绪确认）
  if (bootState === 'booting') {
    return (
      <div className="boot-loading">
        <div className="boot-spinner" />
        <div className="boot-loading-text">正在初始化 Code Agent…</div>
      </div>
    );
  }

  return (
    <div className="app">
      <SessionList
        sessions={sessions}
        activeId={activeSession?.id}
        collapsed={listCollapsed}
        width={listWidth}
        onCollapse={() => {
          setListCollapsed(!listCollapsed);
          vscodeApi.setState({ collapsed: !listCollapsed, listWidth });
        }}
        onWidthChange={w => {
          setListWidth(w);
          vscodeApi.setState({ collapsed: listCollapsed, listWidth: w });
        }}
        onSelect={selectSession}
      />

      <div className="main-panel" onClick={handleMainPanelClick}>
        <HeaderBar
          stats={stats}
          generating={generating}
          compressThreshold={settings?.autoCompressThreshold ?? 0.75}
          onCompress={compress}
          onOpenSettings={() => setShowSettings(true)}
        />

        <div className="chat-area">
          {!activeSession || activeSession.messages.length === 0 ? (
            <div className="welcome">
              <div className="welcome-logo">⚡ Code Agent</div>
              <div className="welcome-sub">基于大语言模型的智能编程助手</div>
              <div className="welcome-tips">
                <div className="welcome-tip" onClick={newSession}>＋ 新建对话开始使用</div>
                <div className="welcome-tip" onClick={() => setShowSettings(true)}>⚙ 配置模型 API Key</div>
              </div>
              {settings && !settings.apiKeyConfigured && (
                <div className="welcome-warn">⚠️ 尚未配置 API Key，请先在设置中填写</div>
              )}
            </div>
          ) : (
            <MessageList
              messages={visibleMessages}
              generating={generating}
              streamingMessageId={streaming?.messageId}
              summaries={activeSession.summaries}
              onViewCompress={() =>
                activeSession.compressLog.length > 0 &&
                setCompressViewer(activeSession.compressLog[activeSession.compressLog.length - 1])
              }
              onRegenerate={regenerate}
              showTyping={generating && !visibleMessages.some(m => m.id === streaming?.messageId)}
            />
          )}
        </div>

        {activeSession && settings && (
          <InputArea
            models={settings.models}
            providers={settings.providers}
            defaultProvider={settings.defaultProvider}
            modelId={activeSession.modelId || sessionModel?.id || settings.defaultModel}
            mode={activeSession.mode || settings.defaultMode}
            permissionMode={settings.permissionMode}
            disabled={false}
            generating={generating}
            injectRefs={injectRefs}
            onModelChange={setModel}
            onModeChange={setMode}
            onPermissionModeChange={setPermissionMode}
            onSend={send}
            onStop={() => post({ type: 'chat:stop', sessionId: activeSession.id })}
          />
        )}
      </div>

      {/* 权限确认面板（可叠加多个，懒加载） */}
      <Suspense fallback={null}>
        {pendingRequests.map(r => (
          <PermissionModal key={r.id} request={r} onRespond={respondPermission} />
        ))}
      </Suspense>

      {/* 设置面板（懒加载） */}
      {showSettings && settings && (
        <div className="settings-overlay">
          <Suspense fallback={<div className="lazy-fallback">加载中…</div>}>
            <SettingsPanel settings={settings} usage={usage} onClose={() => setShowSettings(false)} />
          </Suspense>
        </div>
      )}

      {/* 压缩记录查看 */}
      {compressViewer && (
        <div className="permission-backdrop" onClick={() => setCompressViewer(null)}>
          <div className="compress-viewer" onClick={e => e.stopPropagation()}>
            <div className="permission-header">
              <span className="permission-title">压缩记录（{new Date(compressViewer.compressedAt).toLocaleString()}）</span>
              <button className="btn" onClick={() => setCompressViewer(null)}>关闭</button>
            </div>
            <div className="compress-section">
              <div className="impact-label">压缩摘要（{fmtK(compressViewer.tokenAfter)} tokens）</div>
              <pre className="compress-content">{compressViewer.content}</pre>
            </div>
            <div className="compress-section">
              <div className="impact-label">压缩前原文（{fmtK(compressViewer.tokenBefore)} tokens）</div>
              <pre className="compress-content">{compressViewer.original}</pre>
            </div>
          </div>
        </div>
      )}

      {/* 错误提示 */}
      {errorToast && <div className="error-toast">⚠ {errorToast}</div>}

      {/* 运行期轻量提示（限流退避等待等） */}
      {noticeToast && <div className="notice-toast">⏳ {noticeToast}</div>}
    </div>
  );
}

function fmtK(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}
