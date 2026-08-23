/**
 * 顶部功能按钮区 + Token 用量可视化
 * 会话级实时统计：「已用 X.XK / 总窗口 Y.YK」进度条（单位千 Token，保留 1 位小数）
 * 旁注单轮最大输出限制；已用值为模型侧真实 prompt_tokens 校准（与请求体口径一致），
 * 消息链变化后回退启发式估算（tooltip 标注口径）
 */
import React from 'react';
import { SessionContextStats } from '../../src/types';

interface Props {
  stats: SessionContextStats | null;
  generating: boolean;
  /** 自动压缩阈值（0-1），进度条警示线，默认 0.75 */
  compressThreshold?: number;
  onCompress: () => void;
  onOpenSettings: () => void;
}

export function HeaderBar({ stats, generating, compressThreshold, onCompress, onOpenSettings }: Props): React.ReactElement {
  const pct = stats && stats.windowTokens > 0 ? Math.min(100, (stats.usedTokens / stats.windowTokens) * 100) : 0;
  const warn = pct >= (compressThreshold ?? 0.75) * 100;

  return (
    <div className="header-bar">
      <div className="token-bar-wrap">
        <div className="token-bar-header">
          <span className="token-label">上下文占用</span>
          <span
            className={`token-nums${warn ? ' token-warn' : ''}`}
            title={stats ? `已用 ${stats.usedTokens} / 总窗口 ${stats.windowTokens} Token${stats.calibrated ? '（模型侧真实计数）' : '（启发式估算）'}` : undefined}
          >
            {stats ? `已用 ${formatK(stats.usedTokens)} / 总窗口 ${formatK(stats.windowTokens)}` : '—'}
          </span>
        </div>
        <div className="token-bar-track">
          <div
            className={`token-bar-fill${warn ? ' token-fill-warn' : ''}${pct >= 90 ? ' token-fill-danger' : ''}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        {stats && (
          <div className="token-layer-info">
            系统 {formatK(stats.layers.system)} · 活跃 {formatK(stats.layers.active)} · 摘要 {formatK(stats.layers.summaries)} · 单轮最大输出 {formatK(stats.maxOutputTokens)}
          </div>
        )}
      </div>
      <div className="header-actions">
        <button className="icon-btn" title="压缩上下文（将早期对话转为摘要层）" onClick={onCompress} disabled={generating}>
          🗜
        </button>
        <button className="icon-btn" title="设置" onClick={onOpenSettings}>
          ⚙
        </button>
      </div>
    </div>
  );
}

/** Token 数格式化：单位千 Token，保留 1 位小数（需求规范：X.XK） */
function formatK(n: number): string {
  return `${(n / 1000).toFixed(1)}K`;
}
