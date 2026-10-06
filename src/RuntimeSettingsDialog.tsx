import { uiError } from './ui-error';
import { useEffect, useState } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import type { BackupPreview, RuntimeWarning, VerificationCommand, VerificationConfig } from './types';
import './runtime-settings.css';
import { AgentPolicyPanel } from './AgentPolicyPanel';
import type { AgentConfig, EffectiveModel, ModelProvider } from './types';

type CommandDraft = VerificationCommand & { argsText: string; outputsText: string };
const toDraft = (entry: VerificationCommand): CommandDraft => ({ ...entry, argsText: JSON.stringify(entry.args), outputsText: entry.outputs.join('\n') });
const newCommand = (): CommandDraft => toDraft({ id: crypto.randomUUID(), name: '', command: '', args: [], cwd: '.', timeoutSeconds: 120, expectedOutput: '', outputs: [] });
const size = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

export function RuntimeSettingsDialog({ disabled, onClose }: { disabled: boolean; onClose: () => void }) {
  const [models, setModels] = useState<EffectiveModel[]>([]);
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [agent, setAgent] = useState<AgentConfig | null>(null);
  const [sandbox, setSandbox] = useState({ available: false, backend: null as string | null, reason: '' });
  const [workspace, setWorkspace] = useState('');
  const [mode, setMode] = useState<VerificationConfig['mode']>('auto');
  const [commands, setCommands] = useState<CommandDraft[]>([]);
  const [retainDays, setRetainDays] = useState(0);
  const [savedDays, setSavedDays] = useState(0);
  const [warnings, setWarnings] = useState<RuntimeWarning[]>([]);
  const [preview, setPreview] = useState<BackupPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    let live = true;
    window.zhuge.runtimeSettings().then((saved) => {
      if (!live) return;
      setModels(saved.models); setProviders(saved.providers); setAgent(saved.agent); setSandbox(saved.sandbox);
      setWorkspace(saved.workspace); setMode(saved.verification?.mode || 'auto'); setCommands((saved.verification?.commands || []).map(toDraft));
      setRetainDays(saved.backups.retainDays); setSavedDays(saved.backups.retainDays); setWarnings(saved.warnings);
    }).catch((err) => { if (live) setError(uiError(err)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);
  const locked = disabled || busy || loading;
  async function run(work: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('');
    try { await work(); } catch (err) { setError(uiError(err)); }
    finally { setBusy(false); }
  }
  function change(id: string, patch: Partial<CommandDraft>) { setCommands((items) => items.map((item) => item.id === id ? { ...item, ...patch } : item)); }
  async function saveVerification() {
    await run(async () => {
      const entries = commands.map(({ argsText, outputsText, ...entry }) => ({ ...entry, args: JSON.parse(argsText), outputs: outputsText.split('\n').map((file) => file.trim()).filter(Boolean) }));
      const saved = await window.zhuge.saveVerificationConfig(workspace, { mode, commands: entries });
      setCommands(saved.commands.map(toDraft)); setNotice('项目验证已保存；已开始的验证和恢复任务继续使用原配置。');
    });
  }
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="management-card runtime-settings" role="dialog" aria-modal="true" aria-labelledby="runtime-settings-title">
      <div className="settings-head"><div><span className="eyebrow">任务可靠性</span><h2 id="runtime-settings-title">任务、工具与可靠性</h2></div><button aria-label="关闭任务设置" disabled={busy} onClick={onClose}><X size={20} /></button></div>
      <div className="runtime-settings-scroll">
        {agent && <AgentPolicyPanel initial={agent} onSaved={setModels} models={models} providers={providers} sandbox={sandbox} disabled={locked} />}
        <section><h3>项目验证</h3><p className="settings-hint">{workspace || '请先选择工作目录'}。验证命令执行前会展示目录、参数和预期结果，由你确认。</p>
          <fieldset disabled={locked || !workspace}>
            <label>验证方式<select aria-label="项目验证方式" value={mode} onChange={(event) => setMode(event.target.value as VerificationConfig['mode'])}><option value="auto">自动检测根目录 npm 脚本</option><option value="custom">自定义命令与子目录</option><option value="files">仅核对文件与已执行命令结果</option></select></label>
            {mode === 'auto' && <p className="settings-hint">修改代码后检测 test、build、lint、typecheck。没有对应脚本时，只核对文件结果。</p>}
            {mode === 'files' && <p className="settings-hint">不会运行项目测试；任务时间线会注明这个验证范围。</p>}
            {mode === 'custom' && <><p className="settings-hint">可执行程序与参数分开填写。例如 npm 配合 ["test"]，子目录填 frontend。预期文件路径相对于整个工作目录。</p>
              {commands.map((entry, index) => <div className="runtime-command" key={entry.id}>
                <div className="runtime-command-heading"><strong>验证 {index + 1}</strong><button aria-label={`移除验证 ${index + 1}`} onClick={() => setCommands(commands.filter((item) => item.id !== entry.id))}><Trash2 size={15} /></button></div>
                <div className="runtime-form-grid"><label>名称<input value={entry.name} maxLength={80} onChange={(event) => change(entry.id, { name: event.target.value })} placeholder="前端测试" /></label><label>可执行程序<input value={entry.command} maxLength={500} onChange={(event) => change(entry.id, { command: event.target.value })} placeholder="npm" /></label></div>
                <label>参数（JSON 字符串数组）<input value={entry.argsText} onChange={(event) => change(entry.id, { argsText: event.target.value })} placeholder={'["test"]'} /></label>
                <div className="runtime-form-grid"><label>工作目录内的子目录<input value={entry.cwd} maxLength={500} onChange={(event) => change(entry.id, { cwd: event.target.value })} /></label><label>超时<select value={entry.timeoutSeconds} onChange={(event) => change(entry.id, { timeoutSeconds: Number(event.target.value) })}><option value={30}>30 秒</option><option value={120}>120 秒</option><option value={300}>300 秒</option></select></label></div>
                <label>预期输出（可选，按原文匹配）<input value={entry.expectedOutput} maxLength={2000} onChange={(event) => change(entry.id, { expectedOutput: event.target.value })} /></label>
                <label>预期产物（可选，每行一个相对路径）<textarea rows={2} value={entry.outputsText} onChange={(event) => change(entry.id, { outputsText: event.target.value })} placeholder="frontend/dist/index.html" /></label>
              </div>)}
              <button className="settings-manage" disabled={commands.length >= 8} onClick={() => setCommands([...commands, newCommand()])}><Plus size={15} />添加验证命令</button></>}
            <button className="settings-manage" onClick={saveVerification}>保存项目验证</button>
          </fieldset>
        </section>
        <section><h3>文件备份</h3><p className="settings-hint">默认永久保留。按保留时间手动清理已结束任务的备份；工作文件、任务记录和升级前副本保留。清理后对应任务无法撤销。</p>
          <fieldset disabled={locked}><label>保留时间<select aria-label="文件备份保留时间" value={retainDays} onChange={(event) => { setRetainDays(Number(event.target.value)); setPreview(null); }}><option value={0}>永久保留</option><option value={7}>7 天</option><option value={30}>30 天</option><option value={90}>90 天</option></select></label>
            <div className="runtime-button-row"><button onClick={() => run(async () => { const saved = await window.zhuge.saveBackupPolicy(retainDays); setSavedDays(saved.retainDays); setPreview(null); setNotice('保留时间已保存，没有删除备份。'); })}>保存保留设置</button><button disabled={retainDays !== savedDays} onClick={() => run(async () => setPreview(await window.zhuge.previewBackupCleanup()))}>预览可清理备份</button></div>
            {preview && <div className="runtime-cleanup-preview"><p>可清理 {preview.tasks.length} 个任务的 {preview.blobs} 个备份文件，释放 {size(preview.bytes)}。保留 {preview.protectedTasks} 个任务的备份。</p>{preview.tasks.map((task) => <p key={task.id}><code>{task.id.slice(0, 8)}</code> · {task.status} · {new Date(task.completedAt).toLocaleDateString()} · {task.files} 次文件记录</p>)}<p className="settings-hint">暂停任务和未确认的修改受到保护。预览五分钟内有效，任务变化后需要重新预览。</p>
              <button className="runtime-delete" disabled={!preview.tasks.length && !preview.blobs} onClick={() => run(async () => { const result = await window.zhuge.applyBackupCleanup(preview.id); setPreview(null); setNotice(`已清理 ${result.tasks} 个任务备份，释放 ${size(result.bytes)}。${result.errors.join('；')}`); })}>删除预览中的备份</button>
            </div>}
          </fieldset>
        </section>
        <section><h3>任务数据</h3><p className="settings-hint">任务先保存到追加日志，再更新任务视图；记录恢复不会重新执行工具。旧版升级和恢复前保留原始副本。{warnings.length ? `有 ${warnings.length} 条数据状态提示，详情如下。` : '当前任务数据正常。'}</p>{warnings.map((warning) => <p className="runtime-data-warning" key={warning.id}>{warning.message}<br /><code>{warning.file}</code></p>)}<button className="settings-manage" disabled={busy} onClick={() => run(async () => { await window.zhuge.openRuntimeFolder(); })}>打开任务数据目录</button></section>
      </div>
      {error && <p className="settings-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    </section>
  </div>;
}
