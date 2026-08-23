/**
 * 输入区组件
 * - 多行输入框：Enter 发送 / Shift+Enter 换行
 * - @ 触发文件联想选择器（引用工作区文件/文件夹；图片文件纳入多模态输入链路，V1.4.0）
 * - 多模态图片输入（V1.4.0）：剪贴板粘贴 / 文件拖拽 / @ 引用三路径，缩略图内联预览与单独删除、批量清空
 * - 底部常驻操作栏：模型切换下拉框 + 模式切换下拉框 + 发送/停止按钮
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AttachedFileRef, ImageRef, IMAGE_MAX_SIZE, IMAGE_SUPPORTED_TYPES, ModelMeta, ProviderInfo, RunMode } from '../../src/types';
import { post } from '../vscode';

/** 图片文件扩展名识别（@ 引用路径：命中后经扩展侧读取为 Base64 纳入多模态链路） */
const IMAGE_EXT_RE = /\.(png|jpe?g|webp)$/i;

/** 单条消息图片数量上限（与附件链路的限额策略对齐，防止超大请求体与内存压力） */
const MAX_IMAGE_COUNT = 10;

interface Props {
  models: ModelMeta[];
  /** 服务商列表（模型切换下拉框与当前生效服务商绑定） */
  providers: ProviderInfo[];
  /** 当前生效的默认服务商 id（V1.2.0 下拉框仅展示该服务商的模型） */
  defaultProvider: string;
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
  onSend: (text: string, attachments: AttachedFileRef[], images: ImageRef[]) => boolean;
  onStop: () => void;
}

export function InputArea(props: Props): React.ReactElement {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<AttachedFileRef[]>([]);
  /** 多模态图片列表（V1.4.0：粘贴/拖拽/@ 引用统一入口，Base64 Data URL 承载） */
  const [images, setImages] = useState<ImageRef[]>([]);
  /** 图片插入失败的轻量提示（格式/大小校验等，5s 自动消失） */
  const [imageTip, setImageTip] = useState('');
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

  // @ 联想与图片读取结果：监听扩展返回的消息
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const msg = e.data;
      if (msg?.type === 'files:result') {
        setPickerItems(msg.paths ?? []);
        setPickerLoading(false);
      }
      if (msg?.type === 'image:loaded') {
        if (msg.error) {
          setImageTip(msg.error);
        } else if (msg.dataUrl && msg.mimeType) {
          pushImage({ name: msg.name ?? 'image', mimeType: msg.mimeType, dataUrl: msg.dataUrl });
        }
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  // 图片提示自动消失
  useEffect(() => {
    if (!imageTip) {
      return;
    }
    const t = setTimeout(() => setImageTip(''), 5000);
    return () => clearTimeout(t);
  }, [imageTip]);

  /** 插入图片（同一 Data URL 去重；数量上限护栏，避免超大请求体） */
  const pushImage = (img: ImageRef) => {
    setImages(prev => {
      if (prev.some(p => p.dataUrl === img.dataUrl)) {
        return prev;
      }
      if (prev.length >= MAX_IMAGE_COUNT) {
        setImageTip(`单条消息最多插入 ${MAX_IMAGE_COUNT} 张图片，请删除部分后再试`);
        return prev;
      }
      return [...prev, img];
    });
  };

  /** 粘贴/拖拽路径的图片文件校验与读取（格式 PNG/JPG/JPEG/WebP、单张 ≤10MB） */
  const addImageBlob = (file: File) => {
    if (!IMAGE_SUPPORTED_TYPES.includes(file.type)) {
      setImageTip('不支持的图片格式：仅支持 PNG / JPG / JPEG / WebP，请转换格式后重试');
      return;
    }
    if (file.size > IMAGE_MAX_SIZE) {
      setImageTip(`图片大小 ${(file.size / 1024 / 1024).toFixed(1)}MB 超过 10MB 上限，请压缩后再上传`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => pushImage({ name: file.name || 'image.png', mimeType: file.type, dataUrl: String(reader.result) });
    reader.readAsDataURL(file);
  };

  // 剪贴板粘贴图片（文本粘贴不受影响，保持默认行为）
  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const imgFiles = Array.from(e.clipboardData?.files ?? []).filter(f => f.type.startsWith('image/'));
    if (imgFiles.length === 0) {
      return;
    }
    e.preventDefault();
    imgFiles.forEach(addImageBlob);
  };

  // 文件拖拽图片（非图片文件不拦截默认行为）
  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    const imgFiles = Array.from(e.dataTransfer?.files ?? []).filter(f => f.type.startsWith('image/') || IMAGE_EXT_RE.test(f.name));
    if (imgFiles.length === 0) {
      return;
    }
    e.preventDefault();
    imgFiles.forEach(addImageBlob);
  };

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

  /**
   * 当前生效服务商的模型列表（V1.2.0 服务商联动）：
   * 底部切换下拉框与当前生效服务商绑定，仅展示该服务商下的模型，不同服务商分区不混杂；
   * 切换服务商入口在设置页「默认服务商」，切换模型后扩展侧会同步更新默认服务商
   */
  const activeProviderId = props.defaultProvider || 'deepseek';
  const activeProvider = props.providers.find(p => p.id === activeProviderId);
  const currentModels = useMemo(
    () => props.models.filter(m => (m.providerId ?? 'deepseek') === activeProviderId),
    [props.models, activeProviderId]
  );
  const currentModelInList = currentModels.some(m => m.id === props.modelId);

  // 选择文件
  const pickFile = (path: string) => {
    const isFolder = path.endsWith('/');
    const isImage = !isFolder && IMAGE_EXT_RE.test(path);
    if (isImage) {
      // @ 引用图片文件（V1.4.0）：经扩展侧读取为 Base64（含格式/大小前置校验），统一纳入多模态输入链路
      post({ type: 'image:load', path });
    } else if (isFolder) {
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
    if (!t && attachments.length === 0 && images.length === 0) {
      return;
    }
    if (props.generating || props.disabled) {
      return;
    }
    // onSend 返回 false 表示发送被拦截（如模型不支持多模态）：保留文本/附件/图片供用户调整后重试
    if (!props.onSend(t, attachments, images)) {
      return;
    }
    setText('');
    setAttachments([]);
    setImages([]);
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
      {/* 多模态图片预览区（V1.4.0）：缩略图内联展示、单独删除与批量清空，不影响已输入文本 */}
      {images.length > 0 && (
        <div className="attachment-chips input-chips image-chips">
          {images.map((img, i) => (
            <span key={`${img.name}-${i}`} className="image-chip" title={img.name}>
              <img src={img.dataUrl} alt={img.name} />
              <button className="chip-remove" onClick={() => setImages(prev => prev.filter((_, j) => j !== i))}>×</button>
            </span>
          ))}
          <button className="image-clear-all" onClick={() => setImages([])} title="清空全部图片（不影响文本与文件引用）">
            清空图片
          </button>
        </div>
      )}
      {imageTip && <div className="image-tip">{imageTip}</div>}
      <div className="input-box-wrap" onDragOver={e => e.preventDefault()} onDrop={handleDrop}>
        <textarea
          ref={textareaRef}
          className="input-textarea"
          placeholder="输入消息，Enter 发送，Shift+Enter 换行，@ 引用文件；可粘贴/拖拽图片（多模态模型）"
          value={text}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
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
            title={`切换模型：当前展示服务商「${activeProvider?.name ?? activeProviderId}」的模型（即时生效，不丢失上下文）；切换其他服务商请在设置页选择默认服务商`}
          >
            {currentModels.length === 0 && !props.modelId && <option value="">暂无可用模型</option>}
            {!currentModelInList && props.modelId && (
              <option value={props.modelId}>{props.modelId}（当前使用·其他服务商）</option>
            )}
            {currentModels.map(m => (
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
          <button className="send-btn" onClick={send} disabled={props.disabled || (!text.trim() && attachments.length === 0 && images.length === 0)} title="发送 (Enter)">
            发送 ➤
          </button>
        )}
      </div>
    </div>
  );
}
