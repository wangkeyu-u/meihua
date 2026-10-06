import { redact } from './task-events.js';

const definitions = {
  list_files: ['low', ['filesystem.read'], false], read_file: ['low', ['filesystem.read'], false], search_text: ['low', ['filesystem.read'], false], read_skill: ['low', ['filesystem.read'], false], search_memory: ['low', ['memory.read'], false],
  write_file: ['medium', ['filesystem.write'], true], edit_file: ['medium', ['filesystem.write'], true], export_office: ['medium', ['filesystem.write'], true],
  start_command: ['high', ['process.execute'], true], poll_command: ['low', ['process.read'], false], write_command_input: ['high', ['process.execute'], true], stop_command: ['medium', ['process.execute'], true],
  run_command: ['high', ['process.execute'], true], fetch_webpage: ['low', ['network.read'], false], search_mcp_servers: ['low', ['network.read'], false],
  list_mcp_tools: ['high', ['process.execute', 'network.read'], true], call_mcp_tool: ['high', ['mcp.call', 'network.write'], true],
  list_installed_apps: ['low', ['system.read'], false], find_contact: ['medium', ['contacts.read'], false], open_application: ['medium', ['system.open'], true], compose_email: ['medium', ['email.draft'], true], send_email: ['high', ['email.send'], true],
  retrieve_knowledge: ['low', ['filesystem.read'], false], query_database: ['low', ['database.read'], false], browser_read: ['medium', ['network.read'], true], browser_action: ['high', ['network.write'], true], call_registered_api: ['high', ['network.request'], true],
  list_mcp_resources: ['high', ['network.read'], true], read_mcp_resource: ['high', ['network.read'], true], list_mcp_prompts: ['high', ['network.read'], true], get_mcp_prompt: ['high', ['network.read'], true],
};
export const approvalMetadata = Object.freeze({ write: 'write_file', edit: 'edit_file', export: 'export_office', command: 'run_command', 'mcp-start': 'list_mcp_tools', 'mcp-call': 'call_mcp_tool', 'app-open': 'open_application', 'email-draft': 'compose_email', 'email-send': 'send_email', browser: 'browser_action', 'api-call': 'call_registered_api' });
export function toolMetadata(name) {
  const definition = definitions[name]; if (!definition) throw new Error(`工具缺少能力定义：${name}`);
  const [riskLevel, capabilities, sideEffect] = definition;
  return Object.freeze({ riskLevel, capabilities: Object.freeze([...capabilities]), sideEffect, requiresApproval: sideEffect && name !== 'stop_command', source: name.includes('mcp') ? 'mcp' : name === 'fetch_webpage' ? 'web' : ['read_file', 'read_skill', 'search_text', 'list_files'].includes(name) ? 'file' : name === 'search_memory' ? 'memory' : 'tool', trusted: false });
}
export function inputSummary(args) {
  return JSON.stringify(redact(Object.fromEntries(Object.entries(args || {}).map(([key, value]) => [key, ['content', 'body', 'old_text', 'new_text'].includes(key) ? `[${String(value).length} 字符]` : value])))).slice(0, 1500);
}
export function failureResult(tool, error) {
  const message = String(error?.message || error), rejected = /用户拒绝|未获确认/.test(message);
  return { ok: false, tool, summary: message, retryable: !['call_mcp_tool', 'call_registered_api', 'browser_action', 'open_application', 'compose_email', 'send_email', 'run_command', 'start_command', 'write_command_input', 'stop_command'].includes(tool) && !rejected && !/已停止|暂停|路径超出|已变化/.test(message), error: { code: rejected ? 'APPROVAL_REJECTED' : error?.code || 'TOOL_FAILED', message }, changedFiles: [] };
}
export function normalizeToolResult(tool, raw, args = {}) {
  if (raw?.details?.tool === tool && typeof raw.details.ok === 'boolean') return raw.details;
  if (raw?.tool === tool && typeof raw.ok === 'boolean') return raw;
  const text = (raw?.content || []).filter((block) => block.type === 'text').map((block) => block.text).join('\n');
  let data; try { data = JSON.parse(text); } catch { data = text; }
  const changed = { write_file: args.path, edit_file: args.path, export_office: args.target_path }[tool];
  return { ok: true, tool, summary: text.slice(0, 2000), data, changedFiles: changed ? [changed] : [], retryable: false, requiresVerification: Boolean(changed) };
}
export function modelToolResult(result) {
  return { content: [{ type: 'text', text: JSON.stringify({ ...result, source: toolMetadata(result.tool).source, trusted: false }) }], details: result };
}
export async function executeTool({ name, args, run, manager, taskId, allowedTools, onStep = () => {}, invocation = {}, withInvocation = (_invocation, work) => work() }) {
  if (!allowedTools.has(name)) throw new Error('运行时权限不允许这个工具');
  const metadata = toolMetadata(name), stepId = taskId ? await manager.startStep(taskId, { tool: name, inputSummary: inputSummary(args), metadata }) : null;
  if (taskId) await manager.mutate(taskId, (record) => { Object.assign(record.steps.find((step) => step.id === stepId), { invocation: { callId: invocation.callId || null, turnId: taskId, resources: invocation.resources || [] } }); record.steps.find((step) => step.id === stepId).operationKey = ['write_file', 'edit_file', 'export_office'].includes(name) ? `${name}:${args.path || args.target_path}` : `${name}:${inputSummary(args)}`; });
  onStep(stepId);
  let result;
  try { result = normalizeToolResult(name, await withInvocation({ ...invocation, taskId, stepId }, run), args); }
  catch (error) { result = failureResult(name, error); }
  if (taskId) await manager.completeStep(taskId, stepId, result);
  onStep(null);
  if (!result.ok) {
    const error = new Error(JSON.stringify(result)); error.toolResult = result; throw error;
  }
  return modelToolResult(result);
}
export function displayToolResult(raw) {
  const detail = raw?.details;
  if (detail?.tool && typeof detail.ok === 'boolean') return typeof detail.data === 'string' ? detail.data : detail.data !== undefined ? JSON.stringify(detail.data) : detail.summary;
  return (raw?.content || []).filter((block) => block.type === 'text').map((block) => block.text).join('\n');
}
