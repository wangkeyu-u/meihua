import { uiError } from './ui-error';
import { useEffect, useState } from 'react';
import { Plug, Plus, Trash2, X } from 'lucide-react';
import type { McpService, McpServiceDraft, McpTool } from './types';
import { McpDiscovery } from './McpDiscovery';

const empty = (): McpServiceDraft => ({ name: '', transport: 'http', url: '', command: '', args: [], enabled: true });

export function McpDialog({ disabled, enabled, webAccess, initialQuery = '', onClose }: { disabled: boolean; enabled: boolean; webAccess: boolean; initialQuery?: string; onClose: () => void }) {
  const [view, setView] = useState<'discover' | 'manage'>('discover');
  const [items, setItems] = useState<McpService[]>([]);
  const [draft, setDraft] = useState<McpServiceDraft>(empty);
  const [selected, setSelected] = useState<McpService | null>(null);
  const [env, setEnv] = useState('');
  const [token, setToken] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [tools, setTools] = useState<McpTool[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { window.zhuge.listMcpServices().then((saved) => { setItems(saved); if (saved.length && !initialQuery) setView('manage'); }).catch((err) => setError(uiError(err))); }, []);
  function edit(item: McpService | null) {
    setSelected(item); setDraft(item ? { name: item.name, transport: item.transport, url: item.url || '', command: item.command || '', args: item.args || [], enabled: item.enabled, oauth: item.oauth } : empty());
    setEnv(''); setToken(''); setDirty(false); setTools(null); setError('');
  }
  function change(patch: Partial<McpServiceDraft>) { setDraft({ ...draft, ...patch }); setDirty(true); setTools(null); }
  async function save() {
    setBusy(true); setError('');
    try {
      const updated = await window.zhuge.saveMcpService({ ...draft, token, ...(env.trim() ? draft.transport === 'stdio' ? { env: JSON.parse(env) } : { headers: JSON.parse(env) } : {}) });
      setItems(updated); edit(updated.find((item) => item.name === draft.name && item.source === 'app') || null);
    } catch (err) { setError(uiError(err)); }
    finally { setBusy(false); }
  }
  async function remove() {
    setBusy(true); setError('');
    try { setItems(await window.zhuge.deleteMcpService(draft.name)); edit(null); }
    catch (err) { setError(uiError(err)); }
    finally { setBusy(false); }
  }
  async function test() {
    setTesting(true); setTools(null); setError('');
    try { setTools(await window.zhuge.testMcpService(draft.name)); }
    catch (err) { setError(uiError(err)); }
    finally { setTesting(false); }
  }
  const locked = disabled || busy || testing;
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="management-card" role="dialog" aria-modal="true" aria-labelledby="mcp-title">
    <div className="settings-head"><div><span className="eyebrow">连接更多能力</span><h2 id="mcp-title"><Plug size={20} /> 扩展工具 · MCP</h2></div><button aria-label="关闭 MCP 管理" onClick={onClose}><X size={20} /></button></div>
    <p className="settings-intro">按用途查找工具，梅花会自动填写连接配置。添加后检查连接，即可查看可用工具。</p>
    <div className="management-navigation" role="tablist" aria-label="扩展工具分类"><button role="tab" aria-selected={view === 'discover'} onClick={() => setView('discover')}>查找工具</button><button role="tab" aria-selected={view === 'manage'} onClick={() => setView('manage')}>已连接 · {items.length}</button><button className="mcp-manual" disabled={locked} onClick={() => { edit(null); setView('manage'); }}>手动添加</button></div>
    {!enabled && <p className="management-notice">MCP 已停用，请先在“设置 → 权限与工具”启用。</p>}
    {view === 'discover' ? <McpDiscovery disabled={disabled} online={enabled && webAccess} initialQuery={initialQuery} onAdded={(updated, name) => { setItems(updated); edit(updated.find((item) => item.name === name && item.source === 'app') || null); setView('manage'); }} /> : <div className="management-layout"><div className="management-list"><button className="management-add" disabled={busy || testing} onClick={() => edit(null)}><Plus size={14} /> 添加服务</button>
      {items.map((item) => <button key={`${item.source}:${item.name}`} disabled={busy || testing} className={selected?.name === item.name && selected.source === item.source ? 'selected' : ''} onClick={() => edit(item)}><strong>{item.name}</strong><small>{item.transport === 'http' ? '远程 HTTP' : '本机服务'} · {item.source === 'project' ? '项目配置' : '应用配置'}{!item.enabled ? ' · 已停用' : ''}</small></button>)}
      {!items.length && <p className="panel-hint">还没有连接扩展工具。</p>}
    </div><div className="management-form"><fieldset disabled={locked || selected?.source === 'project'}>
      <label>服务标识<input value={draft.name} readOnly={Boolean(selected)} maxLength={50} onChange={(event) => change({ name: event.target.value })} placeholder="例如 documents 或 calendar" /></label>
      <label>连接方式<select value={draft.transport} onChange={(event) => { change({ transport: event.target.value as McpServiceDraft['transport'], clearCredentials: true }); setEnv(''); setToken(''); }}><option value="http">服务地址 · Streamable HTTP</option><option value="stdio">本机程序 · stdio</option></select></label>
      {draft.transport === 'http' ? <><label>服务地址<input value={draft.url || ''} onChange={(event) => change({ url: event.target.value })} placeholder="https://example.com/mcp" /></label><label className="management-check"><input type="checkbox" checked={Boolean(draft.oauth)} onChange={(event) => change({ oauth: event.target.checked })} />使用浏览器登录（OAuth）</label><label>访问令牌（可选）<input type="password" autoComplete="off" value={token} onChange={(event) => { setToken(event.target.value); setDirty(true); setTools(null); }} placeholder={selected?.hasCredentials ? '已保存；留空保留' : '服务要求认证时填写'} /></label><details><summary>请求头（服务说明要求时填写）</summary><textarea aria-label="MCP 请求头" rows={3} value={env} onChange={(event) => { setEnv(event.target.value); setDirty(true); setTools(null); }} placeholder={selected?.hasCredentials ? '已有内容已保存；留空保留' : '{"X-API-Key":"你的密钥"}'} /></details></> : <><label>运行命令<input value={draft.command || ''} onChange={(event) => change({ command: event.target.value })} placeholder="例如 npx 或程序的完整路径" /></label><label>启动参数（每行一个）<textarea rows={3} value={(draft.args || []).join('\n')} onChange={(event) => change({ args: event.target.value.split('\n').filter((line) => line.trim()) })} placeholder={'例如\n-y\n你的 MCP 服务包名'} /></label><details><summary>环境变量（服务说明要求时填写）</summary><textarea aria-label="MCP 环境变量" rows={3} value={env} onChange={(event) => { setEnv(event.target.value); setDirty(true); setTools(null); }} placeholder={selected?.hasCredentials ? '已有内容已保存；留空保留' : '{"API_KEY":"你的密钥"}'} /></details></>}
      {selected?.hasCredentials && <label className="management-check"><input type="checkbox" checked={Boolean(draft.clearCredentials)} onChange={(event) => change({ clearCredentials: event.target.checked })} /> 清除已保存的认证信息</label>}
      <label className="management-check"><input type="checkbox" checked={draft.enabled} onChange={(event) => change({ enabled: event.target.checked })} /> 允许任务使用此服务</label>
      <div className="management-actions">{selected?.source === 'app' && <button className="management-delete" onClick={remove}><Trash2 size={13} /> 删除</button>}<button className="management-primary" disabled={!draft.name.trim()} onClick={save}>{busy ? '保存中…' : '保存服务'}</button></div>
    </fieldset>
      {selected?.source === 'project' && <p className="panel-hint">此服务来自当前工作目录的 .zhuge/mcp.json，请在该文件中修改。</p>}
      {selected && <button className="management-test" disabled={locked || dirty || !enabled} onClick={test}>{testing ? '正在连接，最多等待 15 秒…' : dirty ? '先保存修改，再检查连接' : '检查连接并查看工具'}</button>}
      {selected?.transport === 'http' && selected.oauth && <div className="runtime-button-row"><button disabled={locked || dirty || !enabled || !webAccess} onClick={async () => { setTesting(true); setError(''); try { await window.zhuge.loginMcpService(selected.name); } catch (error) { setError(uiError(error)); } finally { setTesting(false); } }}>登录服务</button><button disabled={locked || dirty} onClick={() => window.zhuge.logoutMcpService(selected.name).catch((error) => setError(uiError(error)))}>清除本机登录</button></div>}
      {tools && <div className="mcp-tools"><strong>连接成功 · {tools.length} 个工具</strong>{tools.map((tool) => <details key={tool.name}><summary>{tool.name}</summary><p>{tool.description || '服务未提供说明'}</p><pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre></details>)}</div>}
      {error && <p className="settings-error" role="alert">{error}</p>}
    </div></div>}
  </section></div>;
}
