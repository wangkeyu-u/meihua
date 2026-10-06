import { uiError } from './ui-error';
import { useEffect, useState } from 'react';
import { Brain, Plus, Trash2, X } from 'lucide-react';
import type { MemoryDraft, MemoryEntry, ExperienceEntry } from './types';

const localDateTime = (value: string) => { const date = new Date(value); return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
const empty = (): MemoryDraft => ({ content: '', kind: 'preference', scope: 'workspace', enabled: true });

export function MemoryDialog({ workspace, disabled, enabled, onClose, onSource }: { workspace: string; disabled: boolean; enabled: boolean; onClose: () => void; onSource: (id: string) => void }) {
  const [experiences, setExperiences] = useState<ExperienceEntry[]>([]);
  const [tab, setTab] = useState<'personal' | 'experience'>('personal');
  const [items, setItems] = useState<MemoryEntry[]>([]);
  const blank = (): MemoryDraft => ({ ...empty(), scope: workspace ? 'workspace' : 'global' });
  const [draft, setDraft] = useState<MemoryDraft>(blank);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { window.zhuge.listExperiences().then(setExperiences).catch((err) => setError(uiError(err))); window.zhuge.listMemories().then(setItems).catch((err) => setError(uiError(err))); }, []);
  const visible = items.filter((item) => (item.scope === 'global' || item.workspace === workspace) && item.content.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const selected = items.find((item) => item.id === draft.id);
  async function save() {
    setBusy(true); setError('');
    try { setItems(await window.zhuge.saveMemory(draft)); setDraft(blank()); }
    catch (err) { setError(uiError(err)); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!draft.id) return;
    setBusy(true); setError('');
    try { setItems(await window.zhuge.deleteMemory(draft.id)); setDraft(blank()); }
    catch (err) { setError(uiError(err)); }
    finally { setBusy(false); }
  }
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="management-card" role="dialog" aria-modal="true" aria-labelledby="memory-title">
    <div className="settings-head"><div><span className="eyebrow">跨会话使用</span><h2 id="memory-title"><Brain size={20} /> 梅花的记忆</h2></div><button aria-label="关闭记忆" onClick={onClose}><X size={20} /></button></div>
    <p className="settings-intro">这里保存你长期使用的偏好和项目事实。新对话会读取适用的记忆，你可以随时修改、停用或删除。</p>
    {!enabled && <p className="management-notice">记忆已停用，后续任务不会注入保存的记忆；已有对话内容仍会保留。可以在“设置 → 个人指令”重新启用。</p>}
    <div className="management-navigation" role="group" aria-label="记忆分类"><button aria-pressed={tab === 'personal'} onClick={() => setTab('personal')}>偏好与事实</button><button aria-pressed={tab === 'experience'} onClick={() => setTab('experience')}>任务经验 · {experiences.filter((item) => item.status === 'candidate').length} 待检查</button></div>
    {tab === 'experience' ? <div style={{ overflowY: 'auto' }}><p className="settings-hint">这里只保存已经通过检查、且有本地来源证据的任务结果。你启用后才会在相关任务中参考；来源文件变化后会停止使用。</p>{experiences.filter((item) => item.status !== 'rejected').map((item) => <section className="management-origin" key={item.id}><p>{item.summary}</p><p className="settings-hint">{item.sources.map((source) => source.path).join(' · ')} · {item.status === 'candidate' ? '待检查' : '已启用'}</p><button onClick={() => onSource(item.sessionId)}>查看来源对话</button><button disabled={disabled || busy} onClick={async () => { setBusy(true); try { setExperiences(await window.zhuge.decideExperience(item.id, item.status === 'candidate' ? 'approved' : 'rejected')); } catch (error) { setError(uiError(error)); } finally { setBusy(false); } }}>{item.status === 'candidate' ? '启用这条经验' : '停用'}</button>{item.status === 'candidate' && <button disabled={disabled || busy} onClick={async () => { try { setExperiences(await window.zhuge.decideExperience(item.id, 'rejected')); } catch (error) { setError(uiError(error)); } }}>不保留</button>}</section>)}{!experiences.some((item) => item.status !== 'rejected') && <p className="panel-hint">完成有来源证据的任务后，会在这里出现经验候选。</p>}{error && <p role="alert" className="settings-error">{error}</p>}</div> : <div className="management-layout"><div className="management-list"><input aria-label="搜索记忆" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索记忆内容" /><button className="management-add" disabled={busy} onClick={() => setDraft(blank())}><Plus size={14} /> 添加记忆</button>
      {visible.map((item) => <button key={item.id} disabled={busy} className={draft.id === item.id ? 'selected' : ''} onClick={() => { setDraft({ id: item.id, content: item.content, kind: item.kind, scope: item.scope, enabled: item.enabled, topic: item.topic, expiresAt: item.expiresAt }); setError(''); }}><strong>{item.content}</strong><small>{item.scope === 'global' ? '通用' : '当前文件夹'} · {item.kind === 'preference' ? '偏好' : '事实'}{!item.enabled ? ' · 已停用' : ''}{item.conflictIds?.length ? ' · 存在冲突' : ''}{item.expiresAt && Date.parse(item.expiresAt) <= Date.now() ? ' · 已过期' : ''}</small></button>)}
      {!visible.length && <p className="panel-hint">{query ? '没有匹配的记忆' : '还没有记忆。可以手动添加，也可以开启自动整理。'}</p>}
    </div><div className="management-form"><fieldset disabled={disabled || busy}><label>记住什么<textarea aria-label="记忆内容" value={draft.content} maxLength={1000} rows={5} onChange={(event) => setDraft({ ...draft, content: event.target.value })} placeholder="例如：汇报先写结论，再写数据依据。" /></label>
      <label>适用范围<select value={draft.scope} onChange={(event) => setDraft({ ...draft, scope: event.target.value as MemoryDraft['scope'] })}><option value="workspace" disabled={!workspace}>当前工作文件夹</option><option value="global">所有工作文件夹</option></select></label>
      <label>内容类型<select value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value as MemoryDraft['kind'] })}><option value="preference">偏好 · 每次工作都可参考</option><option value="fact">事实 · 相关任务才读取</option></select></label>
      <label>事实主题（可选，同主题不同内容会暂停使用）<input maxLength={100} value={draft.topic || ''} onChange={(event) => setDraft({ ...draft, topic: event.target.value })} placeholder="例如：报告币种" /></label>
      <label>有效期（可选）<input type="datetime-local" value={draft.expiresAt ? localDateTime(draft.expiresAt) : ''} onChange={(event) => setDraft({ ...draft, expiresAt: event.target.value ? new Date(event.target.value).toISOString() : null })} /></label>
      {selected?.conflictIds?.length ? <label className="management-check"><input type="checkbox" checked={Boolean(draft.resolveConflicts)} onChange={(event) => setDraft({ ...draft, resolveConflicts: event.target.checked })} />保留这条事实并停用冲突记录（{selected.conflictIds.length} 条）</label> : null}
      <label className="management-check"><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /> 允许梅花使用这条记忆</label>
      <div className="management-actions">{draft.id && <button className="management-delete" onClick={remove}><Trash2 size={13} /> 删除</button>}<button className="management-primary" onClick={save} disabled={!draft.content.trim() || draft.scope === 'workspace' && !workspace}>{busy ? '保存中…' : '保存记忆'}</button></div></fieldset>
      {selected && <div className="management-origin"><span>{selected.source === 'conversation' ? '从用户对话整理' : '手动添加'} · {new Date(selected.updatedAt).toLocaleDateString()}</span>{selected.sourceSessionId && <button onClick={() => onSource(selected.sourceSessionId)}>查看来源对话</button>}</div>}
      {disabled && <p className="panel-hint">任务运行期间可以查看，结束后可修改。</p>}
      {error && <p className="settings-error" role="alert">{error}</p>}
    </div></div>}
  </section></div>;
}
