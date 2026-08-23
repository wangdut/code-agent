/**
 * WebView 宿主控制器
 * 职责：管理单个 WebView（侧边栏视图或编辑器面板）的生命周期、
 * postMessage 双向通信、HTML 生成、CSP 安全策略
 */
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../types';
import { CodeAgentService } from '../services/codeAgentService';

export class WebviewController {
  private readonly disposables: vscode.Disposable[] = [];
  /** 当前查看的会话 */
  activeSessionId: string | undefined;

  constructor(
    private readonly webview: vscode.Webview,
    private readonly service: CodeAgentService,
    private readonly kind: 'view' | 'panel'
  ) {
    this.webview.html = this.buildHtml();
    this.webview.onDidReceiveMessage(msg => this.handleMessage(msg as WebviewToExtensionMessage), undefined, this.disposables);
  }

  dispose(): void {
    // 取消该控制器所有待确认的权限请求，并从服务注销（防止向已销毁 WebView 广播、控制器泄漏）
    this.service.cancelPendingForController(this);
    this.service.unregisterController(this);
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  post(msg: ExtensionToWebviewMessage): void {
    void this.webview.postMessage(msg);
  }

  private buildHtml(): string {
    const nonce = this.newNonce();
    const scriptUri = this.webview.asWebviewUri(vscode.Uri.joinPath(this.service.extensionUri, 'media', 'main.js'));
    const styleUri = this.webview.asWebviewUri(vscode.Uri.joinPath(this.service.extensionUri, 'media', 'main.css'));
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${this.webview.cspSource} data:; style-src ${this.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${this.webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>Code Agent</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private newNonce(): string {
    // 使用加密安全随机数生成 CSP nonce（防可预测性 XSS 脚本注入）
    return crypto.randomBytes(16).toString('base64');
  }

  // ---------- 消息路由 ----------

  private async handleMessage(msg: WebviewToExtensionMessage): Promise<void> {
    try {
      switch (msg.type) {
        case 'ready':
          // 就绪握手：核心模块（会话列表/设置/会话恢复）全部就绪后才回确认，
          // WebView 侧据此判定冷启动是否成功，失败可重试或展示错误界面
          try {
            await this.service.onControllerReady(this);
            this.post({ type: 'boot:ack', ok: true });
          } catch {
            this.post({ type: 'boot:ack', ok: false });
          }
          break;
        case 'chat:send':
          await this.service.handleChatSend(this, msg.sessionId, msg.text, msg.attachments, msg.modelId, msg.mode);
          break;
        case 'chat:regenerate':
          await this.service.handleChatRegenerate(this, msg.sessionId, msg.messageId);
          break;
        case 'chat:stop':
          this.service.handleChatStop(msg.sessionId);
          break;
        case 'chat:compress':
          await this.service.handleCompress(this, msg.sessionId);
          break;
        case 'permission:respond':
          this.service.handlePermissionResponse(msg.requestId, msg.approved);
          break;
        case 'session:new':
          await this.service.handleNewSession(this);
          break;
        case 'session:select':
          await this.service.handleSelectSession(this, msg.sessionId);
          break;
        case 'session:setModel':
          this.service.handleSetSessionModel(this, msg.sessionId, msg.modelId);
          break;
        case 'session:rename':
          await this.service.handleRenameSession(this, msg.sessionId, msg.title);
          break;
        case 'session:delete':
          await this.service.handleDeleteSession(this, msg.sessionId);
          break;
        case 'session:export':
          await this.service.handleExportSession(msg.sessionId);
          break;
        case 'session:search':
          this.service.handleSearchSessions(this, msg.keyword);
          break;
        case 'settings:get':
          await this.service.sendSettings(this);
          break;
        case 'settings:update':
          await this.service.handleSettingsUpdate(this, msg.settings, msg.apiKey, msg.clearApiKey);
          break;
        case 'model:add':
          await this.service.handleModelAdd(this, msg.model);
          break;
        case 'model:update':
          await this.service.handleModelUpdate(this, msg.oldId, msg.model);
          break;
        case 'model:delete':
          await this.service.handleModelDelete(this, msg.modelId);
          break;
        case 'provider:add':
          await this.service.handleProviderAdd(this, msg.name, msg.baseUrl, msg.apiKey);
          break;
        case 'provider:update':
          await this.service.handleProviderUpdate(this, msg.id, msg.name, msg.baseUrl, msg.apiKey, msg.clearApiKey);
          break;
        case 'provider:delete':
          await this.service.handleProviderDelete(this, msg.id);
          break;
        case 'provider:refresh':
          await this.service.handleProviderRefresh(this, msg.id);
          break;
        case 'files:list':
          await this.service.handleFilesList(this, msg.query);
          break;
        case 'editor:open':
          await this.service.openFileInEditor(msg.filePath);
          break;
        case 'usage:query':
          await this.service.handleUsageQuery(this);
          break;
        case 'openSettingsPage':
          await vscode.commands.executeCommand('workbench.action.openSettings', 'codeAgent');
          break;
      }
    } catch (err) {
      this.post({
        type: 'chat:error',
        sessionId: this.activeSessionId ?? '',
        messageId: '',
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
}
