/**
 * 权限申请确认面板
 * 展示操作详情与影响范围，提供同意/拒绝选项
 */
import React from 'react';
import { PermissionRequest } from '../../src/types';

const TYPE_LABELS: Record<string, { label: string; icon: string; tone: string }> = {
  fileWrite: { label: '文件修改确认', icon: '✏️', tone: 'tone-normal' },
  fileReadOutside: { label: '工作区外文件读取', icon: '👁', tone: 'tone-warn' },
  command: { label: '终端命令确认', icon: '>_', tone: 'tone-warn' },
  highRiskCommand: { label: '高危命令二次确认', icon: '⚠️', tone: 'tone-danger' }
};

export function PermissionModal({
  request,
  onRespond
}: {
  request: PermissionRequest;
  onRespond: (requestId: string, approved: boolean) => void;
}): React.ReactElement {
  const meta = TYPE_LABELS[request.type] ?? { label: request.title, icon: '🔒', tone: 'tone-normal' };
  const payload = request.payload as Record<string, unknown>;
  const contentStr = typeof payload.content === 'string' ? payload.content : '';
  const oldContentStr = typeof payload.oldContent === 'string' ? payload.oldContent : '';

  return (
    <div className="permission-backdrop">
      <div className={`permission-modal ${meta.tone}`}>
        <div className="permission-header">
          <span className="permission-icon">{meta.icon}</span>
          <span className="permission-title">{meta.label}</span>
        </div>
        <div className="permission-detail">{request.detail}</div>
        <div className="permission-impact">
          <div className="impact-label">影响范围</div>
          <div>{request.impact}</div>
        </div>

        {request.type === 'fileWrite' && contentStr && (
          <div className="permission-diff-preview">
            <div className="impact-label">修改预览</div>
            <pre className="diff-preview">
              {oldContentStr && <span className="diff-del-line">- {oldContentStr.slice(0, 500)}{oldContentStr.length > 500 ? '…' : ''}</span>}
              {oldContentStr && '\n'}
              <span className="diff-add-line">+ {contentStr.slice(0, 500)}{contentStr.length > 500 ? '…' : ''}</span>
            </pre>
          </div>
        )}
        {request.type === 'command' || request.type === 'highRiskCommand' ? (
          <div className="permission-command">
            <div className="impact-label">命令内容</div>
            <pre className="terminal-output">{String(payload.command ?? '')}</pre>
          </div>
        ) : null}

        <div className="permission-actions">
          <button
            className="btn btn-danger"
            onClick={() => onRespond(request.id, false)}
          >
            拒绝
          </button>
          <button
            className="btn btn-primary"
            onClick={() => onRespond(request.id, true)}
          >
            同意执行
          </button>
        </div>
      </div>
    </div>
  );
}
