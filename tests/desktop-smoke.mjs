// Run with Electron: isolated profile, real main process and preload; local mock model only.
import { app, ipcMain, BrowserWindow, dialog, powerSaveBlocker, net } from 'electron';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, realpath, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { startHttpMcpServer } from './http-mcp-server.js';
import { TaskManager } from '../electron/runtime/task-manager.js';
import { TaskStore } from '../electron/runtime/task-store.js';
import { randomUUID } from 'node:crypto';

async function main() {
const root = await mkdtemp(path.join(os.tmpdir(), 'zhuge-desktop-smoke-'));
const profile = path.join(root, 'profile');
let workspace = path.join(root, 'workspace');
await mkdir(profile); await mkdir(workspace);
const documents = path.join(root, 'Documents'); await mkdir(documents);
workspace = await realpath(workspace);
app.setPath('userData', profile);
app.setPath('documents', documents);
// Simulate a persisted running task from an earlier process before the real application starts.
const interruptedSessionId = randomUUID();
await mkdir(path.join(profile, 'sessions'));
await writeFile(path.join(profile, 'sessions', `${interruptedSessionId}.json`), JSON.stringify({ id: interruptedSessionId, title: '中断任务', workspace, messages: [], transcript: [], updatedAt: new Date().toISOString() }));
const previousManager = new TaskManager(new TaskStore(path.join(profile, 'runtime')));
const interruptedTask = await previousManager.create({ sessionId: interruptedSessionId, workspace, originalPrompt: '只读检查已有成果', mode: 'ask', model: 'smoke', provider: 'compatible' });
await previousManager.transition(interruptedTask.id, 'running');
await previousManager.mutate(interruptedTask.id, (record) => { record.stage = 'execute'; });
await previousManager.startStep(interruptedTask.id, { tool: 'read_file', inputSummary: 'approved.txt', metadata: { sideEffect: false } });
const legacyFile = path.join(profile, 'runtime', 'tasks', `${interruptedTask.id}.json`);
await rm(previousManager.store.journal.file(interruptedTask.id)); // An actual legacy profile has no journal.
const legacyRecord = JSON.parse(await readFile(legacyFile, 'utf8')); legacyRecord.schemaVersion = 1; delete legacyRecord.userUpdates; delete legacyRecord.checkpointsExpiredAt; delete legacyRecord._journal;
const legacyRaw = JSON.stringify(legacyRecord, null, 1) + '\n'; await writeFile(legacyFile, legacyRaw);
const corruptTaskFile = path.join(profile, 'runtime', 'tasks', `${randomUUID()}.json`); await writeFile(corruptTaskFile, '{broken');
const journalTask = await previousManager.create({ sessionId: randomUUID(), workspace, originalPrompt: '只执行一次', mode: 'execute', model: 'smoke', provider: 'compatible' });
await previousManager.transition(journalTask.id, 'running');
const committedStep = await previousManager.startStep(journalTask.id, { tool: 'write_file', inputSummary: 'committed-once.txt', metadata: { sideEffect: true } });
await writeFile(path.join(workspace, 'committed-once.txt'), 'exactly once');
await previousManager.completeStep(journalTask.id, committedStep, { ok: true, summary: 'saved once', changedFiles: ['committed-once.txt'] });
await rm(previousManager.store.file(journalTask.id));
const handlers = new Map();
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (name, callback) => { handlers.set(name, callback); handle(name, callback); };
const invoke = (name, ...args) => handlers.get(name)({}, ...args);
let scenario = 'write', target = 'approved.txt', onApproval, failSession;
let finishSlowReview;
const requestedTools = [];
const requests = [];
const httpMcp = await startHttpMcpServer();
const originalFetch = globalThis.fetch;
const originalNetFetch = net.fetch;
const registryRecord = { server: { name: 'io.github.meihua/test-tools', title: '桌面测试工具', version: '1.0.0', description: '本地测试的在线工具', remotes: [{ type: 'streamable-http', url: httpMcp.url, headers: [{ name: 'Authorization', isSecret: true, value: 'Bearer {api_key}' }] }] }, _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active' } } };
globalThis.fetch = (input, options) => {
  const url = String(input.url || input);
  if (url.startsWith('https://registry.modelcontextprotocol.io/')) return Promise.resolve(Response.json(url.includes('/versions/') ? registryRecord : { servers: [registryRecord] }));
  return originalFetch(input, options);
};
// Only the catalogue is mocked; model and MCP traffic still use Chromium HTTP.
net.fetch = (input, options) => String(input.url || input).startsWith('https://registry.modelcontextprotocol.io/') ? globalThis.fetch(input, options) : originalNetFetch(input, options);
const originalOpen = dialog.showOpenDialog;
const originalSave = dialog.showSaveDialog;
const originalStart = powerSaveBlocker.start;
const originalStop = powerSaveBlocker.stop;
let blockersStarted = 0, blockersStopped = 0;
powerSaveBlocker.start = (...args) => { blockersStarted++; return originalStart.apply(powerSaveBlocker, args); };
powerSaveBlocker.stop = (...args) => { blockersStopped++; return originalStop.apply(powerSaveBlocker, args); };
const server = createServer(async (request, response) => {
  let raw = ''; for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw); requests.push(body);
  if (scenario === 'slow-review') await new Promise((resolve) => { finishSlowReview = resolve; });
  if (scenario === 'steer') await new Promise((resolve) => setTimeout(resolve, 120));
  const tools = body.tools?.map((tool) => tool.function.name) || [];
  const currentTurn = body.messages.slice(body.messages.findLastIndex((message) => message.role === 'user') + 1);
  requestedTools.push(tools);
  let delta, finish = 'stop';
  const memoryExtraction = body.messages.some((m) => m.role === 'system' && JSON.stringify(m.content).includes('你只提取用户明确陈述'));
  if (memoryExtraction) {
    delta = { content: scenario === 'memory-error' ? 'invalid JSON' : JSON.stringify(scenario === 'memory-auto' ? [{ kind: 'preference', evidence: '以后报告先给结论' }] : []) };
  } else if (scenario === 'steer') {
    delta = { content: JSON.stringify(body.messages).includes('补充：先回答重点') ? '已看到补充，先回答重点' : '正在处理原任务' };
  } else if (!tools.length && !body.messages.some((m) => m.role === 'tool')) {
    delta = { content: JSON.stringify({ ready: true, gaps: [], question: '开始吗？', recommendation: '开始', suggestedPrompt: '执行本地测试' }) };
  } else if (scenario.startsWith('verification-')) {
    const wrote = body.messages.some((m) => m.tool_calls?.some((call) => call.function.name === 'write_file'));
    const edited = body.messages.some((m) => m.tool_calls?.some((call) => call.function.name === 'edit_file'));
    const retry = body.messages.some((m) => m.role === 'user' && JSON.stringify(m.content).includes('验证失败'));
    if (!wrote || retry && !edited) {
      const name = !wrote ? 'write_file' : 'edit_file';
      const args = !wrote ? { path: target, content: 'broken' } : { path: target, old_text: 'broken', new_text: scenario === 'verification-ok' ? 'fixed' : 'still-broken' };
      delta = { tool_calls: [{ index: 0, id: !wrote ? 'verify-write' : 'verify-repair', type: 'function', function: { name, arguments: JSON.stringify(args) } }] }; finish = 'tool_calls';
    } else delta = { content: '修改已提交，等待运行时验证' };
  } else if (scenario === 'registry' && !body.messages.some((m) => m.role === 'tool')) {
    delta = { tool_calls: [{ index: 0, id: 'search_registry', type: 'function', function: { name: 'search_mcp_servers', arguments: JSON.stringify({ query: '网页' }) } }] };
    finish = 'tool_calls';
  } else if (scenario === 'mcp' && !body.messages.some((m) => m.tool_calls?.some((call) => call.function.name === 'call_mcp_tool'))) {
    const listed = body.messages.some((m) => m.tool_calls?.some((call) => call.function.name === 'list_mcp_tools'));
    delta = { tool_calls: [{ index: 0, id: listed ? 'call_mcp' : 'list_mcp', type: 'function', function: { name: listed ? 'call_mcp_tool' : 'list_mcp_tools', arguments: JSON.stringify(listed ? { server: 'http-tools', name: 'echo', arguments: { text: '桌面远程工具' } } : { server: 'http-tools' }) } }] };
    finish = 'tool_calls';
  } else if (scenario === 'mcp-input' && !currentTurn.some((m) => m.role === 'tool')) {
    delta = { tool_calls: [{ index: 0, id: 'input-tool', type: 'function', function: { name: 'call_mcp_tool', arguments: JSON.stringify({ server: 'input-tools', name: 'choose', arguments: { topic: 'copies' } }) } }] };
    finish = 'tool_calls';
  } else if (scenario === 'mcp-input') {
    delta = { content: '填写流程已结束' };
  } else if (!currentTurn.some((m) => m.role === 'tool') && !['readonly', 'memory-auto', 'memory-error'].includes(scenario)) {
    const name = scenario === 'app' ? 'open_application' : 'write_file';
    const args = scenario === 'app' ? { app: 'TextEdit' } : { path: target, content: 'desktop IPC verified' };
    delta = { tool_calls: [{ index: 0, id: 'call_smoke', type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
    finish = 'tool_calls';
  } else delta = { content: '本地测试完成' };
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [d, reason] of [[{ role: 'assistant', ...delta }, null], [{}, finish]]) {
    response.write(`data: ${JSON.stringify({ id: 'smoke', object: 'chat.completion.chunk', created: 1, model: 'smoke', choices: [{ index: 0, delta: d, finish_reason: reason }] })}\n\n`);
  }
  response.end('data: [DONE]\n\n');
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ provider: 'compatible', model: 'smoke', reviewProvider: 'same', reviewModel: 'smoke', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, workspace, autoMemory: false }));
const events = [];
let success = false;
try {
  await import('../electron/main.js');
  await app.whenReady();
  assert.equal(app.getName(), '梅花');
  assert.equal(app.getPath('userData'), profile);
  let win;
  for (let attempt = 0; attempt < 200; attempt++) {
    win = BrowserWindow.getAllWindows()[0];
    if (win?.webContents.getURL() && !win.webContents.isLoading()) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(win);
  assert.equal(await win.webContents.executeJavaScript('typeof window.zhuge?.initialize'), 'function', 'sandboxed preload loaded');
  const bridge = await win.webContents.executeJavaScript('window.zhuge.initialize()');
  assert.equal(bridge.settings.provider, 'compatible');
  assert.equal(bridge.runtimeWarnings.filter((warning) => warning.kind === 'invalid').length, 1);
  assert.equal(bridge.runtimeWarnings.filter((warning) => warning.kind === 'recovered').length, 1);
  const migrationFiles = await readdir(path.join(profile, 'runtime', 'migrations'));
  assert.equal(await readFile(path.join(profile, 'runtime', 'migrations', migrationFiles[0]), 'utf8'), legacyRaw);
  assert.equal(JSON.parse(await readFile(legacyFile, 'utf8')).schemaVersion, 2);
  await waitUI('!!document.querySelector(\'button[aria-label="关闭任务数据提示"]\')');
  await assert.rejects(invoke('preview-backup-cleanup'), /无法确认/);
  await rm(corruptTaskFile); assert.equal((await invoke('runtime-settings')).warnings.filter((warning) => warning.blocksCleanup !== false).length, 0);
  const restoredFromLog = await invoke('get-task', journalTask.id);
  assert.equal(restoredFromLog.status, 'paused'); assert.equal(restoredFromLog.steps[0].status, 'completed');
  assert.equal(restoredFromLog.events.filter((event) => event.type === 'tool_completed').length, 1);
  assert.equal(await readFile(path.join(workspace, 'committed-once.txt'), 'utf8'), 'exactly once'); assert.equal(requests.length, 0);
  assert.match(await win.webContents.executeJavaScript('document.body.textContent'), /已从日志恢复/);
  await invoke('preview-backup-cleanup');
  console.log('PASS real startup discovers a journal-only task, restores its completed tool result and pauses without model/tool replay');
  await win.webContents.executeJavaScript('document.querySelector(\'button[aria-label="关闭任务数据提示"]\').click()');
  console.log('PASS real startup migrates v1 with original backup and isolates corrupt tasks with a visible notice');
  assert.equal(await win.webContents.executeJavaScript('document.querySelectorAll(".composer").length'), 1, 'React rendered');
  win.setSize(900, 620);
  const compactComposer = await win.webContents.executeJavaScript(`(() => {
    const outer = document.querySelector('.composer').getBoundingClientRect();
    return ['选择工作方式', '选择执行模型'].map((label) => {
      const element = document.querySelector('select[aria-label="' + label + '"]');
      const box = element.getBoundingClientRect();
      return { visible: box.width > 0 && box.height > 0, inside: box.left >= outer.left && box.right <= outer.right };
    });
  })()`);
  assert.ok(compactComposer.every((item) => item.visible && item.inside), 'work mode and model picker remain visible in the smallest window');
  win.setSize(1380, 860);
  const send = win.webContents.send.bind(win.webContents);
  win.webContents.send = (channel, event) => {
    events.push(event); send(channel, event);
    if (event.type === 'approval') Promise.resolve(onApproval?.(event)).catch((error) => { console.error(error); app.exit(1); });
  };
  const initial = (await invoke('initialize')).settings;
  await assert.rejects(invoke('save-settings', { ...initial, baseUrl: 'https://' }));
  assert.equal((await invoke('initialize')).settings.baseUrl, initial.baseUrl);
  await invoke('save-settings', { ...initial, apiKey: '   ' });
  assert.equal((await invoke('initialize')).settings.hasKey, false);
  console.log('PASS sandboxed preload, rendered UI, real initialize IPC, rejected settings leave state intact');

  async function reviewed() {
    const session = await invoke('create-session');
    return invoke('review-prompt', session.id, '执行本地回归检查');
  }
  let session = await reviewed();
  onApproval = (event) => invoke('answer-approval', event.id, true);
  await invoke('send-reviewed-prompt', session.id, session.pendingReview, 'original');
  assert.equal(await readFile(path.join(workspace, target), 'utf8'), 'desktop IPC verified');
  const saved = await invoke('load-session', session.id);
  assert.equal(saved.pendingReview, null);
  assert.ok(saved.messages.some((m) => m.role === 'tool' && m.state === 'done'));
  console.log('PASS review → approval → write → persisted conversation');
  const durable = (await invoke('list-tasks', session.id))[0];
  assert.equal(durable.status, 'completed'); assert.equal(durable.diagnostics.verificationAttempts, 1);
  assert.equal(durable.diagnostics.modelCalls, 3); assert.equal(durable.diagnostics.toolCalls, 1);
  assert.equal(durable.diagnostics.inputTokens, undefined, 'usage absent from the provider must remain unavailable');
  assert.ok(durable.events.some((event) => event.type === 'approval_accepted'));
  const firstCheckpoint = (await invoke('task-checkpoints', durable.id))[0];
  assert.match(await invoke('checkpoint-diff', durable.id, firstCheckpoint.id), /\+desktop IPC verified/);
  win.webContents.send('agent-event', { type: 'open-session', id: session.id });
  await waitUI('!!document.querySelector(".task-timeline")');
  assert.match(await win.webContents.executeJavaScript('document.querySelector(".task-timeline").textContent'), /已完成|验证/);
  console.log('PASS durable task, ordered actions, checkpoint diff and actual timeline render');

  scenario = 'readonly';
  const recovered = await invoke('get-task', interruptedTask.id);
  assert.equal(recovered.status, 'paused'); assert.equal(recovered.interrupted, true); assert.equal(recovered.currentStep, null);
  assert.equal(recovered.steps[0].status, 'interrupted');
  win.webContents.send('agent-event', { type: 'open-session', id: interruptedSessionId });
  await waitUI('!!document.querySelector(".runtime-interrupted")');
  await win.webContents.executeJavaScript("[...document.querySelectorAll('.runtime-actions button')].find((button) => button.textContent === '恢复').click()");
  await waitUI('!!document.querySelector(".runtime-record.completed") && !document.querySelector(".runtime-interrupted") && !document.querySelector(\'button[aria-label="停止任务"]\')');
  assert.equal((await invoke('get-task', interruptedTask.id)).status, 'completed');
  assert.match(JSON.stringify(requests.at(-1).messages), /恢复请求/);
  assert.equal(requestedTools.at(-1).includes('write_file'), false, 'recovery retains read-only task mode');
  console.log('PASS startup recognizes interrupted task and explicitly resumes with durable history and fresh rules');

  scenario = 'write'; target = 'paused-runtime.txt'; session = await reviewed();
  const pauseId = (await invoke('list-tasks', session.id))[0].id;
  onApproval = () => invoke('pause-task', pauseId);
  await invoke('send-reviewed-prompt', session.id, session.pendingReview, 'original');
  assert.equal((await invoke('get-task', pauseId)).status, 'paused');
  await assert.rejects(readFile(path.join(workspace, target)), { code: 'ENOENT' });
  onApproval = (event) => invoke('answer-approval', event.id, true);
  await invoke('resume-task', pauseId);
  assert.equal((await invoke('get-task', pauseId)).status, 'completed');
  assert.equal(await readFile(path.join(workspace, target), 'utf8'), 'desktop IPC verified');
  // Checkpoint operations through the renderer bridge, including refusal to overwrite external edits.
  await writeFile(path.join(workspace, target), 'external edit');
  await assert.rejects(invoke('undo-task', pauseId), /其他操作修改/);
  await writeFile(path.join(workspace, target), 'desktop IPC verified');
  await win.webContents.executeJavaScript(`window.zhuge.undoTask(${JSON.stringify(pauseId)})`);
  await assert.rejects(readFile(path.join(workspace, target)), { code: 'ENOENT' });
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: path.join(root, 'runtime-diagnostics.json') });
  await invoke('export-task-diagnostics', pauseId);
  const diagnostic = await readFile(path.join(root, 'runtime-diagnostics.json'), 'utf8');
  assert.doesNotMatch(diagnostic, /originalPrompt|apiKey|authorization|contextFiles/);
  console.log('PASS approval pause → explicit resume → fresh approval → checkpoint undo and diagnostic export');

  for (const expectedSuccess of [true, false]) {
    scenario = expectedSuccess ? 'verification-ok' : 'verification-fail'; target = expectedSuccess ? 'retry-ok.js' : 'retry-fail.js';
    await writeFile(path.join(workspace, 'package.json'), JSON.stringify({ scripts: { test: 'node verify.cjs' } }));
    await writeFile(path.join(workspace, 'verify.cjs'), `const ok = require('fs').readFileSync(${JSON.stringify(target)}, 'utf8') === 'fixed'; console[ok ? 'log' : 'error'](ok ? 'passed' : 'expected fixed file'); process.exit(ok ? 0 : 1);`);
    session = await reviewed();
    const verificationApprovals = [];
    onApproval = (event) => { verificationApprovals.push(event.kind); return invoke('answer-approval', event.id, true); };
    await invoke('send-reviewed-prompt', session.id, session.pendingReview, 'original');
    const checked = (await invoke('list-tasks', session.id))[0];
    assert.equal(checked.status, expectedSuccess ? 'completed' : 'failed');
    assert.equal(checked.diagnostics.verificationAttempts, expectedSuccess ? 2 : 3);
    assert.equal(checked.diagnostics.retries, expectedSuccess ? 1 : 2);
    assert.equal(checked.verification[0].result.ok, false);
    assert.equal(verificationApprovals.filter((kind) => kind === 'command').length, expectedSuccess ? 2 : 3);
    assert.equal(checked.steps.filter((step) => step.tool === 'edit_file').length, 1);
    if (!expectedSuccess) assert.equal(checked.error.code, 'VERIFICATION_FAILED');
    await invoke('restore-task', checked.id); await assert.rejects(readFile(path.join(workspace, target)), { code: 'ENOENT' });
    await rm(path.join(workspace, 'package.json')); await rm(path.join(workspace, 'verify.cjs'));
  }
  scenario = 'write';
  console.log('PASS real npm verification fails, agent repairs and rechecks; three failures remain failed; task restore works');

  async function openRuntimeSettings() {
    await win.webContents.executeJavaScript("[...document.querySelectorAll('.settings-link')].find((button) => button.textContent.trim() === '设置').click()");
    await waitUI('!!document.querySelector("#settings-title")');
    await win.webContents.executeJavaScript("[...document.querySelectorAll('.settings-nav button')].find((button) => button.textContent.includes('权限与工具')).click()");
    await waitUI("[...document.querySelectorAll('.settings-manage')].some((button) => button.textContent === '任务、用量与工具设置')");
    await win.webContents.executeJavaScript("[...document.querySelectorAll('.settings-manage')].find((button) => button.textContent === '任务、用量与工具设置').click()");
    await waitUI('!!document.querySelector("#runtime-settings-title") && !document.querySelector(".runtime-settings fieldset").disabled');
  }
  async function closeRuntimeSettings() {
    await win.webContents.executeJavaScript('document.querySelector(\'button[aria-label="关闭任务设置"]\').click()');
    await win.webContents.executeJavaScript('document.querySelector(\'button[aria-label="关闭设置"]\').click()');
  }
  await openRuntimeSettings();
  await win.webContents.executeJavaScript(`(() => { const picker = document.querySelector('select[aria-label="项目验证方式"]'); picker.value = 'custom'; picker.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await waitUI("[...document.querySelectorAll('.runtime-settings button')].some((button) => button.textContent === '添加验证命令')");
  await win.webContents.executeJavaScript("[...document.querySelectorAll('.runtime-settings button')].find((button) => button.textContent === '添加验证命令').click()");
  await waitUI('!!document.querySelector(".runtime-command")');
  await win.webContents.executeJavaScript(`(() => {
    const values = ['子目录验收', 'node', '["check.cjs"]', 'frontend', 'custom-passed'];
    [...document.querySelectorAll('.runtime-command input')].forEach((input, index) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, values[index]); input.dispatchEvent(new Event('input', { bubbles: true })); });
    const outputs = document.querySelector('.runtime-command textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(outputs, 'frontend/result.json'); outputs.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await win.webContents.executeJavaScript("[...document.querySelectorAll('.runtime-settings button')].find((button) => button.textContent === '保存项目验证').click()");
  await waitUI("document.querySelector('.runtime-settings [role=status]')?.textContent.includes('项目验证已保存')");
  assert.equal((await invoke('runtime-settings')).verification.commands[0].cwd, 'frontend');
  await closeRuntimeSettings();
  await mkdir(path.join(workspace, 'frontend'));
  await writeFile(path.join(workspace, 'frontend', 'check.cjs'), "require('fs').writeFileSync('result.json', JSON.stringify({ok: true})); console.log('custom-passed');");
  target = 'custom-verified.txt'; session = await reviewed();
  onApproval = async (event) => {
    if (event.kind === 'command') {
      assert.equal(event.detail.workspace, path.join(workspace, 'frontend')); assert.equal(event.detail.expectedOutput, 'custom-passed');
      await waitUI("[...document.querySelectorAll('.approval-card pre')].some((pre) => pre.textContent.includes('custom-passed') && pre.textContent.includes('frontend/result.json'))");
    }
    return invoke('answer-approval', event.id, true);
  };
  await invoke('send-reviewed-prompt', session.id, session.pendingReview, 'original');
  const customChecked = (await invoke('list-tasks', session.id))[0]; assert.equal(customChecked.status, 'completed'); assert.equal(customChecked.verification[0].result.scope, 'custom');
  assert.equal(customChecked.verification[0].result.checks.at(-1).outputFiles[0].path, 'frontend/result.json');
  // Change the canonical task through its store; JSON is now a rebuildable projection.
  await previousManager.store.mutate(durable.id, (record) => { record.completedAt = new Date(Date.now() - 40 * 86400000).toISOString(); return record; });
  await openRuntimeSettings();
  await win.webContents.executeJavaScript(`(() => { const picker = document.querySelector('select[aria-label="文件备份保留时间"]'); picker.value = '7'; picker.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await win.webContents.executeJavaScript("[...document.querySelectorAll('.runtime-settings button')].find((button) => button.textContent === '保存保留设置').click()");
  await waitUI("document.querySelector('.runtime-settings [role=status]')?.textContent.includes('保留时间已保存')");
  await win.webContents.executeJavaScript("[...document.querySelectorAll('.runtime-settings button')].find((button) => button.textContent === '预览可清理备份').click()");
  await waitUI('!!document.querySelector(".runtime-cleanup-preview")');
  assert.match(await win.webContents.executeJavaScript('document.querySelector(".runtime-cleanup-preview").textContent'), new RegExp(durable.id.slice(0, 8)));
  await win.webContents.executeJavaScript('document.querySelector(".runtime-delete").click()');
  await waitUI("document.querySelector('.runtime-settings [role=status]')?.textContent.includes('已清理 1 个任务备份')");
  assert.ok((await invoke('get-task', durable.id)).checkpointsExpiredAt); assert.deepEqual(await invoke('task-checkpoints', durable.id), []);
  await assert.rejects(invoke('undo-task', durable.id), /备份已经清理/); assert.equal(await readFile(path.join(workspace, 'approved.txt'), 'utf8'), 'desktop IPC verified');
  assert.equal(await readFile(path.join(profile, 'runtime', 'migrations', migrationFiles[0]), 'utf8'), legacyRaw);
  await closeRuntimeSettings();
  await invoke('save-verification-config', workspace, { mode: 'auto', commands: [] }); await invoke('save-backup-policy', 0);
  onApproval = (event) => invoke('answer-approval', event.id, true);
  console.log('PASS real settings save custom verification; approved child-directory command checks outputs; previewed cleanup preserves work files and migration backups');

  target = 'cancelled.txt'; session = await reviewed();
  onApproval = () => invoke('stop-agent');
  await invoke('send-reviewed-prompt', session.id, session.pendingReview, 'original');
  await assert.rejects(readFile(path.join(workspace, target)), { code: 'ENOENT' });
  assert.ok(events.some((event) => event.type === 'approval-closed'));
  console.log('PASS stop closes pending approval and prevents file write');

  scenario = 'app'; session = await reviewed();
  onApproval = (event) => { assert.equal(event.kind, 'app-open'); return invoke('answer-approval', event.id, false); };
  await invoke('send-reviewed-prompt', session.id, session.pendingReview, 'original');
  assert.ok((await invoke('load-session', session.id)).messages.some((m) => m.role === 'tool' && m.state === 'error'));
  console.log('PASS opening applications requires approval; refusal is enforced');

  scenario = 'readonly'; await invoke('save-settings', { ...initial, permissionMode: 'read-only' });
  session = await reviewed();
  await invoke('send-reviewed-prompt', session.id, session.pendingReview, 'original');
  const readonlyTools = requestedTools.filter((items) => items.length).at(-1);
  assert.ok(readonlyTools.includes('read_file'));
  for (const name of ['write_file', 'run_command', 'open_application', 'call_mcp_tool']) assert.equal(readonlyTools.includes(name), false);
  console.log('PASS read-only settings remove write and external-action tools from model request');

  await invoke('save-settings', initial);
  assert.deepEqual(await win.webContents.executeJavaScript("[...document.querySelectorAll('select[aria-label=\"选择工作方式\"] option')].map((item) => item.value)"), ['execute', 'workflow', 'plan', 'ask']);
  let planSessionId;
  for (const mode of ['plan', 'ask']) {
    const direct = await invoke('create-session');
    const reviewCount = requests.length;
    await invoke('run-direct-prompt', direct.id, '请阅读工作目录并回答', mode, null, []);
    const savedDirect = await invoke('load-session', direct.id);
    assert.equal(savedDirect.pendingReview, null);
    assert.equal(savedDirect.messages[0].mode, mode);
    if (mode === 'plan') { planSessionId = direct.id; assert.match(savedDirect.pendingPlan.plan, /本地测试完成/); }
    assert.ok(savedDirect.messages.some((message) => message.role === 'assistant'));
    assert.equal(requests.length, reviewCount + 1, 'direct mode sends one model request without a requirement review');
    const directTools = requestedTools.at(-1);
    assert.ok(directTools.includes('read_file'));
    for (const name of ['write_file', 'edit_file', 'run_command', 'open_application', 'call_mcp_tool']) assert.equal(directTools.includes(name), false);
  }
  console.log('PASS plan and Q&A modes skip review and cannot call write or external-action tools');

  win.webContents.send('agent-event', { type: 'open-session', id: planSessionId });
  await waitUI('!!document.querySelector(".plan-approval button.primary")');
  assert.match(await win.webContents.executeJavaScript('document.querySelector(".plan-approval").textContent'), /按计划执行/);

  scenario = 'write'; target = 'plan-approved.txt';
  onApproval = (event) => invoke('answer-approval', event.id, true);
  await invoke('execute-plan', planSessionId);
  assert.equal(await readFile(path.join(workspace, target), 'utf8'), 'desktop IPC verified');
  assert.equal((await invoke('load-session', planSessionId)).pendingPlan, null);
  assert.ok(requestedTools.at(-1).includes('write_file'));
  console.log('PASS confirmed plan executes in the same session with full approved tools');

  scenario = 'steer';
  const steeringSession = await invoke('create-session');
  const steeringRun = invoke('run-direct-prompt', steeringSession.id, '先分析工作目录', 'ask', null, []);
  for (let attempt = 0; attempt < 100 && !events.some((event) => event.type === 'running' && event.id === steeringSession.id && event.running); attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
  await invoke('steer-prompt', steeringSession.id, '补充：先回答重点');
  await steeringRun;
  const steeringSaved = await invoke('load-session', steeringSession.id);
  assert.ok(steeringSaved.messages.some((message) => message.role === 'user' && message.mode === 'steer'));
  assert.ok(steeringSaved.messages.some((message) => message.role === 'assistant' && message.content.includes('已看到补充')));
  assert.throws(() => invoke('steer-prompt', steeringSession.id, '太晚了'), /已结束/);
  console.log('PASS running task accepts a steering message and rejects one after completion');

  scenario = 'write'; await invoke('save-settings', initial); session = await reviewed();
  target = 'failure.txt'; failSession = path.join(profile, 'sessions', `${session.id}.json`);
  onApproval = async (event) => {
    await rename(failSession, `${failSession}.saved`); await mkdir(failSession);
    await invoke('answer-approval', event.id, false);
  };
  await assert.rejects(invoke('send-reviewed-prompt', session.id, session.pendingReview, 'original'));
  await rm(failSession, { recursive: true }); await rename(`${failSession}.saved`, failSession);
  assert.equal(events.filter((event) => event.type === 'running').at(-1).running, false);
  assert.ok((await reviewed()).pendingReview);
  console.log('PASS disk-save failure releases running state and allows another task');
  const changed = await invoke('update-session', saved.id, { title: '新的任务名称', pinned: true, archived: true });
  assert.equal(changed.archived, true);
  await assert.rejects(invoke('review-prompt', saved.id, '不可直接执行归档任务'), /归档/);
  const restored = await invoke('update-session', saved.id, { archived: false });
  assert.equal(restored.title, '新的任务名称');
  const cloned = await invoke('fork-session', saved.id);
  assert.notEqual(cloned.id, saved.id); assert.deepEqual(cloned.transcript, restored.transcript);
  await invoke('update-session', cloned.id, { title: '独立副本' });
  assert.equal((await invoke('load-session', saved.id)).title, '新的任务名称');
  const summaries = (await invoke('initialize')).sessions;
  assert.equal(summaries[0].id, saved.id); assert.match(summaries[0].searchText, /执行本地回归检查/);
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: path.join(root, 'export.md') });
  assert.equal(await invoke('export-session', saved.id), path.join(root, 'export.md'));
  assert.match(await readFile(path.join(root, 'export.md'), 'utf8'), /desktop IPC verified|已写入/);
  console.log('PASS rename, pin, archive, restore, fork, content search and Markdown export');

  const attachedFile = path.join(root, 'attachment.md');
  await writeFile(attachedFile, '# Attachment snapshot before change');
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [attachedFile] });
  const files = await invoke('pick-attachments');
  assert.equal(files[0].name, 'attachment.md');
  await writeFile(attachedFile, 'changed after attachment');
  scenario = 'readonly';
  const settingsWithUI = { ...initial, theme: 'dark', fontSize: 'large', sendShortcut: 'mod-enter', preventSleep: true };
  await invoke('save-settings', settingsWithUI);
  const draft = await invoke('create-session');
  const reviewedWithFile = await invoke('review-prompt', draft.id, '检查附件', null, [files[0].id]);
  assert.match(JSON.stringify(requests.at(-1).messages), /Attachment snapshot before change/);
  await invoke('send-reviewed-prompt', draft.id, reviewedWithFile.pendingReview, 'original');
  assert.match(JSON.stringify(requests.at(-1).messages), /Attachment snapshot before change/);
  assert.doesNotMatch(JSON.stringify(requests.at(-1).messages), /changed after attachment/);
  assert.equal(blockersStarted, 2); assert.equal(blockersStopped, 2);
  assert.equal((await invoke('initialize')).settings.theme, 'dark');
  const listing = await invoke('list-workspace-files', '.');
  assert.ok(listing.entries.some((entry) => entry.name === 'approved.txt'));
  assert.equal((await invoke('preview-file', 'approved.txt')).text, 'desktop IPC verified');
  await assert.rejects(invoke('preview-file', '../attachment.md'));
  await assert.rejects(invoke('workspace-diff'), /不是 Git/);
  console.log('PASS attachment snapshot reaches review/executor, appearance persists, wake lock releases, preview stays in workspace');

  const second = path.join(root, 'second-project'); await mkdir(second);
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [second] });
  const secondWorkspace = await invoke('select-workspace');
  await invoke('switch-workspace', secondWorkspace);
  await assert.rejects(invoke('switch-workspace', root), /选择目录/);
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [workspace] });
  await invoke('select-workspace');
  assert.ok((await invoke('initialize')).settings.recentWorkspaces.includes(secondWorkspace));
  console.log('PASS recent projects persist and arbitrary unselected paths cannot switch the workspace');
  const defaultWorkspace = await invoke('create-default-workspace');
  assert.equal(defaultWorkspace, await realpath(path.join(documents, '梅花工作台')));
  assert.equal((await invoke('initialize')).settings.workspace, defaultWorkspace);
  assert.ok((await invoke('initialize')).settings.recentWorkspaces.includes(workspace));
  console.log('PASS one-click workspace creation stays in Documents and preserves recent projects');

  // Memory CRUD, workspace isolation, injection, disable and extraction use real main IPC.
  scenario = 'readonly';
  await invoke('save-settings', { ...initial, autoMemory: false });
  const globalNote = (await invoke('save-memory', { content: '所有汇报先写结论，再写证据', kind: 'preference', scope: 'global', enabled: true })).at(-1);
  const projectNote = (await invoke('save-memory', { content: '本项目桌面验收使用样本数据', kind: 'fact', scope: 'workspace', enabled: true })).at(-1);
  let memorySession = await invoke('create-session');
  let memoryReview = await invoke('review-prompt', memorySession.id, '检查桌面验收数据');
  assert.match(JSON.stringify(requests.at(-1).messages), /所有汇报先写结论/);
  assert.match(JSON.stringify(requests.at(-1).messages), /本项目桌面验收使用样本数据/);
  await invoke('send-reviewed-prompt', memorySession.id, memoryReview.pendingReview, 'original');
  assert.ok(requestedTools.at(-1).includes('search_memory'));
  assert.match(JSON.stringify(requests.at(-1).messages), /本项目桌面验收使用样本数据/);
  await invoke('switch-workspace', secondWorkspace);
  memorySession = await invoke('create-session');
  await invoke('review-prompt', memorySession.id, '检查桌面验收数据');
  assert.match(JSON.stringify(requests.at(-1).messages), /所有汇报先写结论/);
  assert.doesNotMatch(JSON.stringify(requests.at(-1).messages), /本项目桌面验收使用样本数据/);
  await invoke('switch-workspace', workspace);
  await invoke('save-memory', { ...globalNote, enabled: false });
  await invoke('save-settings', { ...initial, memoryEnabled: false });
  memorySession = await invoke('create-session');
  memoryReview = await invoke('review-prompt', memorySession.id, '检查桌面验收数据');
  await invoke('send-reviewed-prompt', memorySession.id, memoryReview.pendingReview, 'original');
  assert.equal(requestedTools.at(-1).includes('search_memory'), false);
  assert.doesNotMatch(JSON.stringify(requests.at(-1).messages), /本项目桌面验收使用样本数据|所有汇报先写结论/);
  await invoke('save-settings', { ...initial, autoMemory: true });
  scenario = 'memory-auto';
  memorySession = await invoke('create-session');
  memoryReview = await invoke('review-prompt', memorySession.id, '以后报告先给结论。检查材料。');
  await invoke('send-reviewed-prompt', memorySession.id, memoryReview.pendingReview, 'original');
  const autoNote = (await invoke('list-memories')).find((item) => item.content === '以后报告先给结论');
  assert.equal(autoNote.sourceSessionId, memorySession.id);
  assert.equal(autoNote.source, 'conversation');
  assert.equal(autoNote.scope, 'workspace');
  assert.ok(events.some((event) => event.type === 'memory-notice' && /已整理/.test(event.message)));
  scenario = 'memory-error'; memorySession = await reviewed();
  assert.equal(await invoke('send-reviewed-prompt', memorySession.id, memorySession.pendingReview, 'original'), true);
  assert.ok(events.some((event) => event.type === 'memory-notice' && /未成功/.test(event.message)));
  assert.equal(events.filter((event) => event.type === 'running').at(-1).running, false);
  await invoke('delete-memory', globalNote.id); await invoke('delete-memory', projectNote.id); await invoke('delete-memory', autoNote.id);
  assert.deepEqual(await invoke('list-memories'), []);
  console.log('PASS memory CRUD, cross-session injection, project isolation, disable, original-evidence extraction and nonfatal extraction failure');

  await invoke('save-settings', initial);
  const service = { name: 'http-tools', transport: 'http', url: httpMcp.url, token: 'local-test-token', enabled: true };
  const publicServices = await invoke('save-mcp-service', service);
  assert.equal(publicServices[0].hasCredentials, true);
  assert.doesNotMatch(JSON.stringify(publicServices), /local-test-token|Authorization|secret/);
  assert.doesNotMatch(await readFile(path.join(profile, 'mcp-services.json'), 'utf8'), /local-test-token/);
  await invoke('save-mcp-service', { ...service, token: '' });
  assert.equal((await invoke('test-mcp-service', service.name))[0].name, 'echo');
  scenario = 'mcp'; const mcpApprovals = [];
  onApproval = (event) => { mcpApprovals.push(event); return invoke('answer-approval', event.id, true); };
  const mcpSession = await reviewed();
  await invoke('send-reviewed-prompt', mcpSession.id, mcpSession.pendingReview, 'original');
  assert.deepEqual(mcpApprovals.map((event) => event.kind), ['mcp-start', 'mcp-call']);
  assert.doesNotMatch(JSON.stringify(mcpApprovals), /local-test-token/);
  assert.ok((await invoke('load-session', mcpSession.id)).messages.some((m) => m.name === 'call_mcp_tool' && m.state === 'done' && /http:桌面远程工具/.test(m.output)));
  await invoke('save-mcp-service', { ...service, token: '', enabled: false });
  scenario = 'readonly'; const disabledSession = await reviewed();
  await invoke('send-reviewed-prompt', disabledSession.id, disabledSession.pendingReview, 'original');
  assert.equal(requestedTools.at(-1).includes('call_mcp_tool'), false);
  await invoke('save-settings', { ...initial, mcpEnabled: false });
  await assert.rejects(invoke('test-mcp-service', service.name), /启用 MCP/);
  await invoke('save-settings', initial);
  await invoke('delete-mcp-service', service.name);
  assert.deepEqual(await invoke('list-mcp-services'), []);
  console.log('PASS managed HTTP MCP credentials, connection discovery, approved agent tool call, service/global disable and deletion');

  async function waitUI(expression) {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (await win.webContents.executeJavaScript(expression)) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail(`UI did not settle: ${expression}`);
  }
  await win.webContents.executeJavaScript("[...document.querySelectorAll('.settings-link')].find((button) => button.textContent.trim() === '记忆').click()");
  await waitUI('!!document.querySelector("#memory-title")');
  await win.webContents.executeJavaScript(`
    const noteInput = document.querySelector('textarea[aria-label="记忆内容"]');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(noteInput, '界面保存的长期偏好');
    noteInput.dispatchEvent(new Event('input', { bubbles: true }));
  `);
  await waitUI('!document.querySelector(".management-primary").disabled');
  await win.webContents.executeJavaScript('document.querySelector(".management-primary").click()');
  await waitUI("[...document.querySelectorAll('.management-list strong')].some((item) => item.textContent === '界面保存的长期偏好')");
  await win.webContents.executeJavaScript("[...document.querySelectorAll('.management-list button')].find((button) => button.textContent.includes('界面保存的长期偏好')).click()");
  await waitUI('!!document.querySelector(".management-delete")');
  await win.webContents.executeJavaScript('document.querySelector(".management-delete").click()');
  await waitUI("!document.querySelector('.management-delete') && ![...document.querySelectorAll('.management-list strong')].some((item) => item.textContent === '界面保存的长期偏好')");
  await win.webContents.executeJavaScript('document.querySelector(\'button[aria-label="关闭记忆"]\').click()');
  await win.webContents.executeJavaScript("[...document.querySelectorAll('.settings-link')].find((button) => button.textContent.trim() === '扩展工具').click()");
  await waitUI('!!document.querySelector("#mcp-title")');
  await win.webContents.executeJavaScript('document.querySelector(".mcp-manual").click()');
  await waitUI('!!document.querySelector(".management-form")');
  for (const [index, value] of [[0, 'ui-http'], [1, httpMcp.url], [2, 'local-test-token']]) {
    await win.webContents.executeJavaScript(`(() => {
      const field = document.querySelectorAll('.management-form input:not([type=checkbox])')[${index}];
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, ${JSON.stringify(value)});
      field.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
  }
  await waitUI('!document.querySelector(".management-primary").disabled');
  await win.webContents.executeJavaScript('document.querySelector(".management-primary").click()');
  await waitUI('!!document.querySelector(".management-test") && !document.querySelector(".management-test").disabled');
  assert.equal(await win.webContents.executeJavaScript('document.querySelector(\'.management-form input[type="password"]\').value'), '', 'saved token is not sent back to the renderer');
  await win.webContents.executeJavaScript('document.querySelector(".management-test").click()');
  await waitUI('!!document.querySelector(".mcp-tools")');
  assert.match(await win.webContents.executeJavaScript('document.querySelector(".mcp-tools").textContent'), /echo/);
  if (process.env.MEIHUA_CAPTURE === '1') await writeFile('/tmp/meihua-mcp-preview.png', (await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript('document.querySelector(".management-delete").click()');
  await waitUI('!document.querySelector(".management-test")');
  await win.webContents.executeJavaScript('document.querySelector(\'button[aria-label="关闭 MCP 管理"]\').click()');
  console.log('PASS memory form saves/deletes; MCP form clears token, discovers and displays actual HTTP tools');

  scenario = 'registry'; const registrySession = await reviewed();
  await invoke('send-reviewed-prompt', registrySession.id, registrySession.pendingReview, 'original');
  const discoveryOutput = (await invoke('load-session', registrySession.id)).messages.find((item) => item.name === 'search_mcp_servers');
  assert.equal(discoveryOutput.state, 'done');
  assert.match(discoveryOutput.output, /桌面测试工具/);
  assert.deepEqual(await invoke('list-mcp-services'), [], 'agent discovery must not silently save or start a service');
  win.webContents.send('agent-event', { type: 'open-session', id: registrySession.id });
  await waitUI('!!document.querySelector(".mcp-suggestions button")');
  await win.webContents.executeJavaScript('document.querySelector(".mcp-suggestions button").click()');
  await waitUI('!!document.querySelector(".mcp-results article")');
  await win.webContents.executeJavaScript('document.querySelector(".mcp-result-actions button").click()');
  await waitUI('!!document.querySelector(\'.mcp-setup input[type="password"]\')');
  assert.equal(await win.webContents.executeJavaScript('document.querySelector(".mcp-setup button.management-primary").disabled'), true);
  await win.webContents.executeJavaScript(`(() => {
    const field = document.querySelector('.mcp-setup input[type="password"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, 'local-test-token');
    field.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitUI('!document.querySelector(".mcp-setup button.management-primary").disabled');
  await win.webContents.executeJavaScript('document.querySelector(".mcp-setup button.management-primary").click()');
  await waitUI('!!document.querySelector(".management-test")');
  assert.equal((await invoke('list-mcp-services'))[0].name, 'test-tools');
  assert.doesNotMatch(await readFile(path.join(profile, 'mcp-services.json'), 'utf8'), /local-test-token/);
  await win.webContents.executeJavaScript('document.querySelector(".management-test").click()');
  await waitUI('!!document.querySelector(".mcp-tools")');
  assert.match(await win.webContents.executeJavaScript('document.querySelector(".mcp-tools").textContent'), /echo/);
  await win.webContents.executeJavaScript('document.querySelector(".management-delete").click()');
  await waitUI('!document.querySelector(".management-test")');
  await win.webContents.executeJavaScript('document.querySelector(\'button[aria-label="关闭 MCP 管理"]\').click()');
  await invoke('save-settings', { ...initial, webAccess: false });
  await assert.rejects(async () => invoke('search-mcp-registry', '网页'), /联网读取/);
  await invoke('save-settings', initial);
  console.log('PASS agent searches catalogue, result card prepares credential form, user adds and connects service, network toggle enforces discovery');

  const localUrl = initial.baseUrl;
  const official = await invoke('save-settings', { ...initial, provider: 'openai', model: 'custom-openai', baseUrl: '', apiKey: 'test-only-key', reviewProvider: 'compatible', reviewModel: 'smoke', reviewBaseUrl: localUrl, reviewApiKey: '' });
  assert.equal(official.modelProfiles.compatible.baseUrl, localUrl);
  assert.ok(official.modelProfiles.openai.customModels.includes('custom-openai'));
  assert.equal(official.reviewHasKey, false, 'local reviewer needs no API key');
  assert.ok((await reviewed()).pendingReview, 'independent local reviewer receives the review request');
  const other = await invoke('save-settings', { ...official, provider: 'deepseek', model: 'deepseek-flash', baseUrl: '', apiKey: 'test-only-key', reviewProvider: 'compatible', reviewModel: 'smoke', reviewBaseUrl: localUrl, reviewApiKey: '' });
  assert.equal(other.modelProfiles.openai.model, 'custom-openai');
  assert.equal(other.modelProfiles.compatible.baseUrl, localUrl);
  console.log('PASS per-provider custom model survives switching; independent local reviewer works without a key');
  await new Promise((resolve) => { win.webContents.once('did-finish-load', resolve); win.webContents.reload(); });
  let pickerOptions = [];
  for (let attempt = 0; attempt < 100; attempt++) {
    pickerOptions = await win.webContents.executeJavaScript("[...document.querySelectorAll('select[aria-label=\"选择执行模型\"] option')].map((item) => item.value)");
    if (pickerOptions.includes('openai:custom-openai')) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(pickerOptions.includes('openai:custom-openai'));
  assert.ok(pickerOptions.includes('compatible:smoke'));
  await win.webContents.executeJavaScript("const picker = document.querySelector('select[aria-label=\"选择执行模型\"]'); picker.value = 'openai:custom-openai'; picker.dispatchEvent(new Event('change', { bubbles: true }));");
  let selectedProvider;
  for (let attempt = 0; attempt < 100; attempt++) {
    selectedProvider = (await invoke('initialize')).settings.provider;
    if (selectedProvider === 'openai') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(selectedProvider, 'openai');
  assert.equal((await invoke('initialize')).settings.model, 'custom-openai');
  console.log('PASS composer lists connected providers and switches the execution provider and custom model');
  // This case uses only the local model and controls motion independently of the host.
  await invoke('save-settings', initial);
  await new Promise((resolve) => { win.webContents.once('did-finish-load', resolve); win.webContents.reload(); });
  await waitUI('!!document.querySelector(".new-task")');
  win.webContents.debugger.attach('1.3');
  const motion = (value) => win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value }],
  });
  await motion('no-preference');
  win.show(); win.focus();
  scenario = 'slow-review';
  async function submitVideoPrompt() {
    finishSlowReview = null;
    await win.webContents.executeJavaScript('document.querySelector(".new-task").click()');
    await waitUI('!!document.querySelector(\'button[aria-label="发送任务"]\') && !document.querySelector(\'textarea[aria-label="任务内容"]\').disabled');
    await win.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('textarea[aria-label="任务内容"]');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '检查雪梅视频背景');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await waitUI('!document.querySelector(\'button[aria-label="发送任务"]\').disabled');
    await win.webContents.executeJavaScript('document.querySelector(\'button[aria-label="发送任务"]\').click()');
    await waitUI('!!document.querySelector(".content-scroll.working")');
    for (let attempt = 0; attempt < 150 && !finishSlowReview; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(finishSlowReview, 'the submitted review reached the local model');
  }
  await submitVideoPrompt();
  let videoState;
  for (let attempt = 0; attempt < 500; attempt++) {
    videoState = await win.webContents.executeJavaScript(`(() => {
      const video = document.querySelector('.work-video video');
      return video && { loop: video.loop, muted: video.muted, paused: video.paused, time: video.currentTime, readyState: video.readyState, working: !!document.querySelector('.content-scroll.working') };
    })()`);
    if (videoState?.working && !videoState.paused && videoState.readyState >= 2 && videoState.time > 3.5) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(videoState?.working && videoState.loop && videoState.muted && !videoState.paused && videoState.readyState >= 2 && videoState.time > 3.5, JSON.stringify(videoState));
  if (process.env.MEIHUA_CAPTURE === '1') {
    await writeFile('/tmp/meihua-working-preview.png', (await win.webContents.capturePage()).toPNG());
  }
  finishSlowReview();
  await waitUI('!document.querySelector(".content-scroll.working") && !document.querySelector(".work-video")');
  await motion('reduce');
  await submitVideoPrompt();
  assert.equal(await win.webContents.executeJavaScript('matchMedia("(prefers-reduced-motion: reduce)").matches && !document.querySelector(".work-video")'), true, 'reduced motion keeps the working view static');
  finishSlowReview();
  await waitUI('!document.querySelector(".content-scroll.working")');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
  win.webContents.debugger.detach();
  console.log('PASS submitted prompt plays muted looping video and reduced motion keeps a static background');
  // Real MCP stdio elicitation -> main-process queue -> React form -> protocol reply.
  const policy = (await invoke('runtime-settings')).agent;
  await invoke('save-agent-config', { ...policy, sandbox: false });
  await invoke('save-settings', { ...initial, mcpEnabled: true, webAccess: true });
  await invoke('save-mcp-service', { name: 'input-tools', transport: 'stdio', command: process.execPath, args: [path.resolve('tests/fixture-input-mcp-server.js')], enabled: true });
  scenario = 'mcp-input'; onApproval = (event) => invoke('answer-approval', event.id, true);
  for (const action of ['accept', 'cancel']) {
    session = await reviewed();
    const execution = invoke('send-reviewed-prompt', session.id, session.pendingReview, 'original');
    await waitUI('!!document.querySelector(".input-request-card input")');
    assert.equal(await win.webContents.executeJavaScript('document.activeElement.closest(".input-request-card") !== null'), true, 'new form receives focus');
    if (action === 'accept') {
      await win.webContents.executeJavaScript(`(() => { const input = document.querySelector('.input-request-card input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '2'); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await win.webContents.executeJavaScript('document.querySelector(".input-request-card .management-primary").click()');
    } else await win.webContents.executeJavaScript('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))');
    await execution;
    await waitUI('!document.querySelector(".input-request-card")');
    assert.match(JSON.stringify((await invoke('load-session', session.id)).messages), new RegExp(action));
  }
  await invoke('delete-mcp-service', 'input-tools'); await invoke('save-agent-config', policy);
  console.log('PASS real MCP elicitation form receives focus, sends typed values, and Escape cancels the request');
  success = true;
} catch (error) { console.error(error); }
finally {
  finishSlowReview?.();
  dialog.showOpenDialog = originalOpen; dialog.showSaveDialog = originalSave;
  powerSaveBlocker.start = originalStart; powerSaveBlocker.stop = originalStop;
  for (const win of BrowserWindow.getAllWindows()) win.destroy();
  server.closeAllConnections(); server.close();
  await httpMcp.close();
  globalThis.fetch = originalFetch;
  net.fetch = originalNetFetch;
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  app.exit(success ? 0 : 1);
}

}
main().catch((error) => { console.error(error); app.exit(1); });
