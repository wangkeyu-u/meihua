import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { resolveWorkspacePath } from './workspace.js';
import { captureFile } from './file-state.js';

const terms = (text) => {
  const normalized = text.normalize('NFKC').toLowerCase(), tokens = normalized.match(/[a-z0-9_]{2,}/g) || [];
  for (const group of normalized.match(/[\p{Script=Han}]+/gu) || []) for (let i = 0; i < group.length - 1; i++) tokens.push(group.slice(i, i + 2));
  return tokens;
};
// Local retrieval over actual source chunks; no synthetic embeddings or remote indexing.
export async function retrieveKnowledge(workspace, query, { limit = 8, signal, maxFiles = 300, exclude = [] } = {}) {
  if (typeof query !== 'string' || !query.trim() || query.length > 500) throw new Error('知识检索词须为 1–500 字符');
  if (!Array.isArray(exclude) || exclude.length > 480 || exclude.some((item) => typeof item !== 'string' || path.isAbsolute(item) || item.split(/[\\/]/).includes('..'))) throw new Error('检索排除路径无效');
  const excluded = new Set(exclude.map((item) => path.normalize(item)));
  const chunks = []; let count = 0, bytes = 0, directories = 0, bounded = false;
  async function scan(relative, depth = 0) {
    if (depth > 8 || count >= maxFiles || bytes >= 20 * 1024 * 1024 || chunks.length >= 4000 || directories >= 1000) { bounded = true; return; }
    directories++;
    const directory = await resolveWorkspacePath(workspace, relative);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (count >= maxFiles || chunks.length >= 4000) { bounded = true; break; }
      signal?.throwIfAborted();
      if (entry.name.startsWith('.') || ['node_modules', 'release', 'dist'].includes(entry.name) || entry.isSymbolicLink()) continue;
      const requested = path.join(relative, entry.name);
      if (excluded.has(path.normalize(requested))) continue;
      if (entry.isDirectory()) await scan(requested, depth + 1);
      else if (entry.isFile() && /\.(md|txt|csv|json|html|[cm]?js|tsx?|py|rs|sql)$/i.test(entry.name) && count < maxFiles && bytes < 20 * 1024 * 1024) {
        const snapshot = await captureFile(workspace, requested, { maxBytes: 1024 * 1024 }).catch((error) => { if (/过大/.test(error.message)) return null; throw error; });
        if (!snapshot) continue;
        const text = await readFile(snapshot.file, 'utf8'); if (createHash('sha256').update(text).digest('hex') !== snapshot.hash) throw new Error('检索期间文件已变化');
        count++; bytes += Buffer.byteLength(text);
        const lines = text.split('\n');
        for (let first = 0; first < lines.length; first += 30) {
          if (chunks.length >= 4000) { bounded = true; break; }
          const content = lines.slice(first, first + 40).join('\n').slice(0, 5000); chunks.push({ path: requested, startLine: first + 1, endLine: Math.min(first + 40, lines.length), text: content, hash: snapshot.hash, tokens: terms(content) });
        }
      }
    }
  }
  await scan('.');
  const wanted = [...new Set(terms(query))], average = chunks.reduce((sum, chunk) => sum + chunk.tokens.length, 0) / (chunks.length || 1), frequencies = new Map(wanted.map((token) => [token, chunks.filter((chunk) => chunk.tokens.includes(token)).length]));
  const results = chunks.map(({ tokens, ...chunk }) => {
    const counts = new Map(); for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
    const score = wanted.reduce((sum, token) => { const tf = counts.get(token) || 0, df = frequencies.get(token) || 0; return sum + Math.log(1 + (chunks.length - df + .5) / (df + .5)) * (tf * 2.2) / (tf + 1.2 * (.25 + .75 * tokens.length / (average || 1))); }, 0);
    return { ...chunk, score, source: 'file', trusted: false };
  }).filter((chunk) => chunk.score > 0).sort((a, b) => b.score - a.score).slice(0, Math.min(limit, 20));
  for (const result of results) if ((await captureFile(workspace, result.path)).hash !== result.hash) throw new Error('检索结果来源已变化，请重新检索');
  return { results, excludedOutputs: [...excluded], scannedFiles: count, method: 'BM25', truncated: bounded || count >= maxFiles || bytes >= 20 * 1024 * 1024 };
}
