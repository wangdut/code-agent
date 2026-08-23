/**
 * 输入区组件
 * - 多行输入框：Enter 发送 / Shift+Enter 换行
 * - @ 触发文件联想选择器（引用工作区文件/文件夹）
 * - 底部常驻操作栏：模型切换下拉框 + 模式切换下拉框 + 发送/停止按钮
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AttachedFileRef, ModelMeta, RunMode } from '../../src/types';
import { post } from '../vscode';

interface Props {
  models: ModelMeta[];
  modelId: string;
  mode: RunMode;
  permissionMode: 'ask' | 'auto';
  disabled: boolean;
  generating: boolean;
  /** 编辑器右键注入的选区引用（行范围引用，追加为附件） */
  injectRefs?: AttachedFileRef[];
  onModelChange: (id: string) => void;
  onModeChange: (m: RunMode) => void;
  onPermissionModeChange: (m: 'ask' | 'auto') => void;
  onSend: (text: string, attachments: AttachedFileRef[]) => void;
  onStop: () => void;
}

export function InputArea(props: Props): React.ReactElement {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<AttachedFileRef[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState('');
  const [pickerItems, setPickerItems] = useState<string[]>([]);
  const [pickerIndex, setPickerIndex] = useState(0);
  const [pickerLoading, setPickerLoading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pickerTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // 编辑器右键注入：行范围引用追加到附件列表（相同 path + 行范围去重）
  useEffect(() => {
    if (!props.injectRefs || props.injectRefs.length === 0) {
      return;
    }
    setAttachments(prev => {
      const next = [...prev];
      for (const ref of props.injectRefs!) {
        const dup = next.some(a => a.path === ref.path && a.startLine === ref.startLine && a.endLine === ref.endLine);
        if (!dup) {
          next.push(ref);
        }
      }
      return next;
    });
    textareaRef.current?.focus();
  }, [props.injectRefs]);

  // @ 联想：监听扩展返回的文件列表
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const msg = e.data;
      if (msg?.type === 'files:result') {
        setPickerItems(msg.paths ?? []);
        setPickerLoading(false);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  // 输入变化：检测 @ 触发
  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setText(value);
    const cursor = e.target.selectionStart ?? value.length;
    const beforeCursor = value.slice(0, cursor);
    const atMatch = beforeCursor.match(/@([^\s@]*)$/);
    if (atMatch) {
      const query = atMatch[1];
      setPickerQuery(query);
      setPickerOpen(true);
      setPickerIndex(0);
      setPickerLoading(true);
      clearTimeout(pickerTimer.current);
      pickerTimer.current = setTimeout(() => {
        post({ type: 'files:list', query });
      }, 150);
    } else {
      setPickerOpen(false);
    }
  };

  const filteredItems = useMemo(() => {
    if (!pickerQuery) {
      return pickerItems;
    }
    const q = pickerQuery.toLowerCase();
    return pickerItems.filter(p => p.toLowerCase().includes(q));
  }, [pickerItems, pickerQuery]);

  // 选择文件
  const pickFile = (path: string) => {
    const isFolder = path.endsWith('/');
    if (isFolder) {
      // 文件夹引用：去掉尾斜杠
      const folderPath = path.replace(/\/$/, '');
      setAttachments(prev => [...prev.filter(a => a.path !== folderPath), { path: folderPath, kind: 'folder' }]);
    } else {
      setAttachments(prev => [...prev.filter(a => a.path !== path), { path, kind: 'file' }]);
    }
    // 移除输入中的 @xxx
    setText(prev => {
      const before = prev.slice(0, Math.max(0, (textareaRef.current?.selectionStart ?? prev.length) - 1));
      const atIdx = before.lastIndexOf('@');
      return atIdx >= 0 ? before.slice(0, atIdx) : before;
    });
    setPickerOpen(false);
    textareaRef.current?.focus();
  };

  const removeAttachment = (att: AttachedFileRef) => {
    // 行范围引用按 path + 行范围精确定位，同文件多段选区互不影响
    setAttachments(prev =>
      prev.filter(a => !(a.path === att.path && a.startLine === att.startLine && a.endLine === att.endLine))
    );
  };

  const send = () => {
    const t = text.trim();
    if (!t && attachments.length === 0) {
      return;
    }
    if (props.generating || props.disabled) {
      return;
    }
    props.onSend(t, attachments);
    setText('');
    setAttachments([]);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (pickerOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setPickerIndex(i => Math.min(i + 1, filteredItems.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setPickerIndex(i => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        if (filteredItems[pickerIndex]) {
          pickFile(filteredItems[pickerIndex]);
        }
        return;
      }
      if (e.key === 'Escape') {
        setPickerOpen(false);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="input-area">
      {attachments.length > 0 && (
        <div className="attachment-chips input-chips">
          {attachments.map(a => {
            const key = `${a.path}${a.startLine !== undefined ? `#${a.startLine}-${a.endLine}` : ''}`;
            const rangeLabel = a.startLine !== undefined ? ` ${a.startLine}-${a.endLine}` : '';
            return (
              <span key={key} className={`attach-chip attach-${a.kind}`} title={a.path}>
                {a.kind === 'folder' ? '📁' : '📄'} {a.path}{rangeLabel}
                <button className="chip-remove" onClick={() => removeAttachment(a)}>×</button>
              </span>
            );
          })}
        </div>
      )}
      <div className="input-box-wrap">
        <textarea
          ref={textareaRef}
          className="input-textarea"
          placeholder="输入消息，Enter 发送，Shift+Enter 换行，@ 引用文件"
          value={text}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          rows={Math.min(8, Math.max(2, text.split('\n').length))}
          disabled={props.disabled}
        />
        {pickerOpen && (
          <div className="file-picker">
            <div className="picker-header">引用工作区文件（@）</div>
            {pickerLoading && filteredItems.length === 0 ? (
              <div className="picker-empty">加载中…</div>
            ) : filteredItems.length === 0 ? (
              <div className="picker-empty">未找到匹配的文件</div>
            ) : (
              filteredItems.slice(0, 30).map((p, i) => (
                <div
                  key={p}
                  className={`picker-item${i === pickerIndex ? ' picker-active' : ''}`}
                  onMouseEnter={() => setPickerIndex(i)}
                  onMouseDown={e => {
                    e.preventDefault();
                    pickFile(p);
                  }}
                >
                  {p.endsWith('/') ? '📁' : '📄'} {p}
                </div>
              ))
            )}
          </div>
        )}
      </div>
      <div className="input-toolbar">
        <div className="select-group">
          <select
            className="model-select"
            value={props.modelId}
            onChange={e => props.onModelChange(e.target.value)}
            title="切换模型（即时生效，不丢失上下文）"
          >
            {props.models.map(m => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <select
            className="mode-select"
            value={props.mode}
            onChange={e => props.onModeChange(e.target.value as RunMode)}
            title="切换运行模式"
          >
            <option value="agent">智能体模式</option>
            <option value="chat">对话模式</option>
          </select>
          <select
            className={`permission-select${props.mode === 'chat' ? ' permission-locked' : ` permission-${props.permissionMode}`}`}
            value={props.mode === 'chat' ? 'readonly' : props.permissionMode}
            disabled={props.mode === 'chat'}
            onChange={e => props.onPermissionModeChange(e.target.value as 'ask' | 'auto')}
            title={
              props.mode === 'chat'
                ? '对话模式下仅支持只读文件问答，权限管理不生效；切换至智能体模式后可配置询问/全自动'
                : props.permissionMode === 'auto'
                  ? '全自动模式（仅智能体模式生效）：修改工作区内文件自动放行，工作区外文件只读；高危命令仍需确认'
                  : '询问模式（仅智能体模式生效）：修改工作区内文件前提示确认，工作区外文件只读'
            }
          >
            {props.mode === 'chat' ? (
              <option value="readonly">🔒 对话模式·只读权限</option>
            ) : (
              <>
                <option value="ask">🛡 询问模式</option>
                <option value="auto">⚡ 全自动模式</option>
              </>
            )}
          </select>
        </div>
        {props.generating ? (
          <button className="send-btn stop-btn" onClick={props.onStop} title="停止生成">
            ■ 停止
          </button>
        ) : (
          <button className="send-btn" onClick={send} disabled={props.disabled || (!text.trim() && attachments.length === 0)} title="发送 (Enter)">
            发送 ➤
          </button>
        )}
      </div>
    </div>
  );
}
