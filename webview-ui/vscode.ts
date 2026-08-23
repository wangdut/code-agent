/**
 * WebView 通信桥
 */
import { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../src/types';

const api = (globalThis as any).acquireVsCodeApi();

export const vscodeApi = api as {
  postMessage(msg: WebviewToExtensionMessage): void;
  getState<T>(): T | undefined;
  setState(state: unknown): void;
};

export function post(msg: WebviewToExtensionMessage): void {
  vscodeApi.postMessage(msg);
}

export type { ExtensionToWebviewMessage };
