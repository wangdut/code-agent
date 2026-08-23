# VSCode 智能编程Agent插件 V0.4.0-V0.5.1 迭代需求规格说明书
我将V0.4.0-V0.5.1的迭代需求表述和AI相关的解决办法都粘贴在这个文档里面了。供你参考。





# V0.4.0

 V0.4.0 其实是在V0.3.0基础上的继续的迭代，相关内容看Code Agent 执行效能专项分析报告（执行效能分析报告.md），迭代实施（执行效能优化四方案 + 版本升级）。先规划任务并调研相关代码：

- V0.4.0-1: 并行工具调用(无依赖工具同批次并行执行)
- V0.4.0-2: 流式执行流水线(只读工具预启动,推理+执行并行)
- V0.4.0-3: 上下文动态裁剪(历史工具输出轻量降级)
- V0.4.0-4: 渲染层增量更新(memo化+步骤级分发)
- V0.4.0-5: 版本0.4.0+CHANGELOG+README
- V0.4.0-verify: 构建+类型检查+打包验证

V0.4.0迭代的内容大概内容就是以上内容。



# V0.5.0

我的需求表述为：

VS Code Code Agent 插件V0.3.0迭代需求规格说明书.md， 我发现这个需求说明书里面的要求，你只执行了一部分，因为上下文的关系，你可能有些忘记执行了。现在你结合上下文和代码，检查一下还有哪些需求没解决的。我认为没解决的有：1.2 账户已用金额统计修复，（已用 Y.YY CNY）依旧无法正常显示，只有账户余额正常可以显示。展开会话列表后，历史会话不显示了，新增会话都不显示了，更别说老会话了，这个属于负优化了。1.1 上下文窗口 Token 统计逻辑修正，这个需求需要解决。等等吧，你可以后续做一下代码审查，看看哪些有问题，这些相当于是对你的提示。版本号统一升级 0.5.0。



## 根因分析（逐条对应你反馈的问题）

### 1. 会话列表全空（负优化的真正根因）
[readMeta](../src/sessions/sessionManager.ts) 的「截断解析」存在一个致命缺陷：截断到 `"messages"` 字段前时，上一字段的**尾随逗号未移除**，`JSON.parse` 必然抛错。我用 node 模拟验证确认了这一点（修复前 `PARSE FAIL`，修复后 `PARSE OK`）。

这解释了你的全部现象：
- 启动扫描时**每个会话文件都被误判为损坏**并跳过 → 历史会话全空；
- 新建会话时写入成功并短暂入列，但原子写入（tmp→rename）触发文件监听 → 300ms 后全量重扫 → 缓存被清空且重建失败 → **新会话也消失**。

修复：截断后 `replace(/,\s*$/, '')` 再补 `}` 解析。

### 2. 已用金额恒为 0（需求 1.2）
旧实现用 `充值 + 赠金 − 当前余额` 推算已用金额，但 DeepSeek 扣费**优先扣赠金**，该公式恒为 0。且余额接口本身无法推导累计消费。

修复（新口径，与需求一致）：
- 新增 [modelPricing.ts](../src/models/modelPricing.ts)：DeepSeek 官方单价表（chat 输入 ¥2/M 输出 ¥8/M，reasoner 输入 ¥4/M 输出 ¥16/M，其他服务商回退默认价）；
- [agentEngine.ts](../src/agent/agentEngine.ts) 每次调用完成后按 `单价 × Token 用量` 估算金额，传入 [usageTracker.ts](../src/sessions/usageTracker.ts) 按**自然日**累计并持久化（兼容旧用量文件）；
- 余额接口只返回余额快照，服务层拼接 `余额 X.XX CNY（已用 Y.YY CNY）`，接口异常仍走「查询失败」兜底。

### 3. Token 统计口径（需求 1.1）
校准机制（模型侧 `prompt_tokens`）此前已落地，但审查发现两个口径问题：
- **无快照时的启发式估算高估**：CJK 按 1 token/字符估算，中文会话会比 DeepSeek 实际占用高估 60%+，已修正为 0.6 token/字符（[tokenCounter.ts](../src/context/tokenCounter.ts)）；
- **压缩/重新生成后旧校准快照未清除**：链长重新增长后会误用压缩前的 `promptBase` 高估占用，已在 [contextManager.ts](../src/context/contextManager.ts) 压缩完成与 [codeAgentService.ts](../src/services/codeAgentService.ts) 重新生成处主动清除快照。

### 4. 代码审查额外发现并修复
- [SessionList.tsx](../webview-ui/components/SessionList.tsx)：收起态挂载时高度测量（ResizeObserver）未建立，展开后可视窗口退化为 1 行；已改为依赖 `collapsed` 重新测量；
- [App.tsx](../webview-ui/App.tsx)：外部点击收起的例外选择器 `.session-sidebar` 与实际类名不符，已对齐为 `.session-list`。

## 验证结果
- `typecheck` ✅ / `build` ✅ / `vsce package` ✅
- 产物：**code-agent-0.5.0.vsix**（107.34 KB）
- 版本号已统一升级 0.5.0（package.json / package-lock.json / README），CHANGELOG 新增 [0.5.0] 缺陷修复条目





# V0.5.1

我的需求表述为：

其他都非常完美了，只有一点还需要修改，就是：插件的会话列表的历史会话，我点击会话的删除按钮，没反应，无法删除这个历史会话。请你改正。然后检查一下相关代码，保证不会引入新的问题。版本号统一升级 0.5.1。





## 根因分析

删除按钮「没反应」的原因：`SessionList.tsx` 原实现用 `if (window.confirm(...))` 作为删除前置判断。**VSCode webview 环境禁用了原生 `window.confirm/alert/prompt`**（调用恒返回 `undefined`，永不弹窗），条件永远为 falsy，导致 `post({type:'session:delete'})` 从未发出。后端删除链路本身完好（webviewController 路由 → handleDeleteSession → sessionManager.delete → watcher 同步广播）。

## 修复内容

**1. [SessionList.tsx](../webview-ui/components/SessionList.tsx) — 两段式内联确认**
- 点击「删除」→ 按钮变为「**确认删除？**」，再次点击才真正发送删除消息
- 5 秒内未确认自动还原为「删除」，防误触
- 菜单关闭（ESC/点击外部/导出等）时同步清除确认态，无状态残留
- 确认态下右键另一会话，按钮自动恢复普通「删除」（id 不匹配即不显示确认态）

**2. 版本号统一升级 0.5.1**：package.json、package-lock.json（2 处，asynckit 依赖的 0.4.0 未误改）、README.md，CHANGELOG.md 新增 0.5.1 条目。

## 引入新问题的风险排查（全链路复查）

| 检查点                        | 结论                                                         |
| ----------------------------- | ------------------------------------------------------------ |
| 前端消息类型 `session:delete` | 与 types.ts 协议定义一致 ✅                                   |
| 后端路由分发                  | webviewController case 完整 ✅                                |
| 删除运行中会话                | handleDeleteSession 先 `engine.stop(sessionId)` 再删除 ✅     |
| 删除后文件 watcher 竞态       | `deletedIds` 集合防收尾落盘复活；onDidDelete 300ms 重扫广播幂等同步 ✅ |
| 删除激活会话                  | 后端自动加载列表首个会话并推送 `session:loaded` ✅            |
| 前端响应                      | `session:deleted` 从列表移除并清理激活态，随后 `session:list` 全量同步 ✅ |
| 菜单 CSS                      | `min-width: 120px` 自适应，容纳「确认删除？」文案 ✅          |

## 验证结果

- `npm run typecheck` ✅
- `npm run build` ✅
- `vsce package` ✅ → **code-agent-0.5.1.vsix**（107.37 KB，10 files）





