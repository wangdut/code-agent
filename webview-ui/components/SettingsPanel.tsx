/**
 * 全局设置面板
 * 按模块分级：模型配置 / 推理参数 / Agent行为 / 存储配置 / 安全权限 / 高级设置 / 用量统计
 */
import React, { useEffect, useState } from 'react';
import { ModelMeta, SettingsSnapshot } from '../../src/types';
import { post } from '../vscode';

interface Props {
  settings: SettingsSnapshot;
  usage: { today: { inputTokens: number; outputTokens: number; totalTokens: number; requests: number } | null; balance?: string; balanceError?: string } | null;
  onClose: () => void;
}

export function SettingsPanel({ settings, usage, onClose }: Props): React.ReactElement {
  const [form, setForm] = useState<SettingsSnapshot>(settings);
  const [apiKey, setApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [editingModel, setEditingModel] = useState<ModelMeta | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setForm(settings);
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
        baseUrl: form.baseUrl,
        defaultModel: form.defaultModel,
        defaultMode: form.defaultMode,
        requestTimeout: Number(form.requestTimeout),
        proxy: form.proxy,
        temperature: Number(form.temperature),
        topP: Number(form.topP),
        maxTokens: clampedMaxTokens,
        frequencyPenalty: Number(form.frequencyPenalty),
        permissionMode: form.permissionMode,
        fileWritePermission: form.fileWritePermission,
        terminalAutoApprove: form.terminalAutoApprove,
        highRiskCommands: form.highRiskCommands,
        // 保存兜底：非数字/超范围回退为合法值（1-1000，默认 20）
        maxToolIterations: Math.min(1000, Math.max(1, Math.round(Number(form.maxToolIterations) || 20))),
        autoCompressThreshold: Number(form.autoCompressThreshold),
        historyPath: form.historyPath,
        folderIncludePatterns: form.folderIncludePatterns,
        logLevel: form.logLevel,
        debugMode: form.debugMode,
        autoUpdateCheck: form.autoUpdateCheck
      },
      apiKey: apiKey || undefined
    });
    setApiKey('');
    setTimeout(() => setSaving(false), 400);
  };

  const saveModel = (model: ModelMeta, oldId?: string) => {
    if (oldId) {
      post({ type: 'model:update', oldId, model });
    } else {
      post({ type: 'model:add', model });
    }
    setEditingModel(null);
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
        {/* 1. 模型配置 */}
        <Section title="模型配置" icon="🧠">
          <Field label="API Key" hint="加密存储于系统密钥库（SecretStorage）">
            <div className="api-key-row">
              <input
                type={showApiKey ? 'text' : 'password'}
                className="text-input api-key-input"
                placeholder={settings.apiKeyConfigured ? '已配置（输入新值覆盖）' : '未配置，请输入 API Key'}
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
              <button
                className={`api-key-toggle${showApiKey ? ' api-key-toggle-on' : ''}`}
                title={showApiKey ? '隐藏 API Key' : '显示 API Key'}
                onClick={() => setShowApiKey(v => !v)}
                disabled={!apiKey}
              >
                {showApiKey ? '🙈' : '👁'}
              </button>
            </div>
            {/* 实时视觉反馈：配置状态与待保存状态 */}
            <div className="api-key-status">
              <span className={`api-key-chip${settings.apiKeyConfigured ? ' api-key-chip-ok' : ' api-key-chip-none'}`}>
                {settings.apiKeyConfigured ? '✓ 已配置' : '未配置'}
              </span>
              {apiKey && <span className="api-key-chip api-key-chip-pending">输入新值，点击“保存设置”生效</span>}
            </div>
          </Field>
          <Field label="接口 Base URL" hint="OpenAI 兼容协议服务地址">
            <input className="text-input" value={form.baseUrl} onChange={e => set('baseUrl', e.target.value)} />
          </Field>
          <div className="field">
            <label className="field-label">模型列表</label>
            <div className="model-list">
              {form.models.map(m => (
                <div key={m.id} className="model-item">
                  <div className="model-item-info">
                    <span className="model-name">{m.name}</span>
                    <span className="model-meta">
                      {m.id} · 上下文 {fmtWindow(m.contextWindow)} · 输出 {fmtWindow(m.maxOutputTokens)}
                    </span>
                  </div>
                  <div className="model-item-actions">
                    <button className="mini-btn" onClick={() => setEditingModel({ ...m })}>编辑</button>
                    <button className="mini-btn danger" onClick={() => post({ type: 'model:delete', modelId: m.id })}>删除</button>
                  </div>
                </div>
              ))}
              <button className="btn add-model-btn" onClick={() => setEditingModel({ id: '', name: '', contextWindow: 131072, maxOutputTokens: 8192, pricing: '按量计费' })}>
                ＋ 新增模型
              </button>
            </div>
          </div>
          <Field label="默认模型">
            <select className="text-input" value={form.defaultModel} onChange={e => set('defaultModel', e.target.value)}>
              {form.models.map(m => (
                <option key={m.id} value={m.id}>{m.name} ({m.id})</option>
              ))}
            </select>
          </Field>
          <div className="field-row">
            <Field label="请求超时 (ms)">
              <input className="text-input" type="number" value={form.requestTimeout} onChange={e => set('requestTimeout', Number(e.target.value))} />
            </Field>
            <Field label="网络代理" hint="如 http://127.0.0.1:7890">
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

        {/* 3. Agent 行为 */}
        <Section title="Agent 行为" icon="🤖">
          <Field label="默认执行模式">
            <select className="text-input" value={form.defaultMode} onChange={e => set('defaultMode', e.target.value as 'chat' | 'agent')}>
              <option value="agent">智能体模式（完整工具集）</option>
              <option value="chat">对话模式（只读文件问答）</option>
            </select>
          </Field>
          <Field
            label="最大工具调用轮次"
            tooltip="单轮任务中 Agent 可自主调度工具的最大次数。正整数，范围 1-1000，默认 20；输入非数字、负数或超范围值将自动回退为合法值。保存后即时生效，作用于所有新建与续接的会话。"
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
          <div className="field-row">
            <Checkbox label="工作区内终端命令免确认" checked={form.terminalAutoApprove} onChange={v => set('terminalAutoApprove', v)} />
            <Checkbox label="高危命令拦截（破坏性命令强制二次确认）" checked={form.highRiskCommands} onChange={v => set('highRiskCommands', v)} />
          </div>
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

        {/* 4. 存储配置 */}
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

        {/* 5. 安全权限 */}
        <Section title="安全权限" icon="🛡">
          <Field label="权限模式" hint="与底部快捷栏同步；仅作用于智能体模式下工作区内文件的修改，工作区外文件任何模式下只读">
            <select className="text-input" value={form.permissionMode} onChange={e => set('permissionMode', e.target.value as 'ask' | 'auto')}>
              <option value="ask">询问模式（推荐，修改文件前提示确认）</option>
              <option value="auto">全自动模式（修改文件自动放行）</option>
            </select>
          </Field>
          <Field label="工作区内文件修改权限">
            <select className="text-input" value={form.fileWritePermission} onChange={e => set('fileWritePermission', e.target.value as 'auto' | 'ask')}>
              <option value="ask">询问模式（每次修改前展示 diff 预览）</option>
              <option value="auto">全自动模式（无需确认）</option>
            </select>
          </Field>
        </Section>

        {/* 6. 高级设置 */}
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

        {/* 7. 用量统计 */}
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

      {/* 模型编辑弹层 */}
      {editingModel && (
        <ModelEditor model={editingModel} onSave={m => saveModel(m, editingModel.id || undefined)} onCancel={() => setEditingModel(null)} />
      )}
    </div>
  );
}

function Section({ title, icon, children }: { title: string; icon: string; children: React.ReactNode }): React.ReactElement {
  const [open, setOpen] = useState(true);
  return (
    <div className="settings-section">
      <div className="section-header" onClick={() => setOpen(!open)}>
        <span className="section-title">{icon} {title}</span>
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

function ModelEditor({ model, onSave, onCancel }: { model: ModelMeta; onSave: (m: ModelMeta) => void; onCancel: () => void }): React.ReactElement {
  const [m, setM] = useState<ModelMeta>(model);
  const valid = m.id.trim() && m.name.trim() && m.contextWindow > 0 && m.maxOutputTokens > 0 && m.maxOutputTokens <= m.contextWindow;
  return (
    <div className="permission-backdrop">
      <div className="model-editor">
        <div className="permission-header">
          <span className="permission-title">{model.id ? '编辑模型' : '新增模型'}</span>
        </div>
        <Field label="模型标识 (id)" hint="API 调用使用的模型名，如 deepseek-v4-pro">
          <input className="text-input" value={m.id} onChange={e => setM({ ...m, id: e.target.value })} />
        </Field>
        <Field label="展示名称">
          <input className="text-input" value={m.name} onChange={e => setM({ ...m, name: e.target.value })} />
        </Field>
        <div className="field-row">
          <Field
            label="上下文窗口 (Token)"
            tooltip="模型官方能力参数（总上下文窗口上限），用于 Token 用量统计、自动压缩阈值计算与请求参数合法性校验，不直接控制单次生成长度"
          >
            <input className="text-input" type="number" value={m.contextWindow} onChange={e => setM({ ...m, contextWindow: Number(e.target.value) })} />
          </Field>
          <Field
            label="最大输出 (Token)"
            tooltip="模型官方能力参数（单次输出能力上限），用于请求参数合法性校验；全局 max_tokens 超过该值时自动截断"
          >
            <input className="text-input" type="number" value={m.maxOutputTokens} onChange={e => setM({ ...m, maxOutputTokens: Number(e.target.value) })} />
          </Field>
        </div>
        {m.maxOutputTokens > m.contextWindow && (
          <div className="param-warning">⚠ 单次输出上限不能超过上下文窗口大小，请修正后再保存</div>
        )}
        <Field label="计费类型">
          <input className="text-input" value={m.pricing} onChange={e => setM({ ...m, pricing: e.target.value })} />
        </Field>
        <div className="permission-actions">
          <button className="btn" onClick={onCancel}>取消</button>
          <button className="btn btn-primary" disabled={!valid} onClick={() => onSave(m)}>保存</button>
        </div>
      </div>
    </div>
  );
}

function fmtWindow(n: number): string {
  return n >= 1024 ? `${(n / 1024).toFixed(0)}K` : String(n);
}
