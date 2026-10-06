import { useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy } from 'lucide-react';

export function CopyButton({ text, label = '复制' }: { text: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'done' | 'error'>('idle');
  return <button type="button" className="copy-button" aria-label={label} onClick={async () => {
    try { await window.zhuge.copyText(text); setState('done'); }
    catch { setState('error'); }
    setTimeout(() => setState('idle'), 1800);
  }}>{state === 'done' ? <Check size={13} /> : <Copy size={13} />}{state === 'done' ? '已复制' : state === 'error' ? '复制失败' : label}</button>;
}
function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node && typeof node === 'object' && 'props' in node) return textOf((node.props as { children?: ReactNode }).children);
  return '';
}
export function Markdown({ text }: { text: string }) {
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
    pre: ({ children }) => <div className="code-block"><CopyButton text={textOf(children)} label="复制代码" /><pre>{children}</pre></div>,
    a: ({ href, children }) => /^https:\/\//i.test(href || '') ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
    img: ({ alt }) => <span className="panel-hint">[图片：{alt || '未加载外部图片'}]</span>,
    table: ({ children }) => <div className="markdown-table"><table>{children}</table></div>,
  }}>{text}</ReactMarkdown></div>;
}
