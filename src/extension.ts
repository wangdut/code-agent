/**
 * Code Agent 扩展入口
 * 注册活动栏视图（侧边栏对话）与编辑器面板命令
 */
import * as vscode from 'vscode';
import { CodeAgentService } from './services/codeAgentService';
import { WebviewController } from './webview/webviewController';

let service: CodeAgentService | undefined;

/** 侧边栏 WebviewView Provider */
class ChatViewProvider implements vscode.WebviewViewProvider {
  private controller: WebviewController | undefined;

  constructor(private readonly svc: CodeAgentService) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.svc.extensionUri, 'media')]
    };
    this.controller = new WebviewController(webviewView.webview, this.svc, 'view');
    const controller = this.controller;
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.svc.refreshForController(controller);
      }
    });
    webviewView.onDidDispose(() => {
      controller.dispose();
      this.controller = undefined;
    });
  }
}

export function activate(context: vscode.ExtensionContext): void {
  service = new CodeAgentService(context);
  const svc = service;

  // 侧边栏视图
  const provider = new ChatViewProvider(svc);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('codeAgent.chatView', provider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  // 打开独立对话面板
  context.subscriptions.push(
    vscode.commands.registerCommand('codeAgent.openPanel', () => {
      const panel = vscode.window.createWebviewPanel(
        'codeAgent.panel',
        'Code Agent',
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.joinPath(svc.extensionUri, 'media')]
        }
      );
      const controller = new WebviewController(panel.webview, svc, 'panel');
      panel.onDidDispose(() => {
        controller.dispose();
      });
    })
  );

  // 打开设置页
  context.subscriptions.push(
    vscode.commands.registerCommand('codeAgent.openSettings', async () => {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'codeAgent');
    })
  );

  // 新建对话（标题栏命令入口）
  context.subscriptions.push(
    vscode.commands.registerCommand('codeAgent.newSession', async () => {
      const controller = svc.firstController();
      if (controller) {
        await svc.handleNewSession(controller);
      } else {
        await vscode.commands.executeCommand('codeAgent.openPanel');
      }
    })
  );

  // 编辑器右键：选中代码注入对话（行范围引用）
  context.subscriptions.push(
    vscode.commands.registerCommand('codeAgent.addSelection', () => {
      svc.handleAddSelection();
    })
  );

  // 更新检测（启动时检查，仅提示）
  if (svc.config.getAutoUpdateCheck()) {
    void checkUpdate(context).catch(() => undefined);
  }
}

/** 简单的更新检测：对比市场版本（失败静默） */
async function checkUpdate(context: vscode.ExtensionContext): Promise<void> {
  try {
    const current = context.extension.packageJSON.version as string;
    // 本地侧载插件无法可靠访问市场，此处仅记录日志
    console.log(`[code-agent] v${current} 已激活`);
  } catch {
    // 忽略
  }
}

export function deactivate(): void {
  service?.dispose();
  service = undefined;
}
