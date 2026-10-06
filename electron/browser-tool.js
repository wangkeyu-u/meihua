import { BrowserWindow, session } from 'electron';
import { randomUUID } from 'node:crypto';

export class BrowserTool {
  constructor(config, approve) { this.config = config; this.approve = approve; this.window = null; this.session = null; this.writeAllowed = false; }
  validate(raw) {
    const url = new URL(raw);
    if (!this.config.allowedOrigins.includes(url.origin) || url.username || url.password || !['http:', 'https:'].includes(url.protocol)) throw new Error('网页来源尚未由用户登记');
    return url;
  }
  create() {
    if (this.window && !this.window.isDestroyed()) return;
    this.session = session.fromPartition(`meihua-browser-${randomUUID()}`);
    this.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    this.session.setPermissionCheckHandler(() => false);
    this.session.on('will-download', (event) => event.preventDefault());
    this.session.webRequest.onBeforeRequest((details, callback) => {
      let allowed = false; try { this.validate(details.url); allowed = details.method === 'GET' || this.writeAllowed; } catch {}
      callback({ cancel: !allowed });
    });
    this.window = new BrowserWindow({ show: false, width: 1000, height: 760, webPreferences: { session: this.session, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, javascript: true } });
    this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.window.webContents.on('will-navigate', (event, url) => { try { this.validate(url); } catch { event.preventDefault(); } });
    this.window.webContents.on('will-redirect', (event, url) => { try { this.validate(url); } catch { event.preventDefault(); } });
    this.window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  }
  async read(address, signal) {
    const url = this.validate(address);
    if (!await this.approve('browser', { url: url.href, arguments: { action: 'read', isolated: true } })) throw new Error('用户拒绝读取网页');
    signal?.throwIfAborted(); this.create(); this.writeAllowed = false;
    const stop = () => this.window?.webContents.stop(); signal?.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(stop, 20000);
    try { await this.window.loadURL(url.href); signal?.throwIfAborted(); this.validate(this.window.webContents.getURL()); return await this.snapshot(); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', stop); }
  }
  async action({ action, selector, value = '' }, signal) {
    if (!this.window || this.window.isDestroyed()) throw new Error('先读取并检查网页');
    const url = this.validate(this.window.webContents.getURL());
    if (!['click', 'fill'].includes(action) || typeof selector !== 'string' || selector.length > 500 || typeof value !== 'string' || value.length > 10000) throw new Error('浏览器动作仅支持 click/fill，不能执行任意脚本');
    if (!await this.approve('browser', { url: url.href, arguments: { action, selector, value } })) throw new Error('用户拒绝网页操作');
    signal?.throwIfAborted(); this.writeAllowed = action === 'click';
    try {
      await this.window.webContents.executeJavaScript(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element) throw new Error('网页元素不存在'); if (${JSON.stringify(action)} === 'click') element.click(); else { if (!['INPUT','TEXTAREA','SELECT'].includes(element.tagName)) throw new Error('元素不能填值'); element.value = ${JSON.stringify(value)}; element.dispatchEvent(new Event('input', {bubbles:true})); element.dispatchEvent(new Event('change', {bubbles:true})); } return true; })()`);
      await new Promise((resolve) => setTimeout(resolve, 500)); signal?.throwIfAborted(); this.validate(this.window.webContents.getURL()); return await this.snapshot();
    } finally { this.writeAllowed = false; }
  }
  async snapshot() {
    return { url: this.window.webContents.getURL(), title: this.window.getTitle(), text: await this.window.webContents.executeJavaScript("document.body?.innerText.slice(0, 30000) || ''"), source: 'web', trusted: false };
  }
  async close() { if (this.window && !this.window.isDestroyed()) this.window.destroy(); await this.session?.clearStorageData(); this.window = null; }
}
