import { uiError } from './ui-error';
import { InputRequestDialog } from './InputRequestDialog';
import { useEffect, useRef, useState } from 'react';
import { Archive, ArrowRight, Bot, Brain, Plug, Paperclip, Search, PanelRight, Check, ChevronDown, ExternalLink, FileText, Flower2, Folder, Globe2, LoaderCircle, PanelLeftClose, Plus, Send, Settings2, ShieldCheck, Snowflake, Sparkles, Square, Terminal, Upload, X } from 'lucide-react';
import type { AgentEvent, AgentStatus, CustomAgent, JumpShortcut, Message, ModelProvider, ReviewMessage, Session, SessionSummary, Settings, SkillSummary, DurableTask } from './types';
import { WorkspacePanel } from './WorkspacePanel';
import { TaskTimeline } from './TaskTimeline';
import { SessionRow } from './SessionRow';
import { Markdown, CopyButton } from './content';
import { MemoryDialog } from './MemoryDialog';
import { McpDialog } from './McpDialog';
import { RuntimeSettingsDialog } from './RuntimeSettingsDialog';
import './management.css';
import type { Attachment } from './types';
import brandIcon from '../assets/meihua/brand-mark.png';
import plumBranch from '../assets/meihua/snow-plum-branch.png';
import workingVideo from '../assets/meihua/snow-plum-working.mp4';

const examples = [
  { icon: FileText, title: '总结资料', description: '读文件，提炼重点', prompt: '请阅读这个文件夹中的资料，提炼主要结论、待办事项和需要我确认的问题。' },
  { icon: Folder, title: '整理文件', description: '先看现状，再给方案', prompt: '请查看这个文件夹里的文件，给我一个清楚的整理方案。先说明准备怎样分类和命名，等我确认后再修改文件。' },
  { icon: Globe2, title: '准备工作计划', description: '把想法拆成可执行步骤', prompt: '请根据我接下来描述的目标，帮我列一份简单的工作计划，说明每一步的成果和需要我提供的资料。' },
];

export function App() {
  const [query, setQuery] = useState('');
  const [archived, setArchived] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const [files, setFiles] = useState<Attachment[]>([]);
  const [pickingFiles, setPickingFiles] = useState(false);
  const searchInput = useRef<HTMLInputElement | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [agents, setAgents] = useState<CustomAgent[]>([]);
  const [agentId, setAgentId] = useState('');
  const [workMode, setWorkMode] = useState<'execute' | 'plan' | 'ask' | 'workflow'>('execute');
  const [showAgents, setShowAgents] = useState(false);
  const [shortcuts, setShortcuts] = useState<JumpShortcut[]>([]);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [statuses, setStatuses] = useState<Record<string, AgentStatus>>({});
  const [selected, setSelected] = useState<Session | null>(null);
  const [draft, setDraft] = useState('');
  const [stream, setStream] = useState('');
  const [running, setRunning] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [pendingApprovals, setPendingApprovals] = useState<Extract<AgentEvent, { type: 'approval' }>[]>([]);
  const [inputRequests, setInputRequests] = useState<Extract<AgentEvent, { type: 'input-request' }>[]>([]);
  const approval = pendingApprovals[0] || null;
  const inputRequest = !approval ? inputRequests[0] : null;
  const workflowRecords = useRef(new Map<string, DurableTask>());
  const [steerNodes, setSteerNodes] = useState<{ id: string; title: string; status: string }[]>([]);
  const [steerNode, setSteerNode] = useState('');
  const activeTurns = useRef(new Map<string, string>());
  const runningSessions = useRef(new Set<string>());
  const workflowSessions = useRef(new Set<string>());
  const [backgroundBusy, setBackgroundBusy] = useState(false);
  const canLeaveRunning = !running || Boolean(selected && workflowSessions.current.has(selected.id));
  const [showSettings, setShowSettings] = useState(false);
  const [showMemory, setShowMemory] = useState(false);
  const [showMcp, setShowMcp] = useState(false);
  const [showRuntimeSettings, setShowRuntimeSettings] = useState(false);
  const [runtimeNotice, setRuntimeNotice] = useState('');
  const [mcpQuery, setMcpQuery] = useState('');
  const [memoryNotice, setMemoryNotice] = useState('');
  const [showQuickConnect, setShowQuickConnect] = useState(false);
  const [switchingModel, setSwitchingModel] = useState(false);
  const [sidebar, setSidebar] = useState(true);
  const [error, setError] = useState('');
  const submitting = useRef(false);
  const sendingSteer = useRef(false);
  const sessionLoad = useRef(0);
  const selectedId = useRef<string | null>(null);
  const openRequested = useRef<(id: string) => void>(() => {});
  const bottom = useRef<HTMLDivElement | null>(null);
  const composer = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    window.zhuge.initialize().then(({ settings: initial, providers: availableProviders, sessions: saved, agents: savedAgents, shortcuts: savedShortcuts, statuses: initialStatuses, runtimeWarnings }) => {
      setSettings(initial);
      if (runtimeWarnings?.length) {
        const unavailable = runtimeWarnings.filter((warning) => warning.kind !== 'recovered' && warning.kind !== 'projection-pending').length;
        const recovered = runtimeWarnings.filter((warning) => warning.kind === 'recovered').length;
        const pending = runtimeWarnings.filter((warning) => warning.kind === 'projection-pending').length;
        setRuntimeNotice([unavailable ? `${unavailable} 个任务记录无法读取，原文件保留。` : '', recovered ? `${recovered} 个任务记录已从日志恢复，没有重新执行工具。` : '', pending ? `${pending} 个任务已保存到日志，任务视图等待重建。` : ''].filter(Boolean).join(''));
      }
      setDraft(localStorage.getItem(`zhuge-draft:new:${initial.workspace}`) || '');
      setProviders(availableProviders);
      setSessions(saved);
      setAgents(savedAgents);
      setShortcuts(savedShortcuts);
      setStatuses(Object.fromEntries(initialStatuses.map((status) => [status.id, status])));
    }).catch((err) => setError(uiError(err)));
    return window.zhuge.onEvent((event) => {
      if (event.type === 'open-session') { openRequested.current(event.id); return; }
      if (event.type === 'memory-notice') { setMemoryNotice(event.message); return; }
      if (event.type === 'sessions') { setSessions(event.sessions); return; }
      if (event.type === 'agents') { setAgents(event.agents); return; }
      if (event.type === 'shortcuts') { setShortcuts(event.shortcuts); return; }
      if (event.type === 'agent-status') { setStatuses((current) => ({ ...current, [event.status.id]: event.status })); return; }
      if (event.type === 'approval-closed') { setPendingApprovals((current) => current.filter((item) => item.id !== event.id)); return; }
      if (event.type === 'approval') { setPendingApprovals((current) => current.some((item) => item.id === event.id) ? current : [...current, event]); return; }
      if (event.type === 'runtime-task' && event.task.mode === 'workflow') { workflowRecords.current.set(event.task.sessionId, event.task); if (selectedId.current === event.task.sessionId) setSteerNodes(event.task.workflow?.nodes || []); }
      if (event.type === 'input-request') setInputRequests((items) => [...items.filter((item) => item.requestId !== event.requestId), event]);
      if (event.type === 'input-request-closed') setInputRequests((items) => items.filter((item) => item.requestId !== event.requestId));
      if (event.type === 'runtime-task' && !['workflow-node'].includes(event.task.mode) && !['completed', 'failed', 'cancelled'].includes(event.task.status)) activeTurns.current.set(event.task.sessionId, event.task.id);
      if (event.type === 'runtime-task' && event.task.mode === 'workflow' && !['completed', 'failed', 'cancelled'].includes(event.task.status)) workflowSessions.current.add(event.task.sessionId);
      if (event.type === 'running') { if (event.running) runningSessions.current.add(event.id); else { runningSessions.current.delete(event.id); workflowSessions.current.delete(event.id); } setBackgroundBusy(runningSessions.current.size > 0); }
      if (!('id' in event) || event.id !== selectedId.current) return;
      if (event.type === 'message') setSelected((current) => current && { ...current, messages: [...current.messages, event.message] });
      if (event.type === 'delta') setStream((value) => value + event.text);
      if (event.type === 'message-complete') {
        setSelected((current) => current && { ...current, messages: [...current.messages, event.message] });
        setStream('');
      }
      if (event.type === 'running') setRunning(event.running);
      if (event.type === 'error') setError(event.message);
      if (event.type === 'tool-update') setSelected((current) => current && { ...current, messages: current.messages.map((item) => item.role === 'tool' && item.callId === event.callId ? { ...item, state: event.state, output: event.output } : item) });
      if (event.type === 'review-decision') setSelected((current) => current && { ...current, pendingReview: null, messages: current.messages.map((item) => item.role === 'review' && item.id === event.reviewId ? { ...item, decision: event.decision, effectivePrompt: event.effectivePrompt } : item) });
    });
  }, []);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => { document.documentElement.dataset.theme = settings?.theme === 'system' || !settings?.theme ? (media.matches ? 'dark' : 'light') : settings.theme; document.documentElement.dataset.fontSize = settings?.fontSize || 'medium'; };
    apply(); media.addEventListener('change', apply); return () => media.removeEventListener('change', apply);
  }, [settings?.theme, settings?.fontSize]);

  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'smooth' }); }, [selected?.messages, stream, running]);
  useEffect(() => {
    const dialog = document.querySelector<HTMLElement>('.modal-backdrop:last-child [role="dialog"]');
    if (!dialog) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () => [...dialog.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary')].filter((item) => item.offsetParent !== null);
    focusable()[0]?.focus();
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !approval) {
        event.preventDefault();
        if (inputRequest) { dialog.querySelector<HTMLButtonElement>('[data-input-cancel]')?.click(); return; }
        if (showRuntimeSettings) setShowRuntimeSettings(false);
        else if (showMemory) setShowMemory(false);
        else if (showMcp) setShowMcp(false);
        else if (showQuickConnect) setShowQuickConnect(false);
        else if (showShortcuts) setShowShortcuts(false);
        else if (showAgents) setShowAgents(false);
        else if (showSettings) setShowSettings(false);
      }
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', handler);
    return () => { document.removeEventListener('keydown', handler); if (previousFocus && document.contains(previousFocus)) previousFocus.focus(); };
  }, [showSettings, showQuickConnect, showAgents, showShortcuts, showMemory, showMcp, showRuntimeSettings, approval, inputRequest?.requestId]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!event.metaKey || event.ctrlKey || event.altKey) return;
      if (approval || inputRequest) return;
      if (event.key === ',') { event.preventDefault(); setShowSettings(true); return; }
      if (event.key.toLowerCase() === 'k' && !showSettings && !showQuickConnect && !showAgents && !showShortcuts && !showMemory && !showMcp && !approval) { event.preventDefault(); setSidebar(true); requestAnimationFrame(() => searchInput.current?.focus()); return; }
      if (!event.shiftKey && event.key.toLowerCase() === 'n') {
        if (showSettings || showQuickConnect || showAgents || showShortcuts || showMemory || showMcp || showRuntimeSettings || approval) return;
        event.preventDefault();
        newSession();
        return;
      }
      const digit = /^Digit([1-9])$/.exec(event.code)?.[1];
      if (!event.shiftKey || !digit) return;
      const shortcut = shortcuts.find((item) => item.key === digit);
      if (shortcut) {
        event.preventDefault();
        window.zhuge.openShortcut(shortcut.id).catch((err) => setError(uiError(err)));
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [shortcuts, running, reviewing, showSettings, showQuickConnect, showAgents, showShortcuts, showMemory, showMcp, showRuntimeSettings, approval, inputRequest?.requestId, settings?.workspace, pickingFiles]);

  async function openSession(id: string) {
    if (!canLeaveRunning || reviewing || pickingFiles || submitting.current) return;
    const request = ++sessionLoad.current;
    try {
      const session = await window.zhuge.loadSession(id);
      if (request !== sessionLoad.current) return;
      if (!session) throw new Error('会话不存在');
      if (session.workspace !== settings?.workspace) {
        const updated = await window.zhuge.switchWorkspace(session.workspace);
        if (request !== sessionLoad.current) return;
        setSettings(updated);
      }
      setArchived(Boolean(session.archived));
      selectedId.current = id;
      setSelected(session); setRunning(runningSessions.current.has(id));
      setDraft(localStorage.getItem(`zhuge-draft:${id}`) || ''); setFiles([]);
      setStream('');
      setError('');
    } catch (err) { setError(uiError(err)); }
  }

  openRequested.current = openSession;

  function newSession() {
    if (!canLeaveRunning || reviewing || pickingFiles || submitting.current || showSettings || showQuickConnect || showAgents || showShortcuts || showMemory || showMcp || showRuntimeSettings || approval) return;
    sessionLoad.current++;
    setArchived(false); setQuery('');
    selectedId.current = null;
    setSelected(null); setRunning(false);
    if (backgroundBusy) setWorkMode('workflow');
    setStream(''); setDraft(localStorage.getItem(`zhuge-draft:new:${settings?.workspace}`) || ''); setFiles([]); setError('');
    requestAnimationFrame(() => composer.current?.focus());
  }

  function useExample(prompt: string) {
    if (running || reviewing || selected?.pendingReview || selected?.archived) return;
    setDraft(prompt);
    localStorage.setItem(`zhuge-draft:${selectedId.current || `new:${settings?.workspace}`}`, prompt);
    requestAnimationFrame(() => composer.current?.focus());
  }

  async function submit(text = draft) {
    if (running && !reviewing) {
      if (sendingSteer.current || !text.trim() || !selectedId.current) return;
      sendingSteer.current = true;
      setDraft(''); setError('');
      try { await window.zhuge.steerPrompt(selectedId.current, text.trim(), activeTurns.current.get(selectedId.current), steerNode || undefined); localStorage.removeItem(`zhuge-draft:${selectedId.current}`); }
      catch (err) { setError(uiError(err)); setDraft(text); }
      finally { sendingSteer.current = false; }
      return;
    }
    if (submitting.current || !text.trim() || running || reviewing || switchingModel || pickingFiles || selected?.archived || selected?.pendingReview) return;
    if (!settings?.workspace) { setError('请先创建或选择一个工作文件夹'); return; }
    if (needsModelSetup) { openModelSetup(); return; }
    submitting.current = true;
    if (workMode === 'execute' || agentId === 'reviewer') setReviewing(true);
    else setRunning(true);
    setDraft(''); setError('');
    try {
      let id = selectedId.current;
      if (!id) {
        const session = await window.zhuge.createSession();
        id = session.id;
        selectedId.current = id;
        setSelected(session);
        setSessions((items) => [session, ...items]);
      }
      setSelected((current) => current && current.title === '新任务' ? { ...current, title: text.trim().slice(0, 32) } : current);
      if (workMode === 'execute' || agentId === 'reviewer') setSelected(await window.zhuge.reviewPrompt(id, text.trim(), agentId || null, files.map((file) => file.id)));
      else if (workMode === 'workflow') { workflowSessions.current.add(id); runningSessions.current.add(id); await window.zhuge.runWorkflow(id, text.trim(), files.map((file) => file.id), agentId || null); setSelected(await window.zhuge.loadSession(id)); }
      else { await window.zhuge.runDirectPrompt(id, text.trim(), workMode, agentId || null, files.map((file) => file.id)); setSelected(await window.zhuge.loadSession(id)); }
      localStorage.removeItem(`zhuge-draft:${id}`); localStorage.removeItem(`zhuge-draft:new:${settings.workspace}`); setFiles([]);
    }
    catch (err) { if (workMode === 'workflow' && selectedId.current) { runningSessions.current.delete(selectedId.current); workflowSessions.current.delete(selectedId.current); } setError(uiError(err)); setDraft(text); }
    finally { submitting.current = false; setReviewing(false); setRunning(Boolean(selectedId.current && runningSessions.current.has(selectedId.current))); }
  }

  useEffect(() => { setSteerNode(''); setSteerNodes(selected?.id ? workflowRecords.current.get(selected.id)?.workflow?.nodes || [] : []); }, [selected?.id]);

  async function decideReview(review: ReviewMessage, choice: 'original' | 'suggested' | 'edit' | 'reviewed') {
    if (submitting.current || !selected || selected.archived || selected.pendingReview !== review.id || running || reviewing) return;
    const id = selected.id;
    submitting.current = true;
    setError('');
    if (choice === 'edit') {
      try { setSelected(await window.zhuge.reviseReview(id, review.id)); setFiles(review.contextFiles?.map(({ id, name, text, truncated }) => ({ id, name, chars: text.length, truncated })) || []); setDraft(review.reviewOnly && review.suggestedPrompt.trim() ? review.suggestedPrompt : review.originalPrompt); }
      catch (err) { setError(uiError(err)); }
      finally { submitting.current = false; }
      return;
    }
    if (choice === 'reviewed') {
      try { setSelected(await window.zhuge.completeReview(id, review.id)); }
      catch (err) { setError(uiError(err)); }
      finally { submitting.current = false; }
      return;
    }
    setRunning(true);
    try { await window.zhuge.sendReviewedPrompt(id, review.id, choice); }
    catch (err) {
      setError(uiError(err));
      setRunning(false);
      try { setSelected(await window.zhuge.loadSession(id)); } catch { /* keep the visible review */ }
    } finally { submitting.current = false; setRunning(false); }
  }

  async function executePlan() {
    if (!selected?.pendingPlan || running || reviewing || submitting.current || selected.archived) return;
    const id = selected.id;
    submitting.current = true; setRunning(true); setError('');
    try { await window.zhuge.executePlan(id); setSelected(await window.zhuge.loadSession(id)); }
    catch (err) { setError(uiError(err)); setSelected(await window.zhuge.loadSession(id)); }
    finally { submitting.current = false; setRunning(false); }
  }

  async function activateWorkspace(pick: () => Promise<string | null>) {
    if (running || reviewing || pickingFiles || submitting.current) return;
    ++sessionLoad.current;
    try {
      const workspace = await pick();
      if (workspace) {
        setSettings((await window.zhuge.initialize()).settings);
        setArchived(false); setQuery('');
        selectedId.current = null; setSelected(null);
        setStream(''); setDraft(localStorage.getItem(`zhuge-draft:new:${workspace}`) || ''); setFiles([]); setError('');
      }
    } catch (err) { setError(uiError(err)); }
  }

  async function chooseWorkspace() { await activateWorkspace(() => window.zhuge.selectWorkspace()); }
  async function createDefaultWorkspace() { await activateWorkspace(() => window.zhuge.createDefaultWorkspace()); }

  async function answer(approved: boolean) {
    if (!approval) return;
    const id = approval.id;
    try { await window.zhuge.answerApproval(id, approved); setPendingApprovals((current) => current.filter((item) => item.id !== id)); }
    catch (err) { setError(uiError(err)); }
  }

  async function switchModel(choice: string) {
    if (choice === '__settings__') { setShowSettings(true); return; }
    if (choice === '__connect__') { openModelSetup(); return; }
    if (!settings || running || reviewing || switchingModel) return;
    const split = choice.indexOf(':');
    if (split < 0) return;
    const nextProvider = choice.slice(0, split) as Settings['provider'];
    const nextModel = choice.slice(split + 1);
    const profile = settings.modelProfiles[nextProvider];
    if (!profile || !nextModel) return;
    const reviewer = agentId === 'reviewer';
    if (nextProvider === displayedProvider && nextModel === displayedModel) return;
    setSwitchingModel(true); setError('');
    try {
      setSettings(await window.zhuge.saveSettings({
        ...settings, provider: reviewer ? settings.provider : nextProvider,
        model: reviewer ? settings.model : nextModel,
        baseUrl: reviewer ? settings.baseUrl : profile.baseUrl,
        apiKey: '',
        reviewProvider: reviewer ? (nextProvider === settings.provider ? 'same' : nextProvider) : settings.reviewProvider,
        reviewModel: reviewer ? nextModel : settings.reviewProvider === 'same' ? (profile.reviewModel || nextModel) : settings.reviewModel,
        reviewBaseUrl: reviewer ? (nextProvider === settings.provider ? '' : profile.baseUrl) : settings.reviewBaseUrl,
        reviewApiKey: '',
      }));
    } catch (err) { setError(uiError(err)); }
    finally { setSwitchingModel(false); }
  }

  async function switchWorkspace(workspace: string) {
    if (running || reviewing || pickingFiles || submitting.current) return;
    ++sessionLoad.current;
    try { const updated = await window.zhuge.switchWorkspace(workspace); setSettings(updated); setArchived(false); setQuery(''); selectedId.current = null; setSelected(null); setFiles([]); setStream(''); setDraft(localStorage.getItem(`zhuge-draft:new:${workspace}`) || ''); setError(''); }
    catch (err) { setError(uiError(err)); }
  }
  async function sessionAction(item: SessionSummary, action: string, title?: string) {
    if (running || reviewing || pickingFiles || submitting.current) return false;
    sessionLoad.current++;
    try {
      if (action === 'export') { await window.zhuge.exportSession(item.id); return true; }
      if (action === 'fork') { const next = await window.zhuge.forkSession(item.id); selectedId.current = next.id; setSelected(next); setDraft(''); setFiles([]); setArchived(false); setQuery(''); setStream(''); return true; }
      if (!['rename', 'pin', 'archive'].includes(action)) return false;
      const next = await window.zhuge.updateSession(item.id, action === 'rename' ? { title } : action === 'pin' ? { pinned: !item.pinned } : { archived: !item.archived });
      if (selectedId.current === item.id) { if (next.archived) { selectedId.current = null; setSelected(null); setFiles([]); setDraft(''); setStream(''); } else setSelected(next); }
      return true;
    } catch (err) { setError(uiError(err)); return false; }
  }
  async function addAttachments() {
    setPickingFiles(true);
    try { const added = await window.zhuge.pickAttachments(); if (files.length + added.length > 8 || [...files, ...added].reduce((sum, file) => sum + file.chars, 0) > 120000) throw new Error('每次最多 8 个附件，总内容不超过 120000 字符'); setFiles((current) => [...current, ...added]); }
    catch (err) { setError(uiError(err)); }
    finally { setPickingFiles(false); }
  }

  const messages: Message[] = selected?.messages || [];
  const visibleSessions = sessions.filter((item) => (!settings?.workspace || item.workspace === settings.workspace) && Boolean(item.archived) === archived && (!query.trim() || `${item.title} ${item.searchText || ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())));
  const workspaceName = settings?.workspace?.split('/').filter(Boolean).at(-1) || '尚未选择文件夹';
  const needsModelSetup = Boolean(settings && ((settings.provider === 'compatible' ? !settings.model || !settings.baseUrl : !settings.hasKey) || (settings.reviewProvider === 'compatible' ? !settings.reviewModel || !settings.reviewBaseUrl : settings.reviewProvider !== 'same' && !settings.reviewHasKey)));
  function openModelSetup() {
    if (settings?.provider === 'compatible' || settings?.reviewProvider !== 'same' && settings?.reviewProvider !== settings?.provider) setShowSettings(true);
    else setShowQuickConnect(true);
  }
  const displayedModel = agentId === 'reviewer' ? settings?.reviewModel : settings?.model;
  const displayedProvider = agentId === 'reviewer' && settings?.reviewProvider !== 'same' ? settings?.reviewProvider : settings?.provider;
  const modelChoices = providers.map((provider) => {
    const profile = settings?.modelProfiles[provider.id];
    const connected = provider.id === 'compatible' ? Boolean(profile?.baseUrl && profile?.model) : Boolean(settings?.keyStatus[provider.id]);
    if (!connected) return null;
    const ids = [...new Set([...provider.models.map((item) => item.id), ...(profile?.customModels || []), profile?.model, profile?.reviewModel].filter((id): id is string => Boolean(id)))];
    return { provider, ids };
  }).filter((item): item is { provider: ModelProvider; ids: string[] } => Boolean(item));
  const selectedModelChoice = !needsModelSetup || modelChoices.some((item) => item.provider.id === displayedProvider)
    ? `${displayedProvider}:${displayedModel}` : '__connect__';

  return <div className="app-shell">
    <aside className={`sidebar ${sidebar ? '' : 'collapsed'}`}>
      <div className="brand"><img className="brand-mark" src={brandIcon} alt="" /><div><strong>梅花</strong><span>本地工作台</span></div><Snowflake className="brand-snow" size={19} aria-hidden="true" /></div>
      <button className="new-task" onClick={newSession}><Plus size={17} /> 新建任务 <span>⌘ N</span></button>
      <div className="sidebar-label">工作文件夹</div>
      <button className="workspace" onClick={chooseWorkspace} disabled={backgroundBusy || running || reviewing} title={settings?.workspace || ''}><Folder size={18} /><span>{workspaceName}</span><ChevronDown size={14} /></button>
      {Boolean(settings?.recentWorkspaces?.length) && <select className="recent-workspaces" aria-label="切换最近项目" value={settings?.workspace || ''} disabled={backgroundBusy || running || reviewing || pickingFiles} onChange={(event) => switchWorkspace(event.target.value)}>{[...new Set([settings?.workspace || '', ...(settings?.recentWorkspaces || [])])].filter(Boolean).map((workspace) => <option key={workspace} value={workspace}>{workspace.split('/').at(-1)} · {workspace}</option>)}</select>}
      <div className="session-search"><Search size={14} /><input ref={searchInput} aria-label="搜索任务" placeholder="搜索任务与内容 ⌘K" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
      <div className="sidebar-label recent">{archived ? '已归档' : '最近任务'} <span>{visibleSessions.length}</span><button className="icon-button" aria-label={archived ? '查看最近任务' : '查看已归档任务'} title={archived ? '返回最近任务' : '已归档任务'} onClick={() => setArchived(!archived)}><Archive size={14} /></button></div>
      <div className="session-list">{visibleSessions.map((item) => <SessionRow key={item.id} item={item} active={selected?.id === item.id} disabled={!canLeaveRunning || reviewing || pickingFiles} onOpen={() => openSession(item.id)} onAction={(action, title) => sessionAction(item, action, title)} />)}{!visibleSessions.length && <p className="session-empty">{query ? '未找到匹配的任务' : archived ? '归档后的任务会显示在这里' : '新任务会保存在这里'}</p>}</div>
      <div className="studio"><div className="sidebar-label">工作进度</div><div className="studio-list">{[{ id: 'reviewer', name: '确认任务' }, { id: 'default', name: '梅花' }, ...agents].map((agent) => <PixelAgent key={agent.id} status={{ ...(statuses[agent.id] || { id: agent.id, phase: 'idle', detail: '' }), name: agent.name }} />)}{Object.values(statuses).filter((status) => selected && status.id.startsWith(`workflow:${selected.id}:`) && status.phase !== 'idle').slice(0, 6).map((status) => <PixelAgent key={status.id} status={status} />)}</div></div>
      <div className="sidebar-bottom"><button className="settings-link agent-link" onClick={() => setShowAgents(true)}><Bot size={17} /> 我的助手 <span>{agents.length}</span></button>
        <button className="settings-link" onClick={() => setShowMemory(true)}><Brain size={17} /> 记忆</button>
        <button className="settings-link" onClick={() => { setMcpQuery(''); setShowMcp(true); }}><Plug size={17} /> 扩展工具</button>
        <button className="settings-link" onClick={() => setShowSettings(true)}><Settings2 size={17} /> 设置</button>
        <div className="privacy"><ShieldCheck size={14} /><span>文件留在本机 · 内容发送至所选模型</span></div></div>
    </aside>

    <main className="main-panel">
      <header className="topbar"><button className="icon-button sidebar-toggle" onClick={() => setSidebar(!sidebar)} title="切换侧边栏" aria-label="切换侧边栏"><PanelLeftClose size={18} /></button>
        <div className="breadcrumb"><span>{workspaceName}</span><span className="slash">/</span><strong>{selected?.title || '新的对话'}</strong></div>
        <div className="top-right"><button className="icon-button" aria-label="文件与 Git 变更" title="文件与 Git 变更" disabled={!settings?.workspace} onClick={() => setShowFiles(!showFiles)}><PanelRight size={18} /></button><span className="local-pill"><span /> 本机运行</span></div>
      </header>

      <div className={`workbench-body ${showFiles ? 'with-panel' : ''}`}><div className="chat-column">
      {(running || reviewing) && !window.matchMedia('(prefers-reduced-motion: reduce)').matches && <div className="work-video" aria-hidden="true"><video src={workingVideo} autoPlay muted loop playsInline preload="auto" /><div className="work-video-mask" /></div>}
      <div className={`content-scroll ${running || reviewing ? 'working' : ''}`}>
        <div className="task-timeline-slot">
          {selected && <TaskTimeline sessionId={selected.id} busy={running || reviewing} onError={setError}
            onRefresh={async () => { if (!running && !reviewing) { const session = await window.zhuge.loadSession(selected.id); if (session) setSelected(session); } }}
            onResume={async (id) => { setRunning(true); setError(''); try { await window.zhuge.resumeTask(id); const session = await window.zhuge.loadSession(selected.id); if (session) setSelected(session); } finally { setRunning(false); setStream(''); } }} />}
        </div>
        {messages.length === 0 && !stream && !running && !reviewing ? <div className="welcome">
          <div className="welcome-hero"><div className="welcome-copy"><div className="welcome-symbol"><Flower2 size={25} strokeWidth={1.6} /></div>
            <h1>今天想先完成什么？</h1>
            <p>{agentId === 'reviewer' ? '写下你的想法，梅花会帮你补充遗漏的细节。' : workMode === 'plan' ? '先看资料、定步骤，准备好后再决定是否执行。' : workMode === 'ask' ? '直接提问，梅花可以查资料，但不会修改文件。' : '用平常说话的方式交代任务。梅花会先和你确认做法，再动手处理。'}</p></div>
            <img className="welcome-plum" src={plumBranch} alt="" aria-hidden="true" /></div>
          {settings && (!settings.workspace || needsModelSetup) && <section className="getting-started" aria-label="开始使用梅花">
            <div className="getting-started-heading"><span>开始使用</span><strong>{settings.workspace ? '连接 AI，梅花就能开始工作' : '先给梅花一个工作文件夹'}</strong></div>
            <p>{settings.workspace ? '选择模型服务商并填入连接密钥。连接一次，以后直接说任务即可。' : '梅花只会在你选定的文件夹中处理文件。可以一键创建，也可以用已有文件夹。'}</p>
            <div className="getting-started-actions">{settings.workspace ? <button className="start-primary" onClick={openModelSetup}>连接 AI 模型 <ArrowRight size={15} /></button> : <><button className="start-primary" onClick={createDefaultWorkspace}>创建我的工作台 <ArrowRight size={15} /></button><button className="start-secondary" onClick={chooseWorkspace}>选择已有文件夹</button></>}</div>
            {!settings.workspace && <small>“梅花工作台”会建在 macOS 的“文稿”文件夹中，生成的文件也保存在那里。</small>}
          </section>}
          <div className="examples-heading"><div className="examples-label">从一个常见任务开始</div><Snowflake className="examples-snow" size={30} aria-hidden="true" /></div>
          <div className="examples">{examples.map(({ icon: Icon, title, description, prompt }) => <button key={title} onClick={() => useExample(prompt)}><span className="example-icon"><Icon size={17} /></span><span className="example-copy"><strong>{title}</strong><small>{description}</small></span><ArrowRight size={16} className="example-arrow" /></button>)}</div>
        </div> : <div className={`conversation ${messages.length === 0 ? 'empty-running' : ''}`}>
          {messages.map((message, index) => message.role === 'tool' ? <ToolMessage key={index} message={message} busy={running || reviewing} onMcp={(name) => { setMcpQuery(name); setShowMcp(true); }} /> : message.role === 'review' ? <ReviewCard key={message.id} review={message} pending={selected?.pendingReview === message.id} busy={running || reviewing || Boolean(selected?.archived)} onDecision={decideReview} /> : <div key={index} className={`message ${message.role}`}><div className="avatar">{message.role === 'user' ? '你' : '梅'}</div><div className="message-body"><div className="message-label">{message.role === 'user' ? `你${message.mode === 'plan' ? ' · 先做计划' : message.mode === 'ask' ? ' · 仅问答' : message.mode === 'steer' ? ' · 运行中补充' : message.mode === 'approved' ? ' · 确认计划' : ''}` : '梅花'}</div><div className="message-content">{message.role === 'assistant' ? <Markdown text={message.content} /> : message.content}</div>{Boolean(message.attachments?.length) && <div className="message-attachments">{message.attachments?.map((file, i) => <span key={i}><Paperclip size={12} />{file.name}{file.truncated ? '（节选）' : ''}</span>)}</div>}<CopyButton text={message.content} label="复制消息" /></div></div>)}
          {selected?.pendingPlan && !selected.archived && <section className="plan-approval"><div><strong>计划已准备好</strong><span>先看上方方案；确认后，梅花会按这份计划执行。</span></div><button disabled={running || reviewing} onClick={() => { setWorkMode('plan'); composer.current?.focus(); }}>调整计划</button><button disabled={running || reviewing} onClick={() => window.zhuge.dismissPlan(selected.id).then(setSelected).catch((err) => setError(uiError(err)))}>放弃计划</button><button className="primary" disabled={running || reviewing} onClick={executePlan}>按计划执行 <ArrowRight size={14} /></button></section>}
          {stream && <div className="message assistant"><div className="avatar">梅</div><div className="message-body"><div className="message-label">梅花 · 正在回复</div><div className="message-content"><Markdown text={stream} /></div></div></div>}
          {(running || reviewing) && !stream && <div className="thinking"><span className="thinking-dots"><i /><i /><i /></span> {reviewing ? '梅花正在确认你的任务' : '梅花正在处理任务'}</div>}
          <div ref={bottom} />
        </div>}
      </div>

      <div className="composer-wrap">{runtimeNotice && <div className="memory-notice" role="status"><span>{runtimeNotice}</span><button onClick={() => setShowRuntimeSettings(true)}>查看任务数据</button><button aria-label="关闭任务数据提示" onClick={() => setRuntimeNotice('')}><X size={13} /></button></div>}{memoryNotice && <div className="memory-notice" role="status"><span>{memoryNotice}</span><button onClick={() => setShowMemory(true)}>查看记忆</button><button aria-label="关闭记忆提示" onClick={() => setMemoryNotice('')}><X size={13} /></button></div>}{error && <div className="error-banner" role="alert"><span>{error}</span><button aria-label="关闭错误提示" onClick={() => setError('')}><X size={15} /></button></div>}
        <div className="jump-bar"><span>{running || reviewing ? '梅花工作时，休息一下' : '快捷入口'}</span><div>{shortcuts.map((shortcut) => <button key={shortcut.id} title={`${shortcut.url} · ⌘⇧${shortcut.key}`} onClick={() => window.zhuge.openShortcut(shortcut.id).catch((err) => setError(uiError(err)))}><ExternalLink size={12} /> {shortcut.name} <kbd>{shortcut.key}</kbd></button>)}</div><button className="jump-settings" title="自定义跳转键" aria-label="自定义跳转键" onClick={() => setShowShortcuts(true)}><Plus size={14} /></button></div>
        <div className="composer">{files.length > 0 && <div className="attachment-list">{files.map((file) => <span key={file.id}><Paperclip size={12} />{file.name}{file.truncated ? ' · 节选' : ''}<button disabled={running || reviewing} aria-label={`移除附件 ${file.name}`} onClick={() => setFiles((current) => current.filter((item) => item.id !== file.id))}><X size={12} /></button></span>)}<small>文件内容将发送给所选模型</small></div>}<textarea ref={composer} aria-label="任务内容" value={draft} onChange={(event) => { setDraft(event.target.value); localStorage.setItem(`zhuge-draft:${selectedId.current || `new:${settings?.workspace}`}`, event.target.value); }} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && (settings?.sendShortcut !== 'mod-enter' || event.metaKey || event.ctrlKey)) { event.preventDefault(); submit(); } }} placeholder={selected?.archived ? '此任务已归档，请先在任务菜单中恢复' : selected?.pendingReview ? '请先处理上方的需求检查' : running ? '补充指令，梅花会在下一步读取…' : '描述你想完成的任务…'} rows={2} disabled={reviewing || Boolean(selected?.pendingReview) || Boolean(selected?.archived)} /><div className="composer-actions"><div className="composer-left">{running && steerNodes.length > 0 && <label className="work-mode-picker"><select aria-label="补充指令的对象" value={steerNode} onChange={(event) => setSteerNode(event.target.value)}><option value="">补充给整个任务</option>{steerNodes.filter((node) => !["completed", "failed"].includes(node.status)).map((node) => <option value={node.id} key={node.id}>{node.title}</option>)}</select></label>}<button className="icon-button" aria-label="添加文件附件" title="添加文本或办公文档" disabled={running || reviewing || pickingFiles || Boolean(selected?.pendingReview) || Boolean(selected?.archived)} onClick={addAttachments}><Paperclip size={16} /></button><button type="button" className="workspace-tag" onClick={chooseWorkspace} disabled={backgroundBusy || running || reviewing || pickingFiles} title={settings?.workspace || "选择一个允许梅花处理文件的文件夹"}><Folder size={14} /> {settings?.workspace ? workspaceName : "选择文件夹"}</button><label className="agent-picker"><Bot size={14} /><select aria-label="选择智能体" value={agentId} disabled={running || reviewing || Boolean(selected?.pendingReview) || Boolean(selected?.archived)} onChange={(event) => { setAgentId(event.target.value); if (event.target.value === "reviewer") setWorkMode("execute"); }}><option value="">梅花帮我完成</option><option value="reviewer">先帮我理清想法</option>{agents.map((agent) => <option value={agent.id} key={agent.id}>{agent.name}</option>)}</select></label><label className="work-mode-picker"><select aria-label="选择工作方式" value={workMode} disabled={backgroundBusy || running || reviewing || agentId === "reviewer" || Boolean(selected?.pendingReview) || Boolean(selected?.archived)} onChange={(event) => setWorkMode(event.target.value as "execute" | "plan" | "ask" | "workflow")}><option value="execute">直接执行</option><option value="workflow">分工完成</option><option value="plan">先做计划</option><option value="ask">仅问答</option></select></label><span className="keyboard-hint">{settings?.sendShortcut === 'mod-enter' ? '⌘ / Ctrl + Enter 发送' : 'Enter 发送 · Shift + Enter 换行'}</span></div><div className="composer-right"><label className="model-quick-picker"><select aria-label={agentId === 'reviewer' ? '选择需求检查模型' : '选择执行模型'} title={agentId === 'reviewer' ? '选择需求检查模型' : '选择执行模型'} value={selectedModelChoice} disabled={backgroundBusy || running || reviewing || switchingModel} onChange={(event) => switchModel(event.target.value)}>{selectedModelChoice === '__connect__' && <option value="__connect__">连接或选择模型…</option>}{modelChoices.map(({ provider, ids }) => <optgroup label={provider.name} key={provider.id}>{ids.map((id) => <option value={`${provider.id}:${id}`} key={id}>{provider.models.find((item) => item.id === id)?.name || id}</option>)}</optgroup>)}<option value="__connect__">连接其他模型…</option><option value="__settings__">模型与 API 设置…</option></select></label>{running && !reviewing && <button className="send-button" title="补充指令" aria-label="补充指令" disabled={!draft.trim()} onClick={() => submit()}><Send size={17} /></button>}{running || reviewing ? <button className="send-button stop" title="停止" aria-label="停止任务" onClick={() => window.zhuge.stop(selectedId.current || undefined).catch((err) => setError(uiError(err)))}><Square size={15} fill="currentColor" /></button> : <button className="send-button" title="发送" aria-label="发送任务" disabled={!draft.trim() || Boolean(selected?.pendingReview) || Boolean(selected?.archived) || switchingModel || pickingFiles} onClick={() => submit()}><Send size={17} /></button>}</div></div></div>
        <div className="composer-note">{running ? '任务进行中 · 可以在这里补充指令，梅花会在下一步读取' : agentId === 'reviewer' ? '本次只检查需求，不执行任务' : workMode === 'plan' ? '先做计划 · 可读取资料，不会修改文件或执行命令' : workMode === 'ask' ? '仅问答 · 可读取资料，不会修改文件或执行命令' : settings?.permissionMode === 'read-only' ? '只读模式 · 发送后先检查需求，不会提供写入和执行工具' : workMode === 'workflow' ? '梅花会先列出分工计划，确认后协作完成；可在同一文件夹新建其他分工任务' : '发送后，梅花会先确认你的意思，再开始处理'}</div>
      </div>
      </div>{showFiles && settings?.workspace && <WorkspacePanel workspace={settings.workspace} onClose={() => setShowFiles(false)} />}</div>
    </main>

    {showSettings && settings && <SettingsDialog settings={settings} providers={providers} workspaceDisabled={backgroundBusy || running || reviewing} onRuntime={() => setShowRuntimeSettings(true)} onMemory={() => setShowMemory(true)} onMcp={() => { setMcpQuery(''); setShowMcp(true); }} onClose={() => setShowSettings(false)} onWorkspace={chooseWorkspace} onSave={(updated) => { setSettings(updated); setShowSettings(false); setError(''); }} />}
    {showQuickConnect && settings && <QuickConnectDialog settings={settings} providers={providers} onClose={() => setShowQuickConnect(false)} onAdvanced={() => { setShowQuickConnect(false); setShowSettings(true); }} onSave={(updated) => { setSettings(updated); setShowQuickConnect(false); setError(''); }} />}
    {showAgents && <AgentsDialog agents={agents} workspace={settings?.workspace || ''} onWorkspace={chooseWorkspace} onClose={() => setShowAgents(false)} onSave={(updated) => { setAgents(updated); if (agentId && agentId !== 'reviewer' && !updated.some((agent) => agent.id === agentId)) setAgentId(''); }} />}
    {showShortcuts && <ShortcutsDialog shortcuts={shortcuts} onClose={() => setShowShortcuts(false)} onSave={setShortcuts} />}
    {showRuntimeSettings && <RuntimeSettingsDialog disabled={backgroundBusy || running || reviewing} onClose={() => setShowRuntimeSettings(false)} />}
    {showMcp && <McpDialog disabled={running || reviewing} enabled={Boolean(settings?.mcpEnabled)} webAccess={Boolean(settings?.webAccess)} initialQuery={mcpQuery} onClose={() => setShowMcp(false)} />}
    {showMemory && <MemoryDialog workspace={settings?.workspace || ''} disabled={running || reviewing} enabled={Boolean(settings?.memoryEnabled)} onClose={() => setShowMemory(false)} onSource={(id) => { setShowMemory(false); setShowSettings(false); openSession(id); }} />}
    {inputRequest && <InputRequestDialog key={inputRequest.requestId} request={inputRequest} />}
    {approval && <div className="modal-backdrop"><div className="approval-card" role="dialog" aria-modal="true" aria-labelledby="approval-title">
      <div className="approval-heading"><div className="approval-icon"><ShieldCheck size={22} /></div><button aria-label="拒绝并关闭" onClick={() => answer(false)}><X size={19} /></button></div>
      <div className="eyebrow">需要你的确认</div><h2 id="approval-title">{approvalTitle(approval.kind)}</h2>
      <p>{approvalDescription(approval, workspaceName)}</p>{pendingApprovals.length > 1 && <small>还有 {pendingApprovals.length - 1} 个确认等待处理</small>}<pre>{approvalPreview(approval)}</pre>
      {approval.kind === 'write' && (approval.detail.length || 0) > 3000 && <small>只显示前 3000 个字符，完整写入 {approval.detail.length} 个字符。</small>}
      {(approval.kind === 'email-draft' || approval.kind === 'email-send') && (approval.detail.length || 0) > 3000 && <small>只显示正文前 3000 个字符，完整正文 {approval.detail.length} 个字符。</small>}
      <div className="modal-actions"><button onClick={() => answer(false)}>拒绝</button><button className="confirm" onClick={() => answer(true)}>{approval.kind === 'email-send' ? '确认发送' : '允许这一次'} <ArrowRight size={16} /></button></div>
    </div></div>}
  </div>;
}

const pixelPattern = ['....SS....', '...PPPP...', '..PPPPPP..', '.PPPCCPPP.', 'PPPPCCPPPP', 'PPPPCCPPPP', '.PPPPPPPP.', '..PPPPPP..', '...B..B...', '..BB..BB..'];
const phaseLabels: Record<AgentStatus['phase'], string> = { idle: '待命', reviewing: '检查需求', thinking: '思考中', reading: '读材料', writing: '写内容', command: '运行命令', browsing: '查网页', tool: '调用工具', replying: '回复中' };
function PixelAgent({ status }: { status: AgentStatus }) {
  const detail = status.detail && status.detail !== status.phase ? toolLabel(status.detail) : '';
  return <div className={`pixel-agent ${status.phase !== 'idle' ? 'active' : ''}`} aria-label={`${status.name}：${phaseLabels[status.phase]}`}><div className={`pixel-actor ${status.phase}`} aria-hidden="true">{pixelPattern.join('').split('').map((pixel, index) => <span className={`pixel-cell ${pixel}`} key={index} />)}</div><div className="pixel-agent-copy"><strong>{status.name}</strong><span>{phaseLabels[status.phase]}{detail ? ` · ${detail}` : ''}</span></div><span className="pixel-status-dot" /></div>;
}

function ReviewCard({ review, pending, busy, onDecision }: { review: ReviewMessage; pending: boolean; busy: boolean; onDecision: (review: ReviewMessage, choice: 'original' | 'suggested' | 'edit' | 'reviewed') => void }) {
  const hasSuggestion = review.suggestedPrompt.trim() !== review.originalPrompt.trim();
  return <section className={`review-card ${pending ? 'pending' : ''}`}>
    <div className="review-head"><span className="review-badge"><Sparkles size={14} /> 需求检查{review.reviewOnly ? ' · 本次只检查' : review.agent ? ` → ${review.agent.name}` : ' → 默认梅花'}</span><span className="review-status">{pending ? '等待你的决定' : review.decision === 'reviewed' ? '已完成检查' : review.decision === 'edit' ? '已选择修改' : review.decision === 'suggested' ? '已采用建议' : '已按原需求执行'}</span></div>
    <h3>{review.ready ? '需求可以开始' : '先补清楚这一点会更准确'}</h3>
    {review.gaps.length ? <ul>{review.gaps.map((gap, index) => <li key={index}>{gap}</li>)}</ul> : <p className="review-clear">没有发现影响执行的关键缺口。</p>}
    <div className="review-question"><strong>{review.question}</strong><span>建议：{review.recommendation}</span></div>
    {hasSuggestion && <details className="review-suggestion"><summary>查看建议的完整需求</summary><p>{review.suggestedPrompt}</p></details>}
    {pending && <div className="review-actions"><button disabled={busy} onClick={() => onDecision(review, 'edit')}>{review.reviewOnly && hasSuggestion ? '按建议继续修改' : '修改需求'}</button>{review.reviewOnly ? <button className="primary" disabled={busy} onClick={() => onDecision(review, 'reviewed')}>完成检查 <Check size={15} /></button> : <><button disabled={busy} onClick={() => onDecision(review, 'original')}>按原需求执行</button>{hasSuggestion && <button className="primary" disabled={busy} onClick={() => onDecision(review, 'suggested')}>采用建议执行 <ArrowRight size={15} /></button>}</>}</div>}
  </section>;
}

function toolLabel(name: string) {
  return ({ list_files: '查看文件', read_file: '读取文件', search_text: '搜索内容', write_file: '写入文件', edit_file: '编辑文件', export_office: '生成办公文件', run_command: '执行命令', fetch_webpage: '读取网页', read_skill: '读取 Skill', search_memory: '检索记忆', search_mcp_servers: '查找扩展工具', retrieve_knowledge: '检索本地资料', query_database: '查询本地数据', browser_read: '读取隔离网页', browser_action: '操作网页', call_registered_api: '调用登记的 API', list_mcp_resources: '查看 MCP 资源', read_mcp_resource: '读取 MCP 资源', list_mcp_prompts: '查看 MCP 提示模板', get_mcp_prompt: '读取 MCP 提示模板', list_mcp_tools: '查看 MCP 工具', call_mcp_tool: '调用 MCP 工具', list_installed_apps: '查找本机应用', find_contact: '查找联系人', open_application: '打开应用', compose_email: '打开邮件草稿', send_email: '发送邮件' } as Record<string, string>)[name] || name;
}

function ToolMessage({ message, busy, onMcp }: { message: Extract<Message, { role: 'tool' }>; busy: boolean; onMcp: (name: string) => void }) {
  if (message.name === 'search_mcp_servers' && message.state === 'done' && message.output) {
    try {
      const parsed = JSON.parse(message.output);
      if (Array.isArray(parsed.servers)) {
        const candidates = parsed.servers.filter((item: { name?: string; title?: string; description?: string }) => typeof item?.name === 'string' && typeof item.title === 'string').slice(0, 5);
        return <section className="mcp-suggestions"><strong>找到 {parsed.servers.length} 个扩展服务</strong><p>{candidates.length ? '选择服务后，梅花会准备连接配置。' : '没有找到匹配服务，可换一个名称或用途再搜。'}</p>{candidates.map((item: { name: string; title: string; description?: string }) => <div key={item.name}><span><strong>{item.title}</strong><small>{item.description}</small></span><button disabled={busy} onClick={() => onMcp(item.name)}>配置此服务</button></div>)}{busy && <small>任务结束后可以配置。</small>}</section>;
      }
    } catch { /* Older or partial tool outputs remain available below. */ }
  }
  return <details className="tool-details"><summary className="activity"><div className="activity-icon">{message.name === 'run_command' ? <Terminal size={16} /> : <FileText size={16} />}</div><div><strong>{toolLabel(message.name)}</strong><span>{formatArgs(message.args)}</span></div><span className={`activity-state ${message.state}`}>{message.state === 'running' ? <LoaderCircle size={14} className="spin" /> : message.state === 'done' ? <Check size={14} /> : <X size={14} />}</span></summary><pre>{message.output || (message.state === 'running' ? '正在执行…' : '这条历史记录未保存工具输出。')}</pre></details>;
}
type Approval = Extract<AgentEvent, { type: 'approval' }>;
function approvalTitle(kind: Approval['kind']) {
  if (kind === 'app-open') return '打开应用';
  return ({ write: '写入文件', edit: '编辑文件', export: '生成办公文件', command: '执行命令', 'mcp-start': '启动 MCP 服务', 'mcp-call': '调用 MCP 工具', 'email-draft': '打开邮件草稿', 'email-send': '发送邮件', 'app-open': '打开应用', 'workflow-plan': '开始分工任务', browser: '访问与操作网页', 'api-call': '调用登记的 API' })[kind];
}
function approvalDescription(approval: Approval, workspaceName: string) {
  if (approval.kind === 'workflow-plan') return '确认以下步骤和工具范围后，梅花开始分工；写文件、命令和外部调用会分别确认。';
  if (approval.kind === 'browser' || approval.kind === 'api-call') return `目标：${approval.detail.url}`;
  if (approval.kind === 'app-open') return `梅花要打开 ${approval.detail.app}`;
  if (approval.kind === 'command') return `梅花要在 ${workspaceName} 中执行命令`;
  if (approval.kind === 'export') return `梅花要根据 ${approval.detail.source} 生成 ${approval.detail.path}`;
  if (approval.kind === 'mcp-start') return `梅花要${approval.detail.url ? '连接' : '启动'} ${approval.detail.server} MCP 服务`;
  if (approval.kind === 'mcp-call') return `梅花要调用 ${approval.detail.server} 的 ${approval.detail.tool} 工具`;
  if (approval.kind === 'email-draft') return `梅花要在 ${approval.detail.app} 中打开给 ${approval.detail.recipient} 的邮件草稿`;
  if (approval.kind === 'email-send') return `梅花要通过 Apple Mail 向 ${approval.detail.recipient} 发送邮件`;
  return `梅花要修改 ${approval.detail.path}`;
}
function approvalPreview(approval: Approval) {
  if (approval.kind === 'workflow-plan') return approval.detail.preview;
  if (approval.kind === 'browser' || approval.kind === 'api-call') return JSON.stringify(approval.detail.arguments, null, 2);
  if (approval.kind === 'app-open') return approval.detail.path;
  if (approval.kind === 'command') return [approval.detail.verification ? '项目验证' : '', approval.detail.command, approval.detail.workspace ? `目录：${approval.detail.workspace}` : '', approval.detail.sandbox ? `沙箱：${approval.detail.sandbox} · 网络：${approval.detail.network ? '允许' : '关闭'}` : '', approval.detail.script ? `脚本：${approval.detail.script}` : '', approval.detail.expectedOutput ? `预期输出：${approval.detail.expectedOutput}` : '', approval.detail.outputs?.length ? `预期文件：${approval.detail.outputs.join('、')}` : ''].filter(Boolean).join('\n');
  if (approval.kind === 'export') return `${approval.detail.source}  →  ${approval.detail.path}`;
  if (approval.kind === 'mcp-start') return approval.detail.url || [approval.detail.command, ...(approval.detail.args || [])].join(' ');
  if (approval.kind === 'mcp-call') return JSON.stringify(approval.detail.arguments || {}, null, 2);
  if (approval.kind === 'email-draft' || approval.kind === 'email-send') return `收件人：${approval.detail.recipient}\n主题：${approval.detail.subject}\n\n${approval.detail.body}`;
  if (approval.kind === 'edit') return `原文：\n${approval.detail.oldText}\n\n替换为：\n${approval.detail.newText}`;
  return approval.detail.preview;
}
function formatArgs(args: unknown) {
  if (!args || typeof args !== 'object') return '';
  const value = args as Record<string, unknown>;
  return String(value.path || value.target_path || value.command || value.pattern || value.url || value.server || value.name || value.app || value.recipient || '');
}

const emptyAgent = (): Omit<CustomAgent, 'id'> & { id?: string } => ({ name: '', prompt: '', skills: [], mode: 'read-only' });
const emptyShortcut = (shortcuts: JumpShortcut[]) => ({ name: '', url: '', key: ['4', '5', '6', '7', '8', '9'].find((key) => !shortcuts.some((item) => item.key === key)) || '' });
function ShortcutsDialog({ shortcuts, onClose, onSave }: { shortcuts: JumpShortcut[]; onClose: () => void; onSave: (shortcuts: JumpShortcut[]) => void }) {
  const [draft, setDraft] = useState<{ id?: string; name: string; url: string; key: string }>(() => emptyShortcut(shortcuts));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function save() {
    setSaving(true); setError('');
    try {
      const updated = await window.zhuge.saveShortcut(draft);
      onSave(updated);
      const saved = updated.find((item) => item.name === draft.name.trim() && item.key === draft.key);
      if (saved) setDraft({ ...saved });
    } catch (err) { setError(uiError(err)); }
    finally { setSaving(false); }
  }
  async function remove() {
    if (!draft.id || !window.confirm(`删除跳转键“${draft.name}”？`)) return;
    setSaving(true); setError('');
    try { const updated = await window.zhuge.deleteShortcut(draft.id); onSave(updated); setDraft(emptyShortcut(updated)); }
    catch (err) { setError(uiError(err)); }
    finally { setSaving(false); }
  }
  return <div className="modal-backdrop"><div className="shortcut-card" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title">
    <div className="settings-head"><div><span className="eyebrow">QUICK JUMP</span><h2 id="shortcuts-title">自定义跳转键</h2></div><button aria-label="关闭跳转键设置" onClick={onClose}><X size={20} /></button></div>
    <p className="settings-intro">在梅花工作时，点击下方入口，或按 ⌘⇧ 加数字键打开网页。</p>
    <div className="shortcut-defaults">{shortcuts.filter((item) => item.builtin).map((item) => <span key={item.id}>{item.name} <kbd>⌘⇧{item.key}</kbd></span>)}</div>
    <div className="shortcut-custom-list"><button onClick={() => setDraft(emptyShortcut(shortcuts))}><Plus size={14} /> 添加入口</button>{shortcuts.filter((item) => !item.builtin).map((item) => <button className={draft.id === item.id ? 'selected' : ''} onClick={() => setDraft({ ...item })} key={item.id}>{item.name}<kbd>⌘⇧{item.key}</kbd></button>)}</div>
    <div className="shortcut-form"><label>名称<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="例如：我的音乐" /></label><label>HTTPS 地址<input value={draft.url} onChange={(event) => setDraft({ ...draft, url: event.target.value })} placeholder="https://example.com/" /></label><label>数字键<select value={draft.key} onChange={(event) => setDraft({ ...draft, key: event.target.value })}>{!draft.key && <option value="">没有可用数字键</option>}{['4', '5', '6', '7', '8', '9'].map((key) => <option key={key} value={key} disabled={shortcuts.some((item) => item.key === key && item.id !== draft.id)}>⌘⇧{key}</option>)}</select></label></div>
    {error && <div className="settings-error">{error}</div>}
    <div className="agent-form-actions">{draft.id && <button className="delete-agent" onClick={remove} disabled={saving}>删除</button>}<button className="save-agent" onClick={save} disabled={saving || !draft.key || !draft.name.trim() || !draft.url.trim()}>{saving ? '保存中…' : '保存跳转键'} <ArrowRight size={15} /></button></div>
  </div></div>;
}

function AgentsDialog({ agents, workspace, onWorkspace, onClose, onSave }: { agents: CustomAgent[]; workspace: string; onWorkspace: () => void; onClose: () => void; onSave: (agents: CustomAgent[]) => void }) {
  const [draft, setDraft] = useState<Omit<CustomAgent, 'id'> & { id?: string }>(emptyAgent);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  useEffect(() => { window.zhuge.listSkills().then(setSkills).catch((err) => setError(uiError(err))); }, [workspace]);
  async function importZip() {
    if (!workspace) { onWorkspace(); return; }
    setImporting(true); setError(''); setNotice('');
    try {
      const imported = await window.zhuge.importSkillZip();
      if (!imported) return;
      setSkills(await window.zhuge.listSkills());
      setDraft((current) => current.skills.includes(imported.name) || current.skills.length >= 8 ? current : { ...current, skills: [...current.skills, imported.name] });
      setNotice(`已导入「${imported.title}」。请确认下方勾选状态，保存智能体后生效。`);
    } catch (err) { setError(uiError(err)); }
    finally { setImporting(false); }
  }
  async function save() {
    setSaving(true); setError('');
    try {
      const updated = await window.zhuge.saveAgent(draft);
      onSave(updated);
      const saved = updated.find((agent) => agent.name === draft.name.trim());
      if (saved) setDraft({ ...saved });
    }
    catch (err) { setError(uiError(err)); }
    finally { setSaving(false); }
  }
  async function remove() {
    if (!draft.id || !window.confirm(`删除智能体“${draft.name}”？`)) return;
    setSaving(true); setError('');
    try { onSave(await window.zhuge.deleteAgent(draft.id)); setDraft(emptyAgent()); }
    catch (err) { setError(uiError(err)); }
    finally { setSaving(false); }
  }
  return <div className="modal-backdrop"><div className="agents-card" role="dialog" aria-modal="true" aria-labelledby="agents-title">
    <div className="settings-head"><div><span className="eyebrow">MY AGENTS</span><h2 id="agents-title">我的智能体</h2></div><button aria-label="关闭智能体设置" onClick={onClose}><X size={20} /></button></div>
    <p className="settings-intro">给智能体写职责说明，选择工作目录中的 Skill，再在输入框下方指定由它执行任务。默认需求检查始终先运行。</p>
    <div className="agents-layout"><div className="agents-list"><button className={!draft.id ? 'selected' : ''} onClick={() => setDraft(emptyAgent())}><Plus size={15} /> 新建智能体</button>{agents.map((agent) => <button className={draft.id === agent.id ? 'selected' : ''} key={agent.id} onClick={() => setDraft({ ...agent })}><Bot size={15} /> {agent.name}</button>)}</div>
      <div className="agent-form"><label>名称<input value={draft.name} maxLength={40} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="例如：代码检查员" /></label>
        <label>职责与提示词<textarea value={draft.prompt} onChange={(event) => setDraft({ ...draft, prompt: event.target.value })} placeholder="说明它要检查什么、如何报告问题、什么情况算完成…" rows={7} /></label>
        <label>权限模式<select value={draft.mode} onChange={(event) => setDraft({ ...draft, mode: event.target.value as CustomAgent['mode'] })}><option value="read-only">只读检查</option><option value="full">可执行文件和命令操作</option></select></label>
        <div className="agent-skills-title"><div>工作目录中的 Skills <span>最多选择 8 个</span></div><button className="import-skill" type="button" onClick={importZip} disabled={importing || saving}><Upload size={14} /> {importing ? '导入中…' : workspace ? '导入 Skill ZIP' : '先选择工作目录'}</button></div>
        <div className="agent-skills">{skills.length ? skills.map((skill) => <label key={skill.name}><input type="checkbox" checked={draft.skills.includes(skill.name)} disabled={!draft.skills.includes(skill.name) && draft.skills.length >= 8} onChange={(event) => setDraft({ ...draft, skills: event.target.checked ? [...draft.skills, skill.name] : draft.skills.filter((name) => name !== skill.name) })} /><span><strong>{skill.title}</strong><small>{skill.description}</small></span></label>) : <p>{workspace ? '当前工作目录没有 Skill。点击“导入 Skill ZIP”选择文件。' : '先选择工作目录，再导入 Skill ZIP。'}</p>}{draft.skills.filter((name) => !skills.some((skill) => skill.name === name)).map((name) => <label key={name} className="missing-skill"><input type="checkbox" checked onChange={() => setDraft((current) => ({ ...current, skills: current.skills.filter((skill) => skill !== name) }))} /><span><strong>{name}</strong><small>当前工作目录缺少此 Skill；请导入或取消勾选</small></span></label>)}</div>
        {notice && <div className="settings-success" role="status">{notice}</div>}
        {error && <div className="settings-error">{error}</div>}
        <div className="agent-form-actions">{draft.id && <button className="delete-agent" onClick={remove} disabled={saving}>删除</button>}<button className="save-agent" onClick={save} disabled={saving || !draft.name.trim() || !draft.prompt.trim()}>{saving ? '保存中…' : '保存智能体'} <ArrowRight size={15} /></button></div>
      </div>
    </div>
  </div></div>;
}

function ModelField({ label, value, provider, customModels = [], onChange }: { label: string; value: string; provider?: ModelProvider; customModels?: string[]; onChange: (value: string) => void }) {
  const listed = provider?.models.some((item) => item.id === value) || customModels.includes(value);
  return <label>{label}<select value={listed ? value : '__custom__'} onChange={(event) => onChange(event.target.value === '__custom__' ? '' : event.target.value)}>
    {provider?.models.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.id}</option>)}
    {customModels.filter((id) => !provider?.models.some((item) => item.id === id)).map((id) => <option key={id} value={id}>{id}</option>)}
    <option value="__custom__">自定义模型 ID</option>
  </select>{!listed && <input value={value} onChange={(event) => onChange(event.target.value)} placeholder="输入服务商提供的模型 ID" />}</label>;
}

function QuickConnectDialog({ settings, providers, onClose, onAdvanced, onSave }: { settings: Settings; providers: ModelProvider[]; onClose: () => void; onAdvanced: () => void; onSave: (settings: Settings) => void }) {
  const [provider, setProvider] = useState<Settings['provider']>(settings.provider === 'compatible' ? 'openai' : settings.provider);
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const chosen = providers.find((item) => item.id === provider);
  async function save() {
    if (!chosen || (!apiKey.trim() && !settings.keyStatus[provider]) || saving) return;
    setSaving(true); setError('');
    try {
      const profile = settings.modelProfiles[provider];
      const updated = await window.zhuge.saveSettings({ ...settings, provider, model: profile?.model || chosen.defaultModel, baseUrl: profile?.baseUrl || '', apiKey, reviewProvider: 'same', reviewModel: profile?.reviewModel || chosen.reviewModel, reviewBaseUrl: '', reviewApiKey: '' });
      onSave(updated);
    } catch (err) { setError(uiError(err)); setSaving(false); }
  }
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="settings-card quick-connect-card" role="dialog" aria-modal="true" aria-labelledby="quick-connect-title">
    <div className="settings-head"><div><span className="eyebrow">连接 AI</span><h2 id="quick-connect-title">选一个你常用的模型服务商</h2></div><button aria-label="关闭连接设置" onClick={onClose}><X size={20} /></button></div>
    <p className="settings-intro">从模型服务商官网复制一串连接密钥，填入一次即可。以后只要说出任务，梅花就能帮你处理。</p>
    <label>模型服务商<select value={provider} onChange={(event) => { setProvider(event.target.value as Settings['provider']); setApiKey(''); setError(''); }}>{providers.filter((item) => item.id !== 'compatible').map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    <label>连接密钥（API Key） <span>{settings.keyStatus[provider] ? '已保存，可以直接继续' : '从服务商官网获取'}</span><input type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={settings.keyStatus[provider] ? '已保存；留空继续使用' : '粘贴你的连接密钥'} /></label>
    {chosen?.keyUrl && <a className="settings-key-link" href={chosen.keyUrl} target="_blank" rel="noopener noreferrer">去 {chosen.name} 官网创建 API Key <ExternalLink size={12} /></a>}
    <div className="quick-model-note">{settings.modelProfiles[provider] ? '将恢复此服务商保存的任务模型和检查模型。' : `将使用 ${chosen?.name} 的默认任务模型和检查模型。`}</div>
    {error && <div className="settings-error" role="alert">{error}</div>}
    <button className="quick-connect-save" onClick={save} disabled={saving || (!apiKey.trim() && !settings.keyStatus[provider])}>{saving ? '保存中…' : '保存并开始'} <ArrowRight size={15} /></button>
    <button className="quick-connect-advanced" onClick={onAdvanced}>使用本地模型或调整高级设置</button>
  </div></div>;
}

function SettingsDialog({ settings, providers, workspaceDisabled, onClose, onSave, onWorkspace, onMemory, onMcp, onRuntime }: { settings: Settings; providers: ModelProvider[]; workspaceDisabled: boolean; onClose: () => void; onSave: (settings: Settings) => void; onWorkspace: () => void; onMemory: () => void; onMcp: () => void; onRuntime: () => void }) {
  const [tab, setTab] = useState<'general' | 'models' | 'tools' | 'personal'>(() => !settings.workspace || (settings.provider === 'compatible' ? !settings.baseUrl : !settings.hasKey) || (settings.reviewProvider === 'compatible' ? !settings.reviewBaseUrl : settings.reviewProvider !== 'same' && !settings.reviewHasKey) ? 'models' : 'general');
  const [provider, setProvider] = useState(settings.provider);
  const [model, setModel] = useState(settings.model);
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl);
  const [apiKey, setApiKey] = useState('');
  const [reviewProvider, setReviewProvider] = useState(settings.reviewProvider);
  const [reviewModel, setReviewModel] = useState(settings.reviewModel);
  const [reviewBaseUrl, setReviewBaseUrl] = useState(settings.reviewBaseUrl || '');
  const [reviewApiKey, setReviewApiKey] = useState('');
  const [draftProfiles, setDraftProfiles] = useState(settings.modelProfiles);
  const [theme, setTheme] = useState(settings.theme);
  const [fontSize, setFontSize] = useState(settings.fontSize);
  const [sendShortcut, setSendShortcut] = useState(settings.sendShortcut);
  const [completionNotifications, setCompletionNotifications] = useState(settings.completionNotifications);
  const [preventSleep, setPreventSleep] = useState(settings.preventSleep);
  const [permissionMode, setPermissionMode] = useState(settings.permissionMode);
  const [webAccess, setWebAccess] = useState(settings.webAccess);
  const [mcpEnabled, setMcpEnabled] = useState(settings.mcpEnabled);
  const [nativeToolsEnabled, setNativeToolsEnabled] = useState(settings.nativeToolsEnabled);
  const [commandTimeoutSeconds, setCommandTimeoutSeconds] = useState(settings.commandTimeoutSeconds);
  const [customInstructions, setCustomInstructions] = useState(settings.customInstructions);
  const [memoryEnabled, setMemoryEnabled] = useState(settings.memoryEnabled);
  const [autoMemory, setAutoMemory] = useState(settings.autoMemory);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const selectedProvider = providers.find((item) => item.id === provider);
  const selectedReviewProvider = providers.find((item) => item.id === (reviewProvider === 'same' ? provider : reviewProvider));
  function rememberedProfiles() {
    const profiles = { ...draftProfiles };
    const execution = profiles[provider];
    profiles[provider] = {
      model, baseUrl, reviewModel: reviewProvider === 'same' ? reviewModel : execution?.reviewModel || '',
      customModels: [...new Set([...(execution?.customModels || []), model, reviewProvider === 'same' ? reviewModel : ''].filter(Boolean))],
    };
    if (reviewProvider !== 'same') {
      const reviewer = profiles[reviewProvider];
      profiles[reviewProvider] = {
        model: reviewer?.model || reviewModel, baseUrl: reviewBaseUrl, reviewModel,
        customModels: [...new Set([...(reviewer?.customModels || []), reviewModel].filter(Boolean))],
      };
    }
    return profiles;
  }
  function changeProvider(next: Settings['provider']) {
    const preset = providers.find((item) => item.id === next);
    const profiles = rememberedProfiles();
    const saved = profiles[next];
    setDraftProfiles(profiles);
    setProvider(next); setModel(saved?.model || preset?.defaultModel || ''); setBaseUrl(saved?.baseUrl || ''); setApiKey('');
    if (reviewProvider === 'same' || reviewProvider === next) {
      setReviewProvider('same'); setReviewModel(saved?.reviewModel || preset?.reviewModel || saved?.model || preset?.defaultModel || ''); setReviewBaseUrl(''); setReviewApiKey('');
    }
  }
  function changeReviewProvider(next: Settings['reviewProvider']) {
    const preset = providers.find((item) => item.id === (next === 'same' ? provider : next));
    const profiles = rememberedProfiles();
    const saved = profiles[next === 'same' ? provider : next];
    setDraftProfiles(profiles);
    setReviewProvider(next); setReviewModel(saved?.reviewModel || preset?.reviewModel || saved?.model || preset?.defaultModel || (next === 'same' ? model : '')); setReviewBaseUrl(next === 'same' ? '' : saved?.baseUrl || ''); setReviewApiKey('');
  }
  async function save() {
    setSaving(true); setError('');
    try { onSave(await window.zhuge.saveSettings({ provider, model, baseUrl, apiKey, reviewProvider, reviewModel, reviewBaseUrl, reviewApiKey, modelProfiles: rememberedProfiles(), theme, fontSize, sendShortcut, completionNotifications, preventSleep, permissionMode, webAccess, mcpEnabled, nativeToolsEnabled, commandTimeoutSeconds, customInstructions, memoryEnabled, autoMemory })); }
    catch (err) { setError(uiError(err)); setSaving(false); }
  }
  const sections = [
    { id: 'general', label: '通用与外观', detail: '显示与操作习惯', icon: Settings2, intro: '把梅花调整成你用起来顺手的样子。' },
    { id: 'models', label: '模型与目录', detail: '连接服务和文件夹', icon: Bot, intro: '选择处理任务的模型，以及梅花可以使用的工作文件夹。' },
    { id: 'tools', label: '权限与工具', detail: '决定可用能力', icon: ShieldCheck, intro: '控制梅花能读取什么、调用什么。' },
    { id: 'personal', label: '个人指令', detail: '记忆与工作偏好', icon: Brain, intro: '告诉梅花你希望它怎样协助你。' },
  ] as const;
  const activeSection = sections.find((section) => section.id === tab)!;
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="settings-card" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <div className="settings-shell-head">
        <div className="settings-brand"><img src={brandIcon} alt="" /><div><span>梅花 · 个人工作台</span><h2 id="settings-title">设置</h2></div></div>
        <button className="settings-close" aria-label="关闭设置" onClick={onClose}><X size={19} /></button>
      </div>
      <div className="settings-layout">
        <nav className="settings-nav" role="tablist" aria-label="设置分类">
          <span className="settings-nav-label">分类</span>
          {sections.map((section) => { const Icon = section.icon; return <button key={section.id} type="button" role="tab" aria-selected={tab === section.id} aria-controls="settings-panel" className={tab === section.id ? 'active' : ''} onClick={() => setTab(section.id)}><Icon size={17} strokeWidth={1.8} /><span><strong>{section.label}</strong><small>{section.detail}</small></span></button>; })}
        </nav>
        <main className="settings-content" id="settings-panel" role="tabpanel">
          <div className="settings-content-head"><span className="settings-kicker">梅花设置 / {activeSection.label}</span><h3>{activeSection.label}</h3><p>{activeSection.intro}</p></div>
    {tab === 'general' && <div className="settings-page"><label>外观<select value={theme} onChange={(event) => setTheme(event.target.value as Settings['theme'])}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label><label>对话字号<select value={fontSize} onChange={(event) => setFontSize(event.target.value as Settings['fontSize'])}><option value="small">紧凑 · 12px</option><option value="medium">标准 · 13px</option><option value="large">较大 · 15px</option></select></label><label>发送方式<select value={sendShortcut} onChange={(event) => setSendShortcut(event.target.value as Settings['sendShortcut'])}><option value="enter">Enter 发送，Shift + Enter 换行</option><option value="mod-enter">⌘ / Ctrl + Enter 发送，Enter 换行</option></select></label><label className="settings-toggle"><span><strong>完成通知</strong><small>窗口在后台时提示检查结果或任务结束；显示还取决于 macOS 通知设置</small></span><input type="checkbox" checked={completionNotifications} onChange={(event) => setCompletionNotifications(event.target.checked)} /></label><label className="settings-toggle"><span><strong>任务运行时保持唤醒</strong><small>阻止系统因空闲而休眠，任务结束后自动释放；不阻止手动睡眠</small></span><input type="checkbox" checked={preventSleep} onChange={(event) => setPreventSleep(event.target.checked)} /></label><div className="shortcut-help"><strong>常用快捷键</strong><span>⌘N 新任务 · ⌘K 搜索任务 · ⌘, 设置</span><span>⌘⇧1–9 打开快捷入口 · Esc 关闭设置</span></div></div>}
    {tab === 'models' && <div className="settings-page">
    {!settings.workspace && <div className="setup-callout"><span>先选择工作目录，再配置模型即可开始。</span><button type="button" disabled={workspaceDisabled} onClick={onWorkspace}>选择目录</button></div>}
    <div className="settings-section-title">执行任务</div>
    <label>模型提供方<select value={provider} onChange={(event) => changeProvider(event.target.value as Settings['provider'])}>{providers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    <ModelField label="执行模型" value={model} provider={selectedProvider} customModels={draftProfiles[provider]?.customModels} onChange={setModel} />
    <label>API Key <span>{settings.keyStatus[provider] ? '已保存，留空则保留' : provider === 'compatible' ? '本地服务可留空' : '需要此提供方的密钥'}</span><input type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={settings.keyStatus[provider] ? '••••••••••••' : '输入 API Key'} /></label>
    {selectedProvider?.keyUrl && <a className="settings-key-link" href={selectedProvider.keyUrl} target="_blank" rel="noopener noreferrer">前往 {selectedProvider.name} 官方平台创建 API Key <ExternalLink size={12} /></a>}
    <label>API 地址 <span>{provider === 'compatible' ? '必填' : '留空使用官方地址'}</span><input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder={selectedProvider?.baseUrl || '例如 http://127.0.0.1:11434/v1'} /></label>
    <div className="settings-section-title">需求检查与规划模型 <span>默认选择同一供应商的低成本模型</span></div>
    <label>检查模型提供方<select value={reviewProvider} onChange={(event) => changeReviewProvider(event.target.value as Settings['reviewProvider'])}><option value="same">跟随执行模型提供方</option>{providers.filter((item) => item.id !== provider).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    <ModelField label="检查模型" value={reviewModel} provider={selectedReviewProvider} customModels={draftProfiles[reviewProvider === 'same' ? provider : reviewProvider]?.customModels} onChange={setReviewModel} />
    {reviewProvider === 'same' ? <p className="settings-hint">沿用上方的 API Key 和地址。</p> : <><label>检查模型 API Key <span>{settings.keyStatus[reviewProvider] ? '已保存，留空则保留' : reviewProvider === 'compatible' ? '本地服务可留空' : '需要此提供方的密钥'}</span><input type="password" autoComplete="off" value={reviewApiKey} onChange={(event) => setReviewApiKey(event.target.value)} placeholder={settings.keyStatus[reviewProvider] ? '••••••••••••' : '输入检查模型的 API Key'} /></label>{selectedReviewProvider?.keyUrl && <a className="settings-key-link" href={selectedReviewProvider.keyUrl} target="_blank" rel="noopener noreferrer">前往 {selectedReviewProvider.name} 官方平台创建 API Key <ExternalLink size={12} /></a>}<label>检查模型 API 地址 <span>{reviewProvider === 'compatible' ? '必填' : '留空使用官方地址'}</span><input value={reviewBaseUrl} onChange={(event) => setReviewBaseUrl(event.target.value)} placeholder={selectedReviewProvider?.baseUrl || '例如 http://127.0.0.1:11434/v1'} /></label></>}
    <p className="settings-hint">直接执行时用于检查需求；分工完成时用于规划步骤。子代理模型可在“权限与工具 → 任务、用量与工具设置”中单独配置。先做计划、仅问答及分工的最终核对使用执行模型。</p>
    <div className="settings-workspace"><div><strong>工作目录</strong><span>{settings.workspace || '尚未选择'}</span></div><button disabled={workspaceDisabled} onClick={onWorkspace}>选择目录</button></div>
    </div>}
    {tab === 'tools' && <div className="settings-page"><div className="settings-section-title">执行权限</div>
      <label>默认权限模式<select value={permissionMode} onChange={(event) => setPermissionMode(event.target.value as Settings['permissionMode'])}><option value="ask">执行前逐项确认</option><option value="read-only">只读检查</option></select></label>
      <p className="settings-hint">只读模式会移除文件写入、命令、应用操作和 MCP 调用工具；智能体的权限不能覆盖此设置。</p>
      <label>命令超时时间<select value={commandTimeoutSeconds} onChange={(event) => setCommandTimeoutSeconds(Number(event.target.value) as Settings['commandTimeoutSeconds'])} disabled={permissionMode === 'read-only'}><option value={30}>30 秒</option><option value={120}>2 分钟</option><option value={300}>5 分钟</option></select></label>
      <div className="settings-section-title">可用工具</div>
      <label className="settings-toggle"><span><strong>联网工具</strong><small>允许网页、浏览器、登记 API、远程 MCP 和扩展目录检索；具体访问仍受各工具权限约束</small></span><input type="checkbox" checked={webAccess} onChange={(event) => setWebAccess(event.target.checked)} /></label>
      <label className="settings-toggle"><span><strong>MCP 服务器</strong><small>使用已添加的本机或远程服务；连接和调用仍需确认</small></span><input type="checkbox" checked={mcpEnabled} onChange={(event) => setMcpEnabled(event.target.checked)} /></label>
      <button className="settings-manage" type="button" onClick={onRuntime}>任务、用量与工具设置</button>
      <button className="settings-manage" type="button" onClick={onMcp}>管理 MCP 服务与工具</button>
      <label className="settings-toggle"><span><strong>macOS 应用与联系人</strong><small>允许查找应用、联系人，并在确认后打开应用或邮件草稿</small></span><input type="checkbox" checked={nativeToolsEnabled} onChange={(event) => setNativeToolsEnabled(event.target.checked)} /></label>
    </div>}
    {tab === 'personal' && <div className="settings-page"><div className="settings-section-title">长期记忆</div><label className="settings-toggle"><span><strong>使用记忆</strong><small>在新对话中读取通用偏好和当前工作目录的相关事实</small></span><input type="checkbox" checked={memoryEnabled} onChange={(event) => setMemoryEnabled(event.target.checked)} /></label><label className="settings-toggle"><span><strong>自动整理记忆</strong><small>任务结束后用检查模型整理用户原文中的稳定信息，会增加一次简短模型调用</small></span><input type="checkbox" checked={autoMemory} disabled={!memoryEnabled} onChange={(event) => setAutoMemory(event.target.checked)} /></label><button className="settings-manage" type="button" onClick={onMemory}>查看和管理记忆</button><div className="settings-section-title">个人指令</div><p className="settings-hint">对所有执行任务生效。工作目录中的 AGENTS.md 仍会随任务读取。</p><label>希望梅花如何工作<textarea rows={9} maxLength={8000} value={customInstructions} onChange={(event) => setCustomInstructions(event.target.value)} placeholder="例如：先给结论，再给证据；修改代码后运行相关检查。" /></label><p className="settings-hint">{customInstructions.length} / 8000 字</p></div>}
        </main>
      </div>
      <div className="settings-footer">
        <span>{error ? <span className="settings-error" role="alert">{error}</span> : '修改保存后，从下一次任务开始生效'}</span>
        <button disabled={saving || workspaceDisabled || !model.trim() || !reviewModel.trim() || (reviewProvider === 'compatible' && !reviewBaseUrl.trim())} onClick={save}>{saving ? '保存中…' : '保存设置'} <ArrowRight size={16} /></button>
      </div>
    </div>
  </div>;
}
