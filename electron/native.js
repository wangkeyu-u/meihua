import { readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runProcess } from './process.js';

const appRoots = ['/Applications', '/System/Applications', path.join(os.homedir(), 'Applications')];
let appCache = { at: 0, apps: [] };

export async function installedApps() {
  if (Date.now() - appCache.at < 60000) return appCache.apps;
  const apps = [];
  for (const root of appRoots) {
    let entries;
    try { entries = await readdir(root, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const entry of entries) {
      if (entry.name.endsWith('.app') && (entry.isDirectory() || entry.isSymbolicLink())) {
        apps.push({ name: entry.name.slice(0, -4), path: path.join(root, entry.name) });
      } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
        let nested = [];
        try { nested = await readdir(path.join(root, entry.name), { withFileTypes: true }); } catch { /* skip unreadable app group */ }
        for (const item of nested) if (item.name.endsWith('.app') && item.isDirectory()) apps.push({ name: item.name.slice(0, -4), path: path.join(root, entry.name, item.name) });
      }
    }
  }
  appCache = { at: Date.now(), apps: apps.sort((a, b) => a.name.localeCompare(b.name)) };
  return appCache.apps;
}

export async function findApps(query = '') {
  const normalized = String(query).trim().toLocaleLowerCase();
  const aliases = { 邮件: 'mail', 苹果邮件: 'mail', 浏览器: 'safari', 备忘录: 'notes', 通讯录: 'contacts' };
  const target = aliases[normalized] || normalized;
  return (await installedApps()).filter((item) => item.name.toLocaleLowerCase().includes(target)).slice(0, 30);
}

export async function resolveApp(name) {
  const matches = await findApps(name);
  const normalized = String(name).trim().toLocaleLowerCase();
  const preferred = { 邮件: 'mail', 苹果邮件: 'mail', 浏览器: 'safari', 备忘录: 'notes', 通讯录: 'contacts' }[normalized] || normalized;
  const exact = matches.find((item) => item.name.toLocaleLowerCase() === preferred);
  if (exact) return exact;
  if (matches.length === 1) return matches[0];
  if (!matches.length) throw new Error(`没有找到应用：${name}`);
  throw new Error(`找到多个应用：${matches.map((item) => item.name).join('、')}。请指定完整名称`);
}

export function validateEmailAddress(address) {
  const email = String(address || '').trim();
  if (email.length > 254 || !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(email)) throw new Error('请提供明确的收件人邮箱地址');
  return email;
}

export function mailtoUrl(recipient, subject = '', body = '') {
  const email = validateEmailAddress(recipient);
  if (String(subject).length > 500 || String(body).length > 30000) throw new Error('邮件主题或正文过长');
  const params = new URLSearchParams({ subject: String(subject), body: String(body) });
  return `mailto:${encodeURIComponent(email)}?${params}`;
}

export async function runNative(command, args, timeoutMs = 15000, signal) {
  const { code, output } = await runProcess(command, args, { timeoutMs, signal, maxOutput: 30000 });
  if (code !== 0) throw new Error(output.trim() || `系统命令退出：${code}`);
  return output.trim();
}

export const contactScript = `on run argv
  set queryText to item 1 of argv
  set outputText to ""
  set resultCount to 0
  tell application "Contacts"
    set foundPeople to every person whose name contains queryText
    repeat with personItem in foundPeople
      set personName to name of personItem
      repeat with emailItem in emails of personItem
        set outputText to outputText & personName & tab & (value of emailItem as text) & linefeed
        set resultCount to resultCount + 1
        if resultCount is greater than or equal to 10 then exit repeat
      end repeat
      if resultCount is greater than or equal to 10 then exit repeat
    end repeat
  end tell
  return outputText
end run`;

export async function findContacts(query, signal) {
  if (process.platform !== 'darwin') throw new Error('联系人查询目前仅支持 macOS');
  if (typeof query !== 'string' || !query.trim() || query.length > 100) throw new Error('请输入联系人姓名');
  const output = await runNative('/usr/bin/osascript', ['-e', contactScript, query.trim()], 15000, signal);
  return output.split(/\r?\n/).filter(Boolean).map((line) => {
    const [name, email] = line.split('\t');
    return { name, email };
  }).filter((item) => item.email);
}

export const sendMailScript = `on run argv
  set recipientAddress to item 1 of argv
  set messageSubject to item 2 of argv
  set messageBody to item 3 of argv
  tell application "Mail"
    set newMessage to make new outgoing message with properties {subject:messageSubject, content:messageBody, visible:false}
    tell newMessage
      make new to recipient at end of to recipients with properties {address:recipientAddress}
      send
    end tell
  end tell
  return "sent"
end run`;

export async function sendViaAppleMail(recipient, subject, body, signal) {
  if (process.platform !== 'darwin') throw new Error('Apple Mail 发送目前仅支持 macOS');
  mailtoUrl(recipient, subject, body);
  return runNative('/usr/bin/osascript', ['-e', sendMailScript, recipient, subject, body], 30000, signal);
}
