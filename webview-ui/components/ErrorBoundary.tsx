/**
 * 渲染错误边界
 * 冷启动保护：捕获渲染异常后自动重试 1 次，
 * 仍失败则展示错误提示与手动刷新按钮（避免灰屏/白屏无反馈）
 */
import React from 'react';

interface State {
  error: Error | null;
  retried: boolean;
}

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null, retried: false };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error): void {
    console.error('[code-agent] 渲染异常:', error);
    // 首次异常自动重试 1 次（渲染失败常为瞬时资源/时序问题）
    if (!this.state.retried) {
      this.setState({ retried: true, error: null });
    }
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div className="boot-error">
          <div className="boot-error-icon">⚠️</div>
          <div className="boot-error-title">界面渲染失败</div>
          <div className="boot-error-detail">{this.state.error.message}</div>
          <button className="btn btn-primary" onClick={() => window.location.reload()}>
            ↻ 重新加载
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
