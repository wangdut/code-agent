/**
 * 全局设置面板
 * 按模块分级：模型配置 / 推理参数 / Agent行为 / 存储配置 / 安全权限 / 高级设置 / 用量统计
 */
import React, { useEffect, useState } from 'react';
import { ModelMeta, ProviderInfo, SettingsSnapshot } from '../../src/types';
import { post } from '../vscode';

interface Props {
  settings: SettingsSnapshot;
  usage: { today: { inputTokens: number; outputTokens: number; totalTokens: number; requests: number } | null; balance?: string; balanceError?: string } | null;
  onClose: () => void;
}

export function SettingsPanel({ settings, usage, onClose }: Props): React.ReactElement {
  const [form, setForm] = useState<SettingsSnapshot>(settings);
  const [editingModel, setEditingModel] = useState<ModelMeta | null>(null);
  const [editingProvider, setEditingProvider] = useState<ProviderInfo | null>(null);
  /** 模型参数配置区当前选中的服务商（服务商管理区下方）；初始跟随全局默认服务商，避免每次打开重置回首个预置 */
  const [selectedProviderId, setSelectedProviderId] = useState(
    settings.providers.some(p => p.id === settings.defaultProvider)
      ? settings.defaultProvider
      : settings.providers[0]?.id ?? ''
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setForm(settings);
    // 服务商列表变化后：选中项被删除时回退到默认服务商（V1.2.0 联动基准），再回退首个
    setSelectedProviderId(prev =>
      settings.providers.some(p => p.id === prev)
        ? prev
        : settings.providers.some(p => p.id === settings.defaultProvider)
          ? settings.defaultProvider
          : settings.providers[0]?.id ?? ''
    );
  }, [settings]);

  const set = <K extends keyof SettingsSnapshot>(key: K, value: SettingsSnapshot[K]) => {
    setForm(prev => ({ ...prev, [key]: value }));
  };

  // 实时校验基准：全局 max_tokens 为运行时参数，不得超过当前默认模型的输出能力上限
  const currentModel = form.models.find(m => m.id === form.defaultModel);
  const maxTokensOver = currentModel ? form.maxTokens > currentModel.maxOutputTokens : false;

  const save = () => {
    setSaving(true);
    // 超限自动修正：保存时若 max_tokens 超过默认模型输出上限，自动截断为上限值
    const clampedMaxTokens = currentModel ? Math.min(Number(form.maxTokens), currentModel.maxOutputTokens) : Number(form.maxTokens);
    post({
      type: 'settings:update',
      settings: {
        defaultModel: form.defaultModel,
        defaultProvider: form.defaultProvider,
        defaultMode: form.defaultMode,
        requestTimeout: Number(form.requestTimeout),
        proxy: form.proxy,
        temperature: Number(form.temperature),
        topP: Number(form.topP),
        maxTokens: clampedMaxTokens,
        frequencyPenalty: Number(form.frequencyPenalty),
        permissionMode: form.permissionMode,
        terminalAutoApprove: form.terminalAutoApprove,
        highRiskCommands: form.highRiskCommands,
        // 保存兜底：非数字/超范围回退为合法值（1-1000，默认 128）
        maxToolIterations: Math.min(1000, Math.max(1, Math.round(Number(form.maxToolIterations) || 128))),
        autoCompressThreshold: Number(form.autoCompressThreshold),
        historyPath: form.historyPath,
        folderIncludePatterns: form.folderIncludePatterns,
        logLevel: form.logLevel,
        debugMode: form.debugMode,
        autoUpdateCheck: form.autoUpdateCheck
      }
    });
    setTimeout(() => setSaving(false), 400);
  };

  const saveModel = (model: ModelMeta) => {
    const withProvider = model.providerId ? model : { ...model, providerId: selectedProviderId || 'deepseek' };
    // V1.3.0：编辑已有模型走 update；「＋ 添加模型」入口（原始 id 为空/不在列表）走 add，支持强制创建服务商后手动补模型
    if (editingModel && editingModel.id && form.models.some(x => x.id === editingModel.id)) {
      post({ type: 'model:update', oldId: editingModel.id, model: withProvider });
    } else {
      post({ type: 'model:add', model: withProvider });
    }
    setEditingModel(null);
  };

  const saveProvider = (p: { name: string; baseUrl: string; apiKey?: string; clearApiKey?: boolean; presetId?: string; forceCreate?: boolean }) => {
    // V1.3.0 缺陷修复：新增弹窗的 editingProvider 是 id 为空的占位对象，必须按 id 判定编辑/新增——
    // 旧版按对象存在性判定，导致新增被误发为「编辑空 id」，后端报「服务商不存在」
    if (editingProvider && editingProvider.id) {
      post({ type: 'provider:update', id: editingProvider.id, name: p.name, baseUrl: p.baseUrl, apiKey: p.apiKey, clearApiKey: p.clearApiKey });
    } else {
      post({ type: 'provider:add', name: p.name, baseUrl: p.baseUrl, apiKey: p.apiKey, presetId: p.presetId, forceCreate: p.forceCreate });
    }
    setEditingProvider(null);
  };

  /**
   * 默认服务商切换（V1.2.0 联动）：主界面模型下拉框与默认模型同步跟随；
   * 默认模型不属于新服务商时自动切换为该服务商的首个模型，模型参数配置区同步切换
   */
  const changeDefaultProvider = (pid: string) => {
    set('defaultProvider', pid);
    setSelectedProviderId(pid);
    const modelsOfNew = form.models.filter(m => (m.providerId ?? 'deepseek') === pid);
    if (!modelsOfNew.some(m => m.id === form.defaultModel)) {
      set('defaultModel', modelsOfNew[0]?.id ?? '');
    }
  };

  return (
    <div className="settings-panel">
      <div className="settings-header">
        <span className="settings-title">⚙ Code Agent 设置</span>
        <div>
          <button className="btn btn-primary" disabled={saving} onClick={save}>
            {saving ? '保存中…' : '保存设置'}
          </button>
          <button className="btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
      <div className="settings-body">
        {/* 1. 模型配置（V1.1.0：服务商管理区 + 模型参数配置区两级结构） */}
        <Section title="模型配置" icon="🧠">
          <Field
            label="模型服务商"
            tooltip="支持所有遵循 OpenAI 兼容协议的大模型服务商接入（DeepSeek、月之暗面 Kimi、智谱 AI、通义千问等）。\n\n每个服务商拥有独立的 Base URL 与 API Key；新增/修改服务商或点击刷新按钮后，将基于 Base URL 自动拉取该服务商的全部可用模型列表并本地缓存，离线时使用缓存数据。"
            hint="服务商管理区：支持新增、编辑、删除、刷新模型列表"
          >
            <div className="provider-list">
              {form.providers.map(p => {
                const count = form.models.filter(m => (m.providerId ?? 'deepseek') === p.id).length;
                return (
                  <div key={p.id} className="provider-item">
                    <div className="provider-item-info">
                      <span className="provider-name">
                        {p.name}
                        {p.preset && <span className="provider-preset-badge">预置</span>}
                      </span>
                      <span className="provider-meta">
                        {p.baseUrl} · 模型 {count} 个
                        {p.hasApiKey ? ' · ✓ 密钥已配置' : ' · ⚠ 密钥未配置'}
                        {p.lastSyncAt && !p.syncError ? ` · ✓ 已同步 ${new Date(p.lastSyncAt).toLocaleTimeString()}` : ''}
                      </span>
                      {p.syncError && (
                        <span className="provider-sync-error" title={p.syncError}>
                          ⚠ 同步失败：{p.syncError}
                        </span>
                      )}
                    </div>
                    <div className="provider-item-actions">
                      <button className="mini-btn" title="重新拉取该服务商的模型列表" onClick={() => post({ type: 'provider:refresh', id: p.id })}>
                        ↻ 刷新
                      </button>
                      <button className="mini-btn" onClick={() => setEditingProvider({ ...p })}>编辑</button>
                      <button
                        className="mini-btn danger"
                        title={p.preset ? '预置服务商不可删除（可编辑名称与 Base URL）' : '删除该服务商及其模型'}
                        disabled={!!p.preset}
                        onClick={() => post({ type: 'provider:delete', id: p.id })}
                      >
                        删除
                      </button>
                    </div>
                  </div>
                );
              })}
              <button
                className="btn add-model-btn"
                onClick={() => setEditingProvider({ id: '', name: '', baseUrl: '', hasApiKey: false })}
              >
                ＋ 新增模型服务商
              </button>
            </div>
          </Field>
          {/* V1.3.0 运行配置分组：运行时生效的全局配置，决定新建会话的默认服务商与模型 */}
          <div className="config-group">
            <div className="config-group-title">运行配置 · 全局默认</div>
            <Field
              label="默认服务商（全局默认）"
              tooltip="运行时生效的全局配置：决定插件启动、新建会话时默认使用的模型服务商，直接决定主界面默认加载的模型列表；主界面底部模型切换下拉框仅展示该服务商下的模型"
              hint="新建会话默认使用的服务商，切换后主界面模型列表同步更新，参数编辑区同步跟随"
            >
              <select className="text-input" value={form.defaultProvider} onChange={e => changeDefaultProvider(e.target.value)}>
                {form.providers.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </Field>
            <Field
              label="默认模型"
              tooltip="新会话默认使用的模型；仅展示当前默认服务商下的模型（与默认服务商联动），切换后即时生效；上下文统计与窗口阈值同步适配该模型元数据"
            >
              <select className="text-input" value={form.defaultModel} onChange={e => set('defaultModel', e.target.value)}>
                {(() => {
                  const modelsOfProvider = form.models.filter(m => (m.providerId ?? 'deepseek') === form.defaultProvider);
                  return (
                    <>
                      {modelsOfProvider.length === 0 && (
                        <option value="">暂无可用模型（请先为该服务商配置密钥后刷新模型列表）</option>
                      )}
                      {form.defaultModel && !modelsOfProvider.some(m => m.id === form.defaultModel) && (
                        <option value={form.defaultModel}>{form.defaultModel}（当前默认·其他服务商）</option>
                      )}
                      {modelsOfProvider.map(m => (
                        <option key={m.id} value={m.id}>{m.name} ({m.id})</option>
                      ))}
                    </>
                  );
                })()}
              </select>
            </Field>
          </div>
          {/* V1.3.0 编辑配置分组：配置页编辑选择器，仅切换查看/修改模型元数据的目标服务商，不影响运行中的默认服务商 */}
          <div className="config-group">
            <div className="config-group-title">编辑配置 · 参数编辑区</div>
            <Field
              label="编辑目标服务商"
              tooltip="配置页编辑选择器：仅用于切换当前要查看、修改模型元数据的目标服务商，不影响当前运行中的默认服务商状态，也不改变会话的实际使用配置"
              hint="选择要查看/修改模型参数的服务商，不影响当前默认使用的服务商"
            >
              <select className="text-input" value={selectedProviderId} onChange={e => setSelectedProviderId(e.target.value)}>
                {form.providers.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </Field>
            <Field label="模型列表" hint="元数据接口未返回时套用全局默认（300k 上下文 / 100k 输出），可逐模型校准">
              <div className="model-list">
                {form.models.filter(m => (m.providerId ?? 'deepseek') === selectedProviderId).map(m => (
                  <div key={m.id} className="model-item">
                    <div className="model-item-info">
                      <span className="model-name">{m.name}</span>
                      <span className="model-meta">
                        {m.id} · 上下文 {fmtWindow(m.contextWindow)} · 输出 {fmtWindow(m.maxOutputTokens)}
                      </span>
                    </div>
                    <div className="model-item-actions">
                      <button className="mini-btn" onClick={() => setEditingModel({ ...m })}>编辑元数据</button>
                    </div>
                  </div>
                ))}
                {form.models.filter(m => (m.providerId ?? 'deepseek') === selectedProviderId).length === 0 && (
                  <div className="empty-hint">
                    暂无模型缓存。请配置 API Key 后点击服务商右侧「↻ 刷新」拉取模型列表；离线时将使用上次同步的本地缓存；接口不兼容时可用下方「＋ 添加模型」手动录入。
                  </div>
                )}
              </div>
              <button
                className="btn add-model-btn"
                onClick={() => setEditingModel({ id: '', name: '', contextWindow: 300000, maxOutputTokens: 100000, pricing: '按量计费', providerId: selectedProviderId })}
              >
                ＋ 添加模型
              </button>
            </Field>
          </div>
          <div className="field-row">
            <Field label="请求超时 (ms)" tooltip="模型接口请求超时时间；网络不稳定时建议调大">
              <input className="text-input" type="number" value={form.requestTimeout} onChange={e => set('requestTimeout', Number(e.target.value))} />
            </Field>
            <Field label="网络代理" hint="如 http://127.0.0.1:7890" tooltip="全局网络代理地址，所有服务商请求共用；留空不使用代理">
              <input className="text-input" value={form.proxy} onChange={e => set('proxy', e.target.value)} />
            </Field>
          </div>
        </Section>

        {/* 2. 推理参数 */}
        <Section title="推理参数" icon="🎛">
          <div className="field-row">
            <Field label="temperature" hint="0-2，越高越随机">
              <input className="text-input" type="number" step="0.1" min="0" max="2" value={form.temperature} onChange={e => set('temperature', Number(e.target.value))} />
            </Field>
            <Field label="top_p" hint="0-1 核采样">
              <input className="text-input" type="number" step="0.05" min="0" max="1" value={form.topP} onChange={e => set('topP', Number(e.target.value))} />
            </Field>
          </div>
          <div className="field-row">
            <Field
              label="max_tokens"
              tooltip="单次请求生成长度限制（运行时参数），用于控制单次回复篇幅；超过所选模型的输出能力上限时，保存与请求阶段均会自动截断为上限值"
              hint="单次请求生成长度限制，不可超过所选模型的输出上限"
            >
              <input
                className={`text-input${maxTokensOver ? ' input-invalid' : ''}`}
                type="number"
                min="1"
                value={form.maxTokens}
                onChange={e => set('maxTokens', Number(e.target.value))}
              />
              {maxTokensOver && currentModel && (
                <div className="param-warning">
                  ⚠ 超过 {currentModel.name} 的输出上限 {fmtWindow(currentModel.maxOutputTokens)}，保存时将自动修正
                  <button className="mini-btn" onClick={() => set('maxTokens', currentModel.maxOutputTokens)}>
                    修正为上限
                  </button>
                </div>
              )}
            </Field>
            <Field label="frequency_penalty" hint="-2 到 2">
              <input className="text-input" type="number" step="0.1" min="-2" max="2" value={form.frequencyPenalty} onChange={e => set('frequencyPenalty', Number(e.target.value))} />
            </Field>
          </div>
        </Section>

        {/* 3. 运行模式（双层权限体系第一层：决定插件整体能力边界） */}
        <Section title="运行模式" icon="🧭">
          <Field
            label="默认运行模式"
            tooltip="双层权限体系第一层：决定插件整体能力边界与控制可用工具集范围，是所有权限规则的前置判断条件。作用于全局，设置插件启动时新会话的默认运行模式。\n\n智能体模式：完整 Agent 能力——读写工作区文件、执行终端命令、多轮任务自主闭环（工作区外文件只读）。\n\n对话模式：只读文件问答——可读取工作区内外文件与目录作答，禁止任何文件写入与终端命令。"
            hint="新建会话默认采用的运行模式，可在底部快捷栏随时切换"
          >
            <select className="text-input" value={form.defaultMode} onChange={e => set('defaultMode', e.target.value as 'chat' | 'agent')}>
              <option value="agent">智能体模式（完整工具集）</option>
              <option value="chat">对话模式（只读文件问答）</option>
            </select>
          </Field>
        </Section>

        {/* 4. 权限管理（双层权限体系第二层：仅智能体模式下生效） */}
        <Section title="权限管理" icon="🛡" tag="仅智能体模式下生效">
          <Field
            label="文件写入确认方式"
            tooltip="双层权限体系第二层：属于智能体模式下的子配置，仅控制智能体模式中工作区内文件写入操作的确认机制，对话模式下不生效、无作用。\n\n询问模式：修改工作区内文件前弹出确认面板（展示操作详情与 diff 预览），同意后执行；文件读取无需确认。\n\n全自动模式：工作区内文件增删改自主执行，无需逐次确认；仍严格限制在工作区范围内，工作区外文件任何模式下只读。"
            hint="与底部快捷栏同步；读取操作与终端命令不受该模式影响"
          >
            <select className="text-input" value={form.permissionMode} onChange={e => set('permissionMode', e.target.value as 'ask' | 'auto')}>
              <option value="ask">询问模式（推荐，修改文件前提示确认）</option>
              <option value="auto">全自动模式（修改文件自动放行）</option>
            </select>
          </Field>
          <div className="field-row">
            <Checkbox label="工作区内终端命令免确认" checked={form.terminalAutoApprove} onChange={v => set('terminalAutoApprove', v)} />
            <Checkbox label="高危命令拦截（破坏性命令强制二次确认）" checked={form.highRiskCommands} onChange={v => set('highRiskCommands', v)} />
          </div>
        </Section>

        {/* 5. Agent 行为 */}
        <Section title="Agent 行为" icon="🤖">
          <Field
            label="最大工具调用轮次"
            tooltip="单轮任务中 Agent 可自主调度工具的最大次数。正整数，范围 1-1000，默认 128（适配复杂长链路任务）；输入非数字、负数或超范围值将自动回退为合法值。保存后即时生效，作用于所有新建与续接的会话。"
            hint="触发上限时任务中断并在回复中提示，可在设置中调大以支持更长任务链路"
          >
            <input
              className="text-input"
              type="number"
              min="1"
              max="1000"
              step="1"
              value={form.maxToolIterations}
              onChange={e => {
                // 输入校验：空值/非数字回退保持原值；超范围自动钳制到边界
                const n = Number(e.target.value);
                if (e.target.value.trim() === '' || !Number.isFinite(n)) {
                  return;
                }
                set('maxToolIterations', Math.min(1000, Math.max(1, Math.round(n))));
              }}
            />
          </Field>
          <Field label="自动上下文压缩阈值" hint="上下文占用达到模型窗口该比例时自动压缩">
            <div className="range-row">
              <input
                type="range"
                min="0.3"
                max="0.95"
                step="0.05"
                value={form.autoCompressThreshold}
                onChange={e => set('autoCompressThreshold', Number(e.target.value))}
              />
              <span className="range-value">{Math.round(form.autoCompressThreshold * 100)}%</span>
            </div>
          </Field>
        </Section>

        {/* 6. 存储配置 */}
        <Section title="存储配置" icon="💾">
          <Field label="历史对话存储路径" hint={`留空默认：${settings.effectiveHistoryPath}`}>
            <input className="text-input" value={form.historyPath} onChange={e => set('historyPath', e.target.value)} placeholder="留空使用工作区 .code-agent/history" />
          </Field>
          <Field label="@文件夹引用过滤规则" hint="每行一个 glob 规则">
            <textarea
              className="text-input textarea-input"
              rows={3}
              value={(form.folderIncludePatterns ?? []).join('\n')}
              onChange={e => set('folderIncludePatterns', e.target.value.split('\n').map(s => s.trim()).filter(Boolean))}
            />
          </Field>
        </Section>

        {/* 7. 高级设置 */}
        <Section title="高级设置" icon="🔧">
          <Field label="日志级别">
            <select className="text-input" value={form.logLevel} onChange={e => set('logLevel', e.target.value as any)}>
              <option value="debug">debug</option>
              <option value="info">info</option>
              <option value="warn">warn</option>
              <option value="error">error</option>
            </select>
          </Field>
          <div className="field-row">
            <Checkbox label="调试模式" checked={form.debugMode} onChange={v => set('debugMode', v)} />
            <Checkbox label="自动检测更新" checked={form.autoUpdateCheck} onChange={v => set('autoUpdateCheck', v)} />
          </div>
        </Section>

        {/* 8. 用量统计 */}
        <Section title="今日用量统计" icon="📊">
          <div className="usage-grid">
            {usage?.today ? (
              <>
                <UsageStat label="输入 Token" value={usage.today.inputTokens} />
                <UsageStat label="输出 Token" value={usage.today.outputTokens} />
                <UsageStat label="总消耗" value={usage.today.totalTokens} />
                <UsageStat label="请求次数" value={usage.today.requests} />
              </>
            ) : (
              <div className="usage-empty">今日暂无用量记录</div>
            )}
          </div>
          <div className="usage-balance">
            <button className="btn" onClick={() => post({ type: 'usage:query' })}>查询账户余额</button>
            {usage?.balance && <span className="balance-ok">💰 {usage.balance}</span>}
            {usage?.balanceError && <span className="balance-err">查询失败：{usage.balanceError}</span>}
          </div>
        </Section>
      </div>

      {/* 模型元数据编辑弹层 */}
      {editingModel && (
        <ModelEditor model={editingModel} onSave={saveModel} onCancel={() => setEditingModel(null)} />
      )}

      {/* 服务商新增/编辑弹层（V1.2.0：新增模式支持预置厂商下拉建议快捷填充） */}
      {editingProvider && (
        <ProviderEditor provider={editingProvider} presetProviders={settings.presetProviders} onSave={saveProvider} onCancel={() => setEditingProvider(null)} />
      )}
    </div>
  );
}

function Section({ title, icon, tag, children }: { title: string; icon: string; tag?: string; children: React.ReactNode }): React.ReactElement {
  const [open, setOpen] = useState(true);
  return (
    <div className="settings-section">
      <div className="section-header" onClick={() => setOpen(!open)}>
        <span className="section-title">
          {icon} {title}
          {tag && <span className="section-tag">{tag}</span>}
        </span>
        <span className="section-toggle">{open ? '▾' : '▸'}</span>
      </div>
      {open && <div className="section-body">{children}</div>}
    </div>
  );
}

function Field({ label, hint, tooltip, children }: { label: string; hint?: string; tooltip?: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="field">
      <label className="field-label">
        {label}
        {tooltip && (
          <span className="field-tooltip-icon" title={tooltip} role="img" aria-label="字段说明">
            ⓘ
          </span>
        )}
      </label>
      {children}
      {hint && <div className="field-hint">{hint}</div>}
    </div>
  );
}

function Checkbox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }): React.ReactElement {
  return (
    <label className="checkbox-field">
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function UsageStat({ label, value }: { label: string; value: number }): React.ReactElement {
  return (
    <div className="usage-stat">
      <div className="usage-stat-label">{label}</div>
      <div className="usage-stat-value">{value.toLocaleString()}</div>
    </div>
  );
}

/**
 * 模型元数据校准编辑弹层（V1.1.0）：模型列表由服务商动态拉取，仅支持校准元数据；
 * 校准值在下次拉取同步时保留（按模型 id 合并），新增模型自动套用全局默认元数据
 */
function ModelEditor({ model, onSave, onCancel }: { model: ModelMeta; onSave: (m: ModelMeta) => void; onCancel: () => void }): React.ReactElement {
  const [m, setM] = useState<ModelMeta>(model);
  const isAdd = !model.id;
  const valid = m.id.trim().length > 0 && m.name.trim() && m.contextWindow > 0 && m.maxOutputTokens > 0 && m.maxOutputTokens <= m.contextWindow;
  return (
    <div className="permission-backdrop">
      <div className="model-editor">
        <div className="permission-header">
          <span className="permission-title">{isAdd ? '添加模型' : '模型元数据校准'}</span>
        </div>
        <Field
          label="模型标识 (id)"
          hint={isAdd ? 'API 调用使用的模型名，按服务商支持的模型 id 填写（如 moonshot-v1-32k）' : 'API 调用使用的模型名，由服务商模型列表提供'}
        >
          <input className="text-input" value={m.id} readOnly={!isAdd} onChange={e => setM({ ...m, id: e.target.value })} />
        </Field>
        <Field label="展示名称">
          <input className="text-input" value={m.name} onChange={e => setM({ ...m, name: e.target.value })} />
        </Field>
        <div className="field-row">
          <Field
            label="上下文窗口 (Token)"
            tooltip="模型官方能力参数（总上下文窗口上限），用于 Token 用量统计、自动压缩阈值计算与请求参数合法性校验；默认 300000（300k），可针对该模型单独校准"
          >
            <input className="text-input" type="number" value={m.contextWindow} onChange={e => setM({ ...m, contextWindow: Number(e.target.value) })} />
          </Field>
          <Field
            label="最大输出 (Token)"
            tooltip="模型官方能力参数（单次输出能力上限），用于请求参数合法性校验；全局 max_tokens 超过该值时自动截断；默认 100000（100k），可针对该模型单独校准"
          >
            <input className="text-input" type="number" value={m.maxOutputTokens} onChange={e => setM({ ...m, maxOutputTokens: Number(e.target.value) })} />
          </Field>
        </div>
        {m.maxOutputTokens > m.contextWindow && (
          <div className="param-warning">⚠ 单次输出上限不能超过上下文窗口大小，请修正后再保存</div>
        )}
        <Field
          label="多模态能力（V1.4.0）"
          hint="图片输入支持标识：预置模型已按官方能力标记；动态拉取的模型默认不支持，若该模型支持图片理解（如 GPT-4o、Kimi 视觉模型等）请勾选；向未勾选的模型发送图片会在发送前拦截并提示"
        >
          <Checkbox label="支持图片输入（多模态模型）" checked={!!m.multimodal} onChange={v => setM({ ...m, multimodal: v })} />
        </Field>
        <div className="permission-actions">
          <button className="btn" onClick={onCancel}>取消</button>
          <button className="btn btn-primary" disabled={!valid} onClick={() => onSave(m)}>保存</button>
        </div>
      </div>
    </div>
  );
}

/**
 * 服务商新增/编辑弹层（V1.1.0 多模型接入，V1.2.0 交互优化）
 * 必填：服务商名称、接口 Base URL；API Key 选填（掩码显示与显隐切换，支持先新增后补密钥）；
 * 新增模式下名称与 Base URL 为带下拉建议的复合输入框：选中预置厂商自动填充名称与官方 Base URL，
 * 支持手动编辑自定义内容，兼容私有化部署/自定义代理场景；API Key 保持手动填写不预置
 */
function ProviderEditor({
  provider,
  presetProviders,
  onSave,
  onCancel
}: {
  provider: ProviderInfo;
  presetProviders: Array<{ id: string; name: string; baseUrl: string; hasFallbackModels: boolean; note?: string }>;
  onSave: (p: { name: string; baseUrl: string; apiKey?: string; clearApiKey?: boolean; presetId?: string; forceCreate?: boolean }) => void;
  onCancel: () => void;
}): React.ReactElement {
  const isEdit = !!provider.id;
  const [name, setName] = useState(provider.name);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [clearKey, setClearKey] = useState(false);
  /** V1.3.0 强制创建：模型拉取失败时仍完成服务商创建，后续手动添加模型（仅新增模式生效） */
  const [forceCreate, setForceCreate] = useState(false);
  /** 当前展开的建议下拉（空为收起） */
  const [openSuggest, setOpenSuggest] = useState<'' | 'name' | 'url'>('');
  /** 选中的预置厂商 id（随提交上报，服务端据此使用稳定 id 匹配兜底模型数据） */
  const [selectedPresetId, setSelectedPresetId] = useState('');
  const nameValid = name.trim().length > 0;
  const urlValid = /^https?:\/\/.+/i.test(baseUrl.trim());
  const selectedPreset = presetProviders.find(p => p.id === selectedPresetId);

  /** 手动编辑后同步校验预置匹配：内容偏离预置配置时清除 presetId，避免误带 */
  const syncPresetMatch = (nextName: string, nextUrl: string) => {
    const hit = presetProviders.find(
      p => p.name === nextName.trim() && p.baseUrl === nextUrl.trim().replace(/\/+$/, '')
    );
    setSelectedPresetId(hit ? hit.id : '');
  };

  const pickPreset = (p: { id: string; name: string; baseUrl: string }, field: 'name' | 'url') => {
    setOpenSuggest('');
    if (field === 'name') {
      // 选中名称建议：名称与官方 Base URL 成对填充，与预置配置完全匹配
      setName(p.name);
      setBaseUrl(p.baseUrl);
      setSelectedPresetId(p.id);
    } else {
      // 选中 URL 建议：填充 Base URL，名称为空时同步填充；
      // 经匹配校验判定 presetId：名称已被用户自定义时不携带预置 id，避免「自定义网关 + 官方兜底模型」错配落库
      setBaseUrl(p.baseUrl);
      const nextName = name.trim() ? name : p.name;
      if (!name.trim()) {
        setName(p.name);
      }
      syncPresetMatch(nextName, p.baseUrl);
    }
  };

  return (
    <div className="permission-backdrop">
      <div className="model-editor">
        <div className="permission-header">
          <span className="permission-title">{isEdit ? `编辑服务商 · ${provider.name}` : '新增模型服务商'}</span>
        </div>
        <Field
          label="服务商名称"
          tooltip="服务商展示名称，用于设置页分组与底部模型切换下拉框的服务商标识，如：月之暗面 Kimi、智谱 AI。新增时点击 ▾ 可展开预置厂商快捷选择，也可手动输入任意自定义名称"
          hint="必填；新增时支持从下拉选择预置厂商自动填充"
        >
          <div className="suggest-wrap">
            <div className="suggest-input-row">
              <input
                className="text-input"
                placeholder="如：月之暗面 Kimi"
                value={name}
                onChange={e => {
                  setName(e.target.value);
                  syncPresetMatch(e.target.value, baseUrl);
                }}
              />
              {!isEdit && (
                <button
                  type="button"
                  className={`suggest-btn${openSuggest === 'name' ? ' suggest-btn-on' : ''}`}
                  title="展开预置服务商建议"
                  onClick={() => setOpenSuggest(openSuggest === 'name' ? '' : 'name')}
                >
                  ▾
                </button>
              )}
            </div>
            {openSuggest === 'name' && (
              <PresetSuggestList presets={presetProviders} onPick={p => pickPreset(p, 'name')} onClose={() => setOpenSuggest('')} />
            )}
          </div>
        </Field>
        <Field
          label="接口 Base URL"
          tooltip="OpenAI 兼容协议的接口地址，模型列表与对话请求均基于该地址调用（/models、/chat/completions）。新增时点击 ▾ 可展开预置厂商官方地址，也可手动输入私有化部署/自定义代理地址"
          hint="必填，如 https://api.moonshot.cn/v1；支持手动编辑自定义地址"
        >
          <div className="suggest-wrap">
            <div className="suggest-input-row">
              <input
                className={`text-input${urlValid ? '' : ' input-invalid'}`}
                placeholder="如：https://api.moonshot.cn/v1"
                value={baseUrl}
                onChange={e => {
                  setBaseUrl(e.target.value);
                  syncPresetMatch(name, e.target.value);
                }}
              />
              {!isEdit && (
                <button
                  type="button"
                  className={`suggest-btn${openSuggest === 'url' ? ' suggest-btn-on' : ''}`}
                  title="展开预置服务商官方地址"
                  onClick={() => setOpenSuggest(openSuggest === 'url' ? '' : 'url')}
                >
                  ▾
                </button>
              )}
            </div>
            {openSuggest === 'url' && (
              <PresetSuggestList presets={presetProviders} onPick={p => pickPreset(p, 'url')} onClose={() => setOpenSuggest('')} />
            )}
          </div>
        </Field>
        {!isEdit && selectedPreset?.note && (
          <div className="param-warning">⚠ {selectedPreset.note}</div>
        )}
        <Field
          label="API Key"
          tooltip="服务商密钥，按服务商独立加密存储于系统密钥库（SecretStorage），不写入任何项目文件与持久化数据。选填：无密钥新增时将使用预置模型列表，后续补充密钥后自动同步最新模型；编辑时留空表示保持现有密钥不变"
          hint={isEdit && provider.hasApiKey ? '已配置密钥：留空保持现状，输入新值覆盖，或勾选清除密钥' : '选填：无密钥时使用预置模型列表，后续可随时补充'}
        >
          <div className="api-key-row">
            <input
              type={showKey ? 'text' : 'password'}
              className="text-input api-key-input"
              placeholder={isEdit && provider.hasApiKey ? '留空保持现有密钥' : '选填，可稍后补充'}
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            <button
              className={`api-key-toggle${showKey ? ' api-key-toggle-on' : ''}`}
              title={showKey ? '隐藏 API Key' : '显示 API Key'}
              onClick={() => setShowKey(v => !v)}
              disabled={!apiKey}
            >
              {showKey ? '🙈' : '👁'}
            </button>
          </div>
        </Field>
        {isEdit && provider.hasApiKey && (
          <Checkbox label="清除已配置的密钥" checked={clearKey} onChange={setClearKey} />
        )}
        {!isEdit && (
          <Checkbox label="仍要创建（模型拉取失败时强制创建，手动添加模型）" checked={forceCreate} onChange={setForceCreate} />
        )}
        {!urlValid && baseUrl.trim() && <div className="param-warning">⚠ 接口 Base URL 格式不正确，请检查输入</div>}
        <div className="permission-actions">
          <button className="btn" onClick={onCancel}>取消</button>
          <button
            className="btn btn-primary"
            disabled={!nameValid || !urlValid}
            onClick={() =>
              onSave({
                name: name.trim(),
                baseUrl: baseUrl.trim(),
                apiKey: apiKey || undefined,
                clearApiKey: clearKey || undefined,
                presetId: !isEdit && selectedPresetId ? selectedPresetId : undefined,
                forceCreate: !isEdit && forceCreate ? true : undefined
              })
            }
          >
            {isEdit ? '保存' : '新增并拉取模型'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 预置厂商建议下拉列表（V1.2.0 新增服务商交互优化）：
 * 展示厂商名称 + 官方 Base URL，点击选中自动填充；透明遮罩实现点击外部关闭
 */
function PresetSuggestList({
  presets,
  onPick,
  onClose
}: {
  presets: Array<{ id: string; name: string; baseUrl: string; hasFallbackModels: boolean; note?: string }>;
  onPick: (p: { id: string; name: string; baseUrl: string }) => void;
  onClose: () => void;
}): React.ReactElement {
  return (
    <>
      <div className="suggest-backdrop" onClick={onClose} />
      <div className="suggest-list">
        {presets.map(p => (
          <div key={p.id} className="suggest-item" onClick={() => onPick(p)} title={p.note ?? p.baseUrl}>
            <span className="suggest-item-name">
              {p.name}
              {p.hasFallbackModels && <span className="suggest-item-tag">预置模型</span>}
            </span>
            <span className="suggest-item-url">{p.baseUrl}</span>
          </div>
        ))}
        <div className="suggest-item suggest-item-hint">选择后自动填充名称与官方 Base URL，仍可手动修改为自定义内容</div>
      </div>
    </>
  );
}

function fmtWindow(n: number): string {
  return n >= 1024 ? `${(n / 1024).toFixed(0)}K` : String(n);
}
