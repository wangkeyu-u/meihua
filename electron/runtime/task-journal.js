import path from 'node:path';
import { createHash } from 'node:crypto';
import { open, mkdir, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { validateTask } from './task-schema.js';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
export const recordDigest = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const signature = (info) => [info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':');
const invalid = () => { throw Object.assign(new Error('任务追加日志损坏或版本不受支持，原始数据已保留'), { code: 'TASK_JOURNAL_INVALID' }); };
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);
async function syncDirectory(directory) {
  if (process.platform === 'win32') return; // Node cannot open a directory for fsync on Windows.
  const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

// JSON data only. Paths are arrays, and property access never traverses a prototype.
function changes(before, after, at = [], output = []) {
  if ((before !== undefined) === (after !== undefined) && recordDigest(before ?? null) === recordDigest(after ?? null)) return output;
  if (Array.isArray(before) && Array.isArray(after) && after.length >= before.length) {
    before.forEach((item, index) => changes(item, after[index], [...at, index], output));
    if (after.length > before.length) output.push({ op: 'append', path: at, value: after.slice(before.length) });
  } else if (plain(before) && plain(after)) {
    for (const key of Object.keys(before)) if (!own(after, key)) output.push({ op: 'remove', path: [...at, key] });
    for (const key of Object.keys(after)) changes(own(before, key) ? before[key] : undefined, after[key], [...at, key], output);
  } else output.push({ op: 'set', path: at, value: after });
  return output;
}
function apply(record, operations) {
  let next = structuredClone(record);
  if (!Array.isArray(operations)) invalid();
  for (const entry of operations) {
    if (!entry || !['set', 'remove', 'append'].includes(entry.op) || !Array.isArray(entry.path) || entry.path.length > 128 || entry.path.some((key) => typeof key !== 'string' && !Number.isSafeInteger(key))) invalid();
    if (!entry.path.length) {
      if (entry.op === 'set') { if (!own(entry, 'value')) invalid(); next = structuredClone(entry.value); continue; }
      if (entry.op === 'append' && Array.isArray(next) && Array.isArray(entry.value)) { for (const value of entry.value) next.push(structuredClone(value)); continue; }
      invalid();
    }
    let parent = next;
    for (const key of entry.path.slice(0, -1)) {
      if (!parent || typeof parent !== 'object' || !own(parent, key)) invalid();
      parent = parent[key];
    }
    const key = entry.path.at(-1);
    if (!parent || typeof parent !== 'object' || Array.isArray(parent) && (!Number.isSafeInteger(key) || key < 0 || key >= parent.length)) invalid();
    if (entry.op === 'remove') { if (!own(parent, key) || Array.isArray(parent)) invalid(); delete parent[key]; }
    else if (entry.op === 'append') {
      if (!own(parent, key) || !Array.isArray(parent[key]) || !Array.isArray(entry.value)) invalid();
      for (const value of entry.value) parent[key].push(structuredClone(value));
    } else {
      if (!own(entry, 'value')) invalid();
      Object.defineProperty(parent, key, { value: structuredClone(entry.value), writable: true, enumerable: true, configurable: true });
    }
  }
  return next;
}

export async function preserveBytes(root, id, category, bytes) {
  const digest = createHash('sha256').update(bytes).digest('hex');
  const file = path.join(root, 'recovery', `${id}.${digest}.${category}`);
  await mkdir(path.dirname(file), { recursive: true });
  let handle;
  try {
    handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(bytes); await handle.sync();
    await syncDirectory(path.dirname(file)); await syncDirectory(root);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!Buffer.from(await readFile(file)).equals(Buffer.from(bytes))) invalid();
  } finally { await handle?.close(); }
  return file;
}

// Single writer per TaskStore. Every acknowledged mutation has a synced JSONL entry.
// Task JSON is a rebuildable projection; a valid complete journal entry is never replayed as an action.
export class TaskJournal {
  constructor(root) { this.root = root; this.cache = new Map(); }
  file(id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('无效的任务 ID');
    return path.join(this.root, 'journals', `${id}.jsonl`);
  }
  async load(id) {
    const file = this.file(id);
    let handle;
    try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (error.code === 'ENOENT') { this.cache.delete(id); return null; } if (error.code === 'ELOOP') invalid(); throw error; }
    let raw, info;
    try {
      info = await handle.stat(); if (!info.isFile()) invalid();
      const cached = this.cache.get(id);
      if (cached?.signature === signature(info)) return structuredClone(cached);
      raw = await handle.readFile();
      if (signature(await handle.stat()) !== signature(info)) invalid();
    } finally { await handle.close(); }
    const end = raw.lastIndexOf(10) + 1;
    if (!end) invalid();
    let record = null, hash = null, sequence = 0;
    for (const line of raw.subarray(0, end).toString('utf8').split('\n').slice(0, -1)) {
      let entry; try { entry = JSON.parse(line); } catch { invalid(); }
      const { hash: received, ...payload } = entry || {};
      if (payload.schemaVersion !== 1 || payload.id !== id || payload.sequence !== sequence + 1 || payload.previous !== hash || typeof payload.timestamp !== 'string' || !Number.isFinite(Date.parse(payload.timestamp)) || recordDigest(payload) !== received) invalid();
      record = apply(record, payload.changes);
      try { validateTask(record, id); } catch { invalid(); }
      if (recordDigest(record) !== payload.recordHash) invalid();
      sequence = payload.sequence; hash = received;
    }
    const loaded = { record, hash, sequence, signature: signature(info), bytes: end, recoveryFile: null };
    if (end !== raw.length) {
      // Only an incomplete final line may be trimmed, after preserving the exact original.
      loaded.recoveryFile = await preserveBytes(this.root, id, 'journal.jsonl', raw);
      const writer = await open(file, constants.O_WRONLY | constants.O_NOFOLLOW);
      try {
        if (signature(await writer.stat()) !== signature(info)) invalid();
        await writer.truncate(end); await writer.sync(); loaded.signature = signature(await writer.stat());
      } finally { await writer.close(); }
    }
    this.cache.set(id, loaded); return structuredClone(loaded);
  }
  async append(id, record, expected = null) {
    const previous = await this.load(id);
    if (expected && previous?.hash !== expected.hash || !expected && previous) invalid();
    const payload = { schemaVersion: 1, id, sequence: (previous?.sequence || 0) + 1, previous: previous?.hash || null, timestamp: new Date().toISOString(), changes: changes(previous?.record ?? null, record), recordHash: recordDigest(record) };
    const hash = recordDigest(payload), line = JSON.stringify({ ...payload, hash }) + '\n', file = this.file(id);
    await mkdir(path.dirname(file), { recursive: true });
    const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size !== (previous?.bytes || 0)) invalid();
      await handle.writeFile(line); await handle.sync();
      if (!previous) {
        await syncDirectory(path.dirname(file)); await syncDirectory(this.root); await syncDirectory(path.dirname(this.root));
      }
      const loaded = { record: structuredClone(record), hash, sequence: payload.sequence, signature: signature(await handle.stat()), bytes: info.size + Buffer.byteLength(line), recoveryFile: previous?.recoveryFile || null };
      this.cache.set(id, loaded); return loaded;
    } catch (error) { this.cache.delete(id); throw error; }
    finally { await handle.close(); }
  }
}
