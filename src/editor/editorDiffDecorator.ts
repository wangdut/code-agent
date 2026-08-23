/**
 * 编辑器 diff 装饰器
 * Agent 写入文件后自动打开目标文件，用原生 TextEditorDecorationType 对变更行做可视化标记：
 * 新增行左侧绿色竖线（gutter 图标）+ 浅绿色行背景；删除行标记于删除间隙前一行，左侧红色竖线 + 浅红色行背景。
 * 样式对齐 VSCode 原生 Diff 视觉（无外边框/轮廓线），装饰仅为视觉标记，不修改文件原始内容。
 * 生命周期（V0.6.0 规范化）：
 *  - 同一文件再次修改：自动清除旧装饰，刷新为最新一次修改的高亮结果；
 *  - 用户手动关闭文件：装饰类型释放（重新打开不残留标记）；
 *  - 对话框「跳转编辑器」打开文件：reapply 立即恢复最近一次变更的高亮。
 */
import * as vscode from 'vscode';

/** 新增行左侧竖线图标（对齐 VSCode 原生 diff 新增色系） */
const ADD_GUTTER = buildGutterDataUri('#2ea043');
/** 删除行左侧竖线图标（对齐 VSCode 原生 diff 删除色系） */
const DEL_GUTTER = buildGutterDataUri('#f85149');

interface FileDecoration {
  /** 装饰类型（文件关闭后释放，重新打开时重建） */
  addType: vscode.TextEditorDecorationType | null;
  delType: vscode.TextEditorDecorationType | null;
  /** 第一个变更行（1-based），点击跳转定位用 */
  firstChangeLine: number;
  /** 最近一次变更的新增行（1-based，文件行号） */
  addLines: number[];
  /** 最近一次变更的删除间隙标记行（1-based，标记于间隙前一行） */
  delGapLines: number[];
}

export class EditorDiffDecorator {
  private readonly files = new Map<string, FileDecoration>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    // 文件关闭时释放装饰类型（保留行数据供跳转联动重新应用，但手动重开不主动显示，不残留污染）
    this.disposables.push(
      vscode.workspace.onDidCloseTextDocument(doc => this.release(doc.uri.fsPath))
    );
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    for (const deco of this.files.values()) {
      deco.addType?.dispose();
      deco.delType?.dispose();
    }
    this.files.clear();
  }

  /** 最近一次变更的首个变更行（1-based），无记录返回 0 */
  getFirstChangeLine(filePath: string): number {
    return this.files.get(filePath)?.firstChangeLine ?? 0;
  }

  /** 应用行级 diff 装饰：自动打开目标文件并标记增删行（同一文件再次修改时先清除旧装饰） */
  async applyDiff(filePath: string, diff: string): Promise<void> {
    const { addLines, delGapLines, firstLine } = parseDiff(diff);
    if (addLines.length === 0 && delGapLines.length === 0) {
      return;
    }
    try {
      const doc = await vscode.workspace.openTextDocument(filePath);
      const editor = await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });
      // 同一文件再次修改：清除旧装饰与旧数据，刷新为最新一次修改的高亮结果
      this.clear(filePath);
      const { addType, delType } = this.createTypes();
      this.files.set(filePath, { addType, delType, firstChangeLine: firstLine, addLines, delGapLines });
      this.apply(editor, doc);
    } catch {
      // 文件不可打开（已删除/编码异常）时装饰失败，不影响主流程
    }
  }

  /**
   * 在指定编辑器上重新应用最近一次变更的高亮（「跳转编辑器」联动：打开即标记）。
   * 装饰类型已被文件关闭事件释放时自动重建；无记录（未修改过）时不操作。
   */
  reapply(editor: vscode.TextEditor): void {
    const filePath = editor.document.uri.fsPath;
    const deco = this.files.get(filePath);
    if (!deco) {
      return;
    }
    if (!deco.addType || !deco.delType) {
      const { addType, delType } = this.createTypes();
      deco.addType = addType;
      deco.delType = delType;
    }
    this.apply(editor, editor.document);
  }

  /** 按记录数据计算行范围并应用到编辑器 */
  private apply(editor: vscode.TextEditor, doc: vscode.TextDocument): void {
    const deco = this.files.get(doc.uri.fsPath);
    if (!deco || !deco.addType || !deco.delType) {
      return;
    }
    const addRanges = deco.addLines.map(l => {
      const line = Math.max(0, Math.min(l - 1, doc.lineCount - 1));
      return new vscode.Range(line, 0, line, 0);
    });
    // 删除标记行与新增行重合时新增优先（避免同位置红绿叠加）
    const addSet = new Set(deco.addLines);
    const delRanges = deco.delGapLines
      .filter(l => !addSet.has(l))
      .map(l => {
        const line = Math.max(0, Math.min(l - 1, doc.lineCount - 1));
        return new vscode.Range(line, 0, line, 0);
      });
    editor.setDecorations(deco.addType, addRanges);
    editor.setDecorations(deco.delType, delRanges);
  }

  /** 创建装饰类型：仅左侧 gutter 竖线 + 浅色行背景，无外边框/轮廓线（对齐 VSCode 原生 Diff 视觉） */
  private createTypes(): { addType: vscode.TextEditorDecorationType; delType: vscode.TextEditorDecorationType } {
    const addType = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: 'rgba(46, 160, 67, 0.12)',
      gutterIconPath: ADD_GUTTER,
      gutterIconSize: 'auto',
      overviewRulerColor: 'rgba(46, 160, 67, 0.6)',
      overviewRulerLane: vscode.OverviewRulerLane.Right
    });
    const delType = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: 'rgba(248, 81, 73, 0.12)',
      gutterIconPath: DEL_GUTTER,
      gutterIconSize: 'auto',
      overviewRulerColor: 'rgba(248, 81, 73, 0.6)',
      overviewRulerLane: vscode.OverviewRulerLane.Right
    });
    return { addType, delType };
  }

  /** 文件关闭：释放装饰类型（行数据保留，供跳转联动重建；手动重新打开不主动显示） */
  private release(filePath: string): void {
    const deco = this.files.get(filePath);
    if (deco) {
      deco.addType?.dispose();
      deco.delType?.dispose();
      deco.addType = null;
      deco.delType = null;
    }
  }

  /** 完全清除（再次修改时刷新：删除记录与类型） */
  private clear(filePath: string): void {
    const deco = this.files.get(filePath);
    if (deco) {
      deco.addType?.dispose();
      deco.delType?.dispose();
      this.files.delete(filePath);
    }
  }
}

/** 生成左侧竖线 gutter 图标（data URI SVG，自包含无需资源文件） */
function buildGutterDataUri(color: string): vscode.Uri {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="4" height="16" viewBox="0 0 4 16"><rect x="0" y="0" width="4" height="16" fill="${color}"/></svg>`;
  return vscode.Uri.parse(`data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`);
}

/**
 * 解析行级 diff（lineDiff 输出格式：'  ' 上下文 / '+ ' 新增 / '- ' 删除）。
 * 返回 1-based 文件行号：新增行占文件行，删除行占删除间隙（标记在间隙前一行）。
 */
function parseDiff(diff: string): { addLines: number[]; delGapLines: number[]; firstLine: number } {
  const addLines: number[] = [];
  const delGapSet = new Set<number>();
  let fileLine = 1;
  let firstLine = 0;
  for (const l of diff.split('\n')) {
    if (l.startsWith('+ ')) {
      addLines.push(fileLine);
      if (firstLine === 0) {
        firstLine = fileLine;
      }
      fileLine++;
    } else if (l.startsWith('- ')) {
      const gap = Math.max(1, fileLine - 1);
      delGapSet.add(gap);
      if (firstLine === 0) {
        firstLine = gap;
      }
    } else {
      fileLine++;
    }
  }
  return { addLines, delGapLines: [...delGapSet], firstLine };
}
