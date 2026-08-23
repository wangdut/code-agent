/**
 * 工具注册表 - 注册制设计
 * 所有工具通过注册表登记，Agent 引擎按需调度；新增工具无需修改引擎代码
 */
import { ToolDefinition } from '../models/modelAdapter';
import { RunMode } from '../types';
import { ToolContext, ToolResult, readFileTool, writeFileTool, listDirTool, searchCodeTool, diffTool, executeCommandTool } from './fileTools';

export interface RegisteredTool {
  name: string;
  description: string;
  definition: ToolDefinition;
  execute: (args: any, ctx: ToolContext) => Promise<ToolResult>;
  /** 只读工具（V0.9.0）：对话模式可用（文件读取/目录遍历/检索/diff）；写入与终端工具仅智能体模式可用 */
  readonly: boolean;
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  constructor() {
    // 标配工具集：文件读取、文件写入/编辑、目录遍历、代码检索、终端命令执行、diff 对比
    this.register({
      name: 'read_file',
      description: '读取文件内容。支持按行号范围分段读取大文件。文件过大时必须使用 startLine/endLine 分段读取。',
      definition: {
        type: 'function',
        function: {
          name: 'read_file',
          description: '读取文件内容，支持按行号范围分段读取',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: '文件路径（相对工作区或绝对路径）' },
              startLine: { type: 'number', description: '起始行号（1 开始，可选）' },
              endLine: { type: 'number', description: '结束行号（含，可选）' }
            },
            required: ['path']
          }
        }
      },
      execute: readFileTool,
      readonly: true
    });

    this.register({
      name: 'write_file',
      description: '写入或编辑文件。提供 content 为全量覆盖写入；同时提供 oldContent 与 content 则为精确替换（oldContent 需在文件中唯一）。工作区外文件禁止写入。',
      definition: {
        type: 'function',
        function: {
          name: 'write_file',
          description: '创建新文件（content）、全量覆盖（content）或精确替换（oldContent+content）',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: '目标文件路径（相对工作区或绝对路径）' },
              content: { type: 'string', description: '新内容（全量模式）或替换后的文本（替换模式）' },
              oldContent: { type: 'string', description: '被替换的原文片段（替换模式，必须唯一，可选）' }
            },
            required: ['path', 'content']
          }
        }
      },
      execute: writeFileTool,
      readonly: false
    });

    this.register({
      name: 'list_dir',
      description: '遍历目录，列出子目录与文件（含大小）。',
      definition: {
        type: 'function',
        function: {
          name: 'list_dir',
          description: '列出目录内容',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: '目录路径，默认工作区根目录' }
            }
          }
        }
      },
      execute: listDirTool,
      readonly: true
    });

    this.register({
      name: 'search_code',
      description: '在工作区中按正则检索代码内容，返回 文件:行号:内容 列表。',
      definition: {
        type: 'function',
        function: {
          name: 'search_code',
          description: '按正则表达式检索代码',
          parameters: {
            type: 'object',
            properties: {
              pattern: { type: 'string', description: '检索关键词或正则表达式' },
              path: { type: 'string', description: '检索目录，默认工作区根目录' },
              caseSensitive: { type: 'boolean', description: '是否区分大小写，默认 false' }
            },
            required: ['pattern']
          }
        }
      },
      execute: searchCodeTool,
      readonly: true
    });

    this.register({
      name: 'execute_command',
      description: '在终端执行命令（依赖安装、脚本运行、构建测试等），返回执行结果。',
      definition: {
        type: 'function',
        function: {
          name: 'execute_command',
          description: '执行终端命令并返回输出',
          parameters: {
            type: 'object',
            properties: {
              command: { type: 'string', description: '要执行的完整命令' },
              cwd: { type: 'string', description: '执行目录，默认工作区根目录' }
            },
            required: ['command']
          }
        }
      },
      execute: executeCommandTool,
      readonly: false
    });

    this.register({
      name: 'get_diff',
      description: '获取工作区当前未提交的 git diff，用于对比变更。',
      definition: {
        type: 'function',
        function: {
          name: 'get_diff',
          description: '获取 git 工作区变更',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: '限定文件路径（可选）' }
            }
          }
        }
      },
      execute: diffTool,
      readonly: true
    });
  }

  register(tool: RegisteredTool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  /** 智能体模式可用的全部工具定义 */
  getAllDefinitions(): ToolDefinition[] {
    return [...this.tools.values()].map(t => t.definition);
  }

  /**
   * 按运行模式获取可用工具定义（V0.9.0 调度层权限管控）
   * 对话模式仅挂载只读工具（读取/遍历/检索/diff），写入与终端工具不入请求，从调度层面屏蔽越权调用
   */
  getDefinitionsForMode(mode: RunMode): ToolDefinition[] {
    if (mode === 'chat') {
      return [...this.tools.values()].filter(t => t.readonly).map(t => t.definition);
    }
    return this.getAllDefinitions();
  }

  getAll(): RegisteredTool[] {
    return [...this.tools.values()];
  }
}
