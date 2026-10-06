import { uiError } from './ui-error';
import { useState } from 'react';
import type { InputRequest } from './types';

export function InputRequestDialog({ request }: { request: InputRequest }) {
  const [values, setValues] = useState<Record<string, string | number | boolean>>(() => Object.fromEntries(Object.entries(request.schema.properties).filter(([, field]) => field.default !== undefined).map(([name, field]) => [name, field.default!])));
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const change = (name: string, value: string, type: string) => {
    setValues((current) => {
      const next = { ...current };
      if (value === '') delete next[name];
      else next[name] = type === 'boolean' ? value === 'true' : type === 'number' || type === 'integer' ? Number(value) : value;
      return next;
    });
  };
  const answer = async (action: 'accept' | 'decline' | 'cancel') => {
    setBusy(true); setError('');
    try { await window.zhuge.answerInputRequest(request.requestId, action, values); }
    catch (error) { setError(uiError(error)); } finally { setBusy(false); }
  };
  return <div className="modal-backdrop"><form className="management-card input-request-card" role="dialog" aria-modal="true" aria-labelledby="input-request-title" onSubmit={(event) => { event.preventDefault(); void answer('accept'); }}>
    <h3 id="input-request-title">{request.server} 需要补充信息</h3><p>{request.message}</p><p className="settings-hint">确认后，这些内容会发送给该 MCP 服务。登录密钥请在连接设置中填写。</p>
    <div className="management-form"><fieldset disabled={busy}>{Object.entries(request.schema.properties).map(([name, field]) => <label key={name}>{field.title || name}{request.schema.required?.includes(name) ? ' *' : ''}{field.enum ? <select value={String(values[name] ?? '')} required={request.schema.required?.includes(name)} onChange={(event) => change(name, event.target.value, field.type)}><option value="">请选择</option>{field.enum.map((value) => <option key={String(value)} value={String(value)}>{String(value)}</option>)}</select> : field.type === 'boolean' ? <select value={values[name] === undefined ? '' : String(values[name])} required={request.schema.required?.includes(name)} onChange={(event) => change(name, event.target.value, field.type)}><option value="">请选择</option><option value="true">是</option><option value="false">否</option></select> : <input type={field.type === 'string' ? 'text' : 'number'} value={String(values[name] ?? '')} required={request.schema.required?.includes(name)} maxLength={Math.min(field.maxLength ?? 8000, 8000)} min={field.minimum} max={field.maximum} step={field.type === 'integer' ? 1 : 'any'} onChange={(event) => change(name, event.target.value, field.type)} />}{field.description && <small className="settings-hint">{field.description}</small>}</label>)}</fieldset></div>
    {error && <p role="alert" className="settings-error">{error}</p>}<div className="management-actions"><button type="button" data-input-cancel disabled={busy} onClick={() => answer('cancel')}>取消本次</button><button type="button" disabled={busy} onClick={() => answer('decline')}>不提供</button><button className="management-primary" type="submit" disabled={busy}>确认并继续</button></div>
  </form></div>;
}
