import { uiError } from './ui-error';
import { useEffect, useState } from 'react';
import { Search, ArrowRight, X } from 'lucide-react';
import type { McpService, McpRegistryEntry, McpRegistryResult, McpRegistryPlan } from './types';

export function McpDiscovery({ disabled, online, initialQuery, onAdded }: { disabled: boolean; online: boolean; initialQuery: string; onAdded: (services: McpService[], name: string) => void }) {
  const [query, setQuery] = useState(initialQuery);
  const [result, setResult] = useState<McpRegistryResult | null>(null);
  const [entry, setEntry] = useState<McpRegistryEntry | null>(null);
  const [option, setOption] = useState('');
  const [plan, setPlan] = useState<McpRegistryPlan | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function search(text = query) {
    setQuery(text); setBusy(true); setError(''); setEntry(null); setPlan(null); setResult(null); setValues({});
    try { setResult(await window.zhuge.searchMcpRegistry(text)); }
    catch (err) { setError(uiError(err)); }
    finally { setBusy(false); }
  }
  useEffect(() => { if (initialQuery && online) search(initialQuery); }, [initialQuery]);
  async function choose(candidate: McpRegistryEntry, id: string) {
    setEntry(candidate); setOption(id); setBusy(true); setPlan(null); setValues({}); setError('');
    try {
      const prepared = await window.zhuge.prepareMcpRegistry(candidate.name, candidate.version, id);
      setPlan(prepared); setValues(Object.fromEntries(prepared.fields.map((field) => [field.id, field.defaultValue])));
    } catch (err) { setError(uiError(err)); }
    finally { setBusy(false); }
  }
  async function add() {
    if (!entry || !plan) return;
    setBusy(true); setError('');
    try { const added = await window.zhuge.addMcpRegistry(entry.name, entry.version, option, values); setValues({}); onAdded(added.services, added.addedName); }
    catch (err) { setError(uiError(err)); }
    finally { setBusy(false); }
  }
  return <div className="mcp-discovery">
    <form className="mcp-search" onSubmit={(event) => { event.preventDefault(); search(); }}><Search size={16} /><input aria-label="搜索扩展工具" value={query} maxLength={120} onChange={(event) => setQuery(event.target.value)} placeholder="想完成什么？例如：读取网页、表格、Notion" /><button disabled={busy || !online || !query.trim()}>{busy ? '正在查询…' : '搜索工具'}</button></form>
    {!online && <p className="management-notice">目录搜索需要在“设置 → 权限与工具”开启 MCP 和联网读取。</p>}
    <div className="mcp-categories">{['网页', '表格', '文档', '文件', '笔记', '日历', 'GitHub'].map((text) => <button disabled={busy || !online} key={text} onClick={() => search(text)}>{text}</button>)}</div>
    {!result && !busy && !error && <p className="panel-hint">从用途或服务名开始。梅花从官方 MCP 目录读取服务信息，并自动生成支持的连接配置。</p>}
    {result && <><p className="mcp-result-summary">{result.source} · 关键词：{result.terms.join('、')} · 显示 {result.servers.length} 个结果{result.partial ? ' · 部分查询暂时失败' : ''}</p>{!result.servers.length && <p className="panel-hint">没有匹配的服务。可尝试产品英文名，或使用“手动添加”。</p>}</>}
    {entry && <section className="mcp-setup" aria-label="自动配置服务"><div className="mcp-setup-head"><strong>连接 {entry.title}</strong><button aria-label="关闭自动配置" disabled={busy} onClick={() => { setEntry(null); setPlan(null); setValues({}); }}><X size={16} /></button></div>
      {plan && <><p className="panel-hint">{plan.label} · {entry.version}</p><code className="mcp-config-preview">{plan.summary}</code>{plan.runtimeUrl && <a href={plan.runtimeUrl} target="_blank" rel="noreferrer">查看所需程序的安装说明</a>}
      <fieldset disabled={busy || disabled}>{plan.fields.map((field) => <label key={field.id}>{field.label}{field.required ? ' *' : ''}{field.choices?.length ? <select value={values[field.id] || ''} onChange={(event) => setValues({ ...values, [field.id]: event.target.value })}><option value="">请选择</option>{field.choices.map((choice) => <option key={choice}>{choice}</option>)}</select> : <input type={field.secret ? 'password' : 'text'} autoComplete="off" value={values[field.id] || ''} onChange={(event) => setValues({ ...values, [field.id]: event.target.value })} placeholder={field.placeholder || (field.secret ? '填入你在此服务获取的密钥' : '')} />}{field.description && <small>{field.description}</small>}</label>)}
      {!plan.fields.length && <p className="panel-hint">连接配置已准备好。添加后可检查连接并查看工具。</p>}<button className="management-primary" onClick={add} disabled={plan.fields.some((field) => field.required && !values[field.id]?.trim())}>{busy ? '添加中…' : '添加这个服务'} <ArrowRight size={13} /></button></fieldset>{disabled && <p className="panel-hint">任务结束后可以添加服务。</p>}</>}
    </section>}
    {error && <p className="settings-error" role="alert">{error}</p>}
    <div className="mcp-results">{result?.servers.map((candidate) => <article key={candidate.name}><div className="mcp-result-head"><strong>{candidate.title}</strong><span>{candidate.version}</span></div><p>{candidate.description}</p><small>{candidate.name}</small><div className="mcp-result-actions">{candidate.options.map((choice) => <button disabled={busy} key={choice.id} onClick={() => choose(candidate, choice.id)}>{choice.transport === 'http' ? '配置在线服务' : '配置本机服务'}</button>)}{candidate.websiteUrl || candidate.repositoryUrl ? <a href={candidate.websiteUrl || candidate.repositoryUrl} target="_blank" rel="noreferrer">服务说明</a> : null}{!candidate.options.length && <span>此连接方式需按服务说明配置</span>}</div></article>)}</div>
  </div>;
}
