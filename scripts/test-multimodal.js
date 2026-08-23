/**
 * 多模态链路功能测试（V1.4.5）
 * 运行：node scripts/test-multimodal.js
 *
 * 覆盖断言：
 * 1. ConfigManager.getModels 的 multimodal 字段透传（true / 显式 false / 缺省三态）；
 * 2. replaceProviderModels 校准合并语义（用户校准优先保留；缺省时采用拉取探测值；他服务商模型不受影响）；
 * 3. 已知视觉模型 ID 模式正/反例矩阵（含 DeepSeek 视觉系新适配，全服务商覆盖）；
 * 不发起任何网络请求，不读写真实用户配置（vscode 模块以内存 stub 替代）。
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const root = path.resolve(__dirname, '..');
const tmp = path.join(root, '.tmp-test');

function cleanup() {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// 0. 编译被测模块（tsc 直编，独立于项目构建脚本）
cleanup();
const tscBin = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
execFileSync(
  process.execPath,
  [
    tscBin,
    path.join(root, 'src', 'config', 'configManager.ts'),
    path.join(root, 'src', 'models', 'modelAdapter.ts'),
    '--outDir', tmp,
    '--module', 'commonjs',
    '--target', 'es2020',
    '--moduleResolution', 'node',
    '--esModuleInterop',
    '--skipLibCheck'
  ],
  { stdio: 'inherit' }
);

// 1. vscode stub：内存配置存储（模拟 Global 作用域读写对齐）
const store = new Map();
global.__codeAgentStore = store;
fs.writeFileSync(
  path.join(tmp, 'vscode-stub.js'),
  [
    'const store = global.__codeAgentStore;',
    'module.exports = {',
    '  workspace: {',
    '    workspaceFolders: undefined,',
    '    getConfiguration: () => ({',
    '      get: (key, def) => (store.has(key) ? store.get(key) : def),',
    '      inspect: () => ({}),',
    '      update: (key, value) => { store.set(key, value); return Promise.resolve(); }',
    '    })',
    '  },',
    '  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 }',
    '};',
    ''
  ].join('\n')
);
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'vscode') {
    return path.join(tmp, 'vscode-stub.js');
  }
  return origResolve.call(this, request, ...args);
};

const { ConfigManager } = require(path.join(tmp, 'config', 'configManager.js'));
const { isKnownVisionModel } = require(path.join(tmp, 'models', 'modelAdapter.js'));

let failed = 0;
function assert(cond, name) {
  if (cond) {
    console.log('  ✓ ' + name);
  } else {
    failed++;
    console.error('  ✗ ' + name);
  }
}

(async () => {
  console.log('[1] getModels 多模态字段透传（读取层缺陷修复验证）');
  store.set('models', [
    { id: 'kimi-k3', name: 'Kimi K3', contextWindow: 1000000, maxOutputTokens: 8192, multimodal: true, providerId: 'moonshot' },
    { id: 'deepseek-chat', name: 'DeepSeek Chat', multimodal: false, providerId: 'deepseek' },
    { id: 'plain-model', name: 'Plain', providerId: 'deepseek' }
  ]);
  const cm = new ConfigManager({ get: async () => undefined, store: async () => undefined, delete: async () => undefined });
  const models = cm.getModels();
  assert(models.find(m => m.id === 'kimi-k3').multimodal === true, '预置/拉取标记 true 透传（Kimi K3 不再被误拦截）');
  assert(models.find(m => m.id === 'deepseek-chat').multimodal === false, '显式 false（用户校准）保留');
  assert(models.find(m => m.id === 'plain-model').multimodal === undefined, '缺省视为不支持（undefined）');

  console.log('[2] replaceProviderModels 校准合并语义');
  await cm.replaceProviderModels('deepseek', [
    { id: 'deepseek-chat', multimodal: true }, // 拉取探测 true，但用户校准 false → 保留 false
    { id: 'plain-model', multimodal: true }, // 用户未校准 → 采用拉取 true（默认勾选）
    { id: 'deepseek-v4-flash-vision-exp', multimodal: true } // 新增视觉模型直接采用拉取标记
  ]);
  const merged = cm.getModels();
  assert(merged.find(m => m.id === 'deepseek-chat').multimodal === false, '用户校准 false 不被拉取覆盖');
  assert(merged.find(m => m.id === 'plain-model').multimodal === true, '未校准模型采用拉取探测 true（默认勾选）');
  assert(merged.find(m => m.id === 'deepseek-v4-flash-vision-exp').multimodal === true, 'DeepSeek 视觉模型拉取标记透传');
  assert(merged.find(m => m.id === 'kimi-k3').multimodal === true, '他服务商（月之暗面）模型不受同步影响');

  console.log('[3] 已知视觉模型 ID 模式正例矩阵（全服务商）');
  const positives = [
    // 月之暗面
    'kimi-k3', 'kimi-k3-preview', 'kimi-latest', 'kimi-k2.5', 'kimi-k2.6',
    // DeepSeek 视觉系（通用 vision 标记覆盖）
    'deepseek-v4-flash-vision-exp', 'deepseek-vision-test',
    // 智谱
    'glm-4v', 'glm-4v-flash', 'glm-4.5v', 'glm-4.6v-plus',
    // 通义
    'qwen-vl-max', 'qwen2.5-vl-72b-instruct', 'qvq-max',
    // 豆包 / OpenAI / Anthropic
    'doubao-vision-pro-32k', 'gpt-4-vision-preview',
    'gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4-turbo', 'gpt-5', 'gpt-5-mini',
    'o3', 'o3-pro', 'o4', 'o4-mini',
    'claude-3-5-sonnet-latest', 'claude-3-opus-latest', 'claude-sonnet-4', 'claude-opus-4-1', 'claude-haiku-4'
  ];
  for (const id of positives) {
    assert(isKnownVisionModel(id) === true, `正例 ${id}`);
  }

  console.log('[4] 已知视觉模型 ID 模式反例矩阵（纯文本模型不命中）');
  const negatives = [
    'deepseek-chat', 'deepseek-reasoner',
    'kimi-k2', 'kimi-k2-0905-preview', 'moonshot-v1-8k', 'moonshot-v1-128k',
    'glm-4-plus', 'glm-4.5', 'qwen-plus', 'qwen-max', 'qwen-turbo',
    'doubao-pro-32k', 'o1', 'o1-mini', 'o3-mini',
    'gpt-4', 'gpt-3.5-turbo', 'claude-2', 'llama-3-70b'
  ];
  for (const id of negatives) {
    assert(isKnownVisionModel(id) === false, `反例 ${id}`);
  }

  cleanup();
  if (failed > 0) {
    console.error(`\n${failed} 项断言失败`);
    process.exit(1);
  }
  console.log('\n全部断言通过（多模态读取透传 / 校准合并语义 / 视觉模型 ID 模式矩阵）');
})().catch(err => {
  cleanup();
  console.error(err);
  process.exit(1);
});
