import { uiError } from './ui-error';
import { useEffect, useState } from 'react';
import { Clock3, Pause, Play, RotateCcw, Download, X } from 'lucide-react';
import type { DurableTask, TaskCheckpoint, TaskStatus } from './types';
import './task-timeline.css';

const labels: Record<TaskStatus, string> = { queued: '排队', planning: '规划', running: '执行', waiting_approval: '等待确认', paused: '已暂停', verifying: '验证中', completed: '已完成', failed: '未完成', cancelled: '已取消' };
const terminal = new Set(['completed', 'failed', 'cancelled']);
const phase = (tool: string) => ['write_file', 'edit_file', 'export_office'].includes(tool) ? '修改文件' : tool === 'run_command' ? '运行命令' : tool.startsWith('read') || ['search_text', 'list_files', 'search_memory'].includes(tool) ? '读取资料' : '调用工具';
const duration = (ms: number) => `${Math.max(0, ms / 1000).toFixed(1)} 秒`;

export function TaskTimeline({ sessionId, busy, onResume, onRefresh, onError }: { sessionId: string; busy: boolean; onResume: (id: string) => Promise<void>; onRefresh: () => Promise<void>; onError: (error: string) => void }) {
  const [tasks, setTasks] = useState<DurableTask[]>([]);
  const [action, setAction] = useState('');
  const [checkpointTask, setCheckpointTask] = useState('');
  const [checkpoints, setCheckpoints] = useState<TaskCheckpoint[]>([]);
  const [diff, setDiff] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    let live = true;
    setTasks([]); setCheckpointTask(''); setDiff(''); setNotice('');
    window.zhuge.listTasks(sessionId).then((records) => { if (live) setTasks(records); }).catch((error) => { if (live) onError(uiError(error)); });
    const dispose = window.zhuge.onEvent((event) => {
      if (event.type !== 'runtime-task' || event.task.sessionId !== sessionId || event.task.parentId || !live) return;
      setTasks((current) => [event.task, ...current.filter((record) => record.id !== event.task.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    });
    return () => { live = false; dispose(); };
  }, [sessionId]);
  const run = async (id: string, work: () => Promise<unknown>) => {
    setAction(id); setNotice('');
    try {
      await work();
      setTasks(await window.zhuge.listTasks(sessionId));
      if (checkpointTask === id) setCheckpoints(await window.zhuge.taskCheckpoints(id));
      await onRefresh();
    } catch (error) { onError(uiError(error)); }
    finally { setAction(''); }
  };
  if (!tasks.length) return null;
  return <section className="task-timeline" aria-label="任务时间线">
    <div className="task-timeline-heading"><Clock3 size={15} /><strong>任务进度</strong><span>只展示实际动作与结果</span></div>
    {tasks.map((record, index) => <details className={`runtime-record ${record.status}`} key={record.id} open={index === 0 ? true : undefined}>
      <summary><span className="runtime-dot" /><strong>{labels[record.status]}</strong><span>{new Date(record.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span><small>{record.diagnostics.retries > 0 ? `修复 ${record.diagnostics.retries} 次 · ` : ''}{record.steps.length} 步</small></summary>
      <div className="runtime-body">
        {record.interrupted && <p className="runtime-interrupted">这个任务上次运行时被中断。恢复后会先检查已有结果，所有操作仍需确认。</p>}
        {record.summary && <p>{record.summary}</p>}
        {record.error && <p className="runtime-error">{record.error.message}</p>}
        {record.workflow && <div className="workflow-nodes"><p>{record.workflow.summary}</p>{record.workflow.nodes.map((node) => <details key={node.id}><summary><strong>{node.title}</strong> · {{ research: '研究', document: '文档', action: '操作' }[node.role] || node.role} · {{ queued: '等待前置步骤', running: '进行中', completed: '已核对', failed: '未完成', blocked: '前置步骤未完成', paused: '暂停' }[node.status] || node.status}</summary><p>{node.summary}</p>{node.dependencies.length > 0 && <p>依赖：{node.dependencies.join('、')}</p>}{node.outputs.length > 0 && <p>产物：{node.outputs.join('、')}</p>}{node.taskId && <button onClick={() => run(record.id, async () => { setCheckpointTask(record.id); setCheckpoints(await window.zhuge.taskCheckpoints(node.taskId!)); })}>查看这个步骤的文件修改</button>}</details>)}</div>}
        {record.modelLedger && <details className="runtime-verification"><summary>模型用量 · {record.modelLedger.length} 次调用 · {record.modelLedger.reduce((sum, call) => sum + (call.totalTokens ?? call.reservedTokens), 0).toLocaleString()} Token（含估算与预留）</summary>{record.modelLedger.map((call) => <p key={call.id}>{call.stage} · {call.provider}/{call.model} · {call.status} · {call.totalTokens ?? call.reservedTokens} Token · {call.budgetSource === 'reservation' ? '结果不明，按预留计入预算' : call.usageSource === 'provider' ? '供应商用量' : call.status === 'running' ? '请求前预留' : '估算'} · {typeof call.costUsd === 'number' ? `$${call.costUsd.toFixed(6)}` : typeof call.estimatedCostUsd === 'number' ? `估算 $${call.estimatedCostUsd.toFixed(6)}` : '费用未知'}</p>)}</details>}
        <ol className="runtime-steps">{record.steps.map((step) => <li key={step.id}><details><summary><span>{phase(step.tool)}</span><code>{step.tool}</code><small>{step.status === 'running' ? '进行中' : step.status === 'completed' ? '通过' : step.status === 'interrupted' ? '中断' : '失败'}{step.durationMs !== null ? ` · ${duration(step.durationMs)}` : ''}</small></summary>
          <div><p>输入：{step.inputSummary}</p>{step.result && <><p>{step.result.summary}</p>{step.result.exitCode !== undefined && <p>退出码：{step.result.exitCode}</p>}{Boolean(step.result.changedFiles?.length) && <p>变更：{step.result.changedFiles?.join('、')}</p>}{step.result.error && <p className="runtime-error">{step.result.error.code}：{step.result.error.message}</p>}{step.result.warnings?.map((warning) => <p key={warning}>{warning}</p>)}</>}</div>
        </details></li>)}</ol>
        {record.verification.map(({ attempt, result }, i) => <details className="runtime-verification" key={i}><summary>验证 {attempt} · {result.ok ? '通过' : '未通过'} · {result.summary}</summary>{result.warnings?.map((warning) => <p key={warning}>{warning}</p>)}{result.checks.map((check, j) => <p key={j}>{check.ok ? '✓' : '×'} {check.name}{check.exitCode !== undefined ? ` · exit ${check.exitCode}` : ''}{check.error ? ` · ${check.error}` : ''}</p>)}</details>)}
        {record.checkpointsExpiredAt && <p>文件备份已于 {new Date(record.checkpointsExpiredAt).toLocaleString()} 清理，任务记录仍保留。</p>}
        {record.events.filter((event) => ['context_compacted', 'context_compaction_failed', 'plan_revised', 'agent_message'].includes(event.type)).map((event) => <p key={event.id} className="settings-hint">{{ context_compacted: '历史上下文已压缩并保存检查点', context_compaction_failed: '历史压缩未成功，完整记录已保留', plan_revised: '已确认并调整任务分工', agent_message: '已记录代理间的定向消息' }[event.type]}{event.payload.summary ? `：${event.payload.summary}` : ''}</p>)}
        {record.events.filter((event) => event.type === 'checkpoint_restored').map((event) => <p key={event.id}>已撤销：{event.payload.changedFiles?.join('、')}</p>)}
        <div className="runtime-diagnostics"><span>{record.provider} / {record.model}</span><span>模型 {record.diagnostics.modelCalls} 次 · 工具 {record.diagnostics.toolCalls} 次 · 验证 {record.diagnostics.verificationAttempts} 次</span>{record.startedAt && <span>{duration(Date.parse(record.completedAt || record.updatedAt) - Date.parse(record.startedAt))}</span>}</div>
        <div className="runtime-actions">
          {record.status === 'paused' && <button disabled={busy || Boolean(action)} onClick={() => run(record.id, () => onResume(record.id))}><Play size={13} />恢复</button>}
          {!terminal.has(record.status) && record.status !== 'paused' && <button disabled={Boolean(action)} onClick={() => run(record.id, () => window.zhuge.pauseTask(record.id))}><Pause size={13} />暂停</button>}
          {!terminal.has(record.status) && <button disabled={Boolean(action)} onClick={() => run(record.id, () => window.zhuge.cancelTask(record.id))}><X size={13} />取消</button>}
          <button disabled={Boolean(action)} onClick={() => run(record.id, async () => { setCheckpointTask(record.id); setCheckpoints(await window.zhuge.taskCheckpoints(record.id)); setDiff(''); })}>文件变更</button>
          {(terminal.has(record.status) || record.status === 'paused') && <><button disabled={busy || Boolean(action) || Boolean(record.checkpointsExpiredAt)} onClick={() => run(record.id, async () => { const files = await window.zhuge.undoTask(record.id); setNotice(`已撤销 ${files.join('、')}`); })}><RotateCcw size={13} />撤销最近修改</button><button disabled={busy || Boolean(action) || Boolean(record.checkpointsExpiredAt)} onClick={() => run(record.id, async () => { const files = await window.zhuge.restoreTask(record.id); setNotice(`已恢复 ${files.join('、') || '任务开始状态'}`); })}>恢复任务前文件</button></>}
          <button disabled={Boolean(action)} onClick={() => run(record.id, async () => { const file = await window.zhuge.exportTaskDiagnostics(record.id); if (file) setNotice(`诊断已导出：${file}`); })}><Download size={13} />诊断</button>
        </div>
        {checkpointTask === record.id && <div className="runtime-checkpoints">{!checkpoints.length ? <p>{record.checkpointsExpiredAt ? '这个任务的文件备份已清理。' : '本轮没有文件工具产生的 checkpoint。'}</p> : checkpoints.map((checkpoint) => <button key={checkpoint.id} disabled={Boolean(action)} onClick={() => run(record.id, async () => setDiff(await window.zhuge.checkpointDiff(checkpoint.taskId, checkpoint.id)))}>{checkpoint.path} · {checkpoint.status === 'restored' ? '已撤销' : checkpoint.status === 'prepared' ? '状态待核对' : checkpoint.status === 'unchanged' ? '未修改' : `${checkpoint.before.exists ? '修改' : '新建'} · ${checkpoint.after?.size || 0} B`}</button>)}{diff && <pre>{diff}</pre>}</div>}
      </div>
    </details>)}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
