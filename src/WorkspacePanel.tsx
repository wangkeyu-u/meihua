import { uiError } from './ui-error';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, FileText, Folder, RefreshCw, X } from 'lucide-react';
import type { DirectoryListing, FilePreview } from './types';
import { Markdown } from './content';

export function WorkspacePanel({ workspace, onClose }: { workspace: string; onClose: () => void }) {
  const [tab, setTab] = useState<'files' | 'git'>('files');
  const [directory, setDirectory] = useState<DirectoryListing | null>(null);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [diff, setDiff] = useState<{ status: string; working: string; staged: string } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const sequence = useRef(0);
  async function load(path = '.') {
    const id = ++sequence.current; setLoading(true); setError('');
    try {
      if (tab === 'git') { const next = await window.zhuge.workspaceDiff(); if (id === sequence.current) setDiff(next); }
      else { const next = await window.zhuge.listWorkspaceFiles(path); if (id === sequence.current) { setDirectory(next); setPreview(null); } }
    } catch (err) { if (id === sequence.current) setError(uiError(err)); }
    finally { if (id === sequence.current) setLoading(false); }
  }
  useEffect(() => { setPreview(null); setDirectory(null); setDiff(null); void load(); return () => { sequence.current++; }; }, [tab, workspace]);
  async function open(path: string) {
    const id = ++sequence.current; setLoading(true); setError('');
    try { const next = await window.zhuge.previewFile(path); if (id === sequence.current) setPreview(next); }
    catch (err) { if (id === sequence.current) setError(uiError(err)); }
    finally { if (id === sequence.current) setLoading(false); }
  }
  return <aside className="workspace-panel" aria-label="文件与变更">
    <div className="panel-head"><div className="panel-tabs"><button aria-pressed={tab === 'files'} onClick={() => setTab('files')}>文件</button><button aria-pressed={tab === 'git'} onClick={() => setTab('git')}>Git 变更</button></div><button className="icon-button" title="刷新" aria-label="刷新文件与变更" disabled={loading} onClick={() => preview ? open(preview.path) : load(directory?.path)}><RefreshCw size={15} /></button><button className="icon-button" aria-label="关闭文件面板" onClick={onClose}><X size={17} /></button></div>
    <div className="panel-body">{loading && <p role="status">正在读取…</p>}{error && <p role="alert" className="settings-error">{error}</p>}
    {tab === 'files' && <><div className="panel-path"><button className="icon-button" aria-label="返回上一级" disabled={!preview && (!directory || directory.path === '.')} onClick={() => preview ? setPreview(null) : load(directory?.path.split('/').slice(0, -1).join('/') || '.')}><ArrowLeft size={15} /></button><span>{preview?.path || directory?.path || '.'}</span></div>
      {preview ? <>{preview.truncated && <p className="panel-hint">仅预览前 100000 个字符。</p>}{/\.md$/i.test(preview.path) ? <Markdown text={preview.text} /> : <pre className="file-preview">{preview.text || '空文件'}</pre>}</> : <div className="file-list">{directory?.entries.map((entry) => <button key={entry.path} disabled={loading} onClick={() => entry.directory ? load(entry.path) : open(entry.path)}>{entry.directory ? <Folder size={15} /> : <FileText size={15} />}<span>{entry.name}</span></button>)}{directory && !directory.entries.length && <p>此目录没有可显示的文件。</p>}{directory?.truncated && <p>仅显示前 300 项，请进入具体目录查看。</p>}</div>}</>}
    {tab === 'git' && diff && <><p className="panel-hint">查看当前工作目录的变更。未跟踪文件可在“文件”中预览；每类输出最多显示 150000 个字符。</p><h3>文件状态</h3><pre className="file-preview">{diff.status || '工作目录干净，没有变更。'}</pre>{[['未暂存', diff.working], ['已暂存', diff.staged]].map(([title, content]) => content && <section key={title}><h3>{title}</h3><pre className="diff-preview">{content.split('\n').map((line, index) => <span key={index} className={line.startsWith('+') ? 'diff-add' : line.startsWith('-') ? 'diff-remove' : ''}>{line}{'\n'}</span>)}</pre></section>)}</>}
    </div>
  </aside>;
}
