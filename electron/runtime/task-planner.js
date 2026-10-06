import path from 'node:path';
import { roleTools } from './tool-registry.js';

export function parseJson(text) { return JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
function relative(file) { if (typeof file !== 'string' || !file || file.length > 500 || file.includes('\0') || path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) throw new Error('计划产物必须是工作目录内的相对路径'); return file; }
export function validatePlan(raw, catalog) {
  if (!raw || typeof raw.summary !== 'string' || raw.summary.length > 4000 || !Array.isArray(raw.nodes) || !raw.nodes.length || raw.nodes.length > 24) throw new Error('规划须包含摘要和 1–24 个节点');
  const available = new Set(catalog.map((item) => item.name)), ids = new Set(), outputs = new Set();
  const nodes = raw.nodes.map((node) => {
    if (!node || !/^[a-zA-Z0-9_-]{1,50}$/.test(node.id) || ids.has(node.id) || !roleTools[node.role]) throw new Error('计划节点 ID 重复或角色无效'); ids.add(node.id);
    if (typeof node.title !== 'string' || !node.title.trim() || node.title.length > 100 || typeof node.instruction !== 'string' || !node.instruction.trim() || node.instruction.length > 6000) throw new Error('计划节点缺少明确任务');
    if (!Array.isArray(node.dependencies) || node.dependencies.length > 24 || node.dependencies.includes(node.id) || new Set(node.dependencies).size !== node.dependencies.length) throw new Error('节点依赖无效');
    if (!Array.isArray(node.tools) || node.tools.length > 30 || node.tools.some((name) => !available.has(name) || !roleTools[node.role].has(name))) throw new Error('规划请求了未登记或超出角色权限的工具');
    if (!Array.isArray(node.outputs) || node.outputs.length > 20 || !Array.isArray(node.checks) || node.checks.length > 30) throw new Error('规划须声明产物与检查（只读节点可用空数组）');
    for (const file of node.outputs) { relative(file); if (outputs.has(file)) throw new Error('多个节点声明相同产物；应合并编辑节点或使用独立产物'); outputs.add(file); }
    const checks = node.checks.map((check) => { if (!check || !['exists', 'contains', 'json'].includes(check.kind) || !node.outputs.includes(check.path)) throw new Error('检查须对应节点产物'); if (check.kind === 'contains' && (typeof check.text !== 'string' || !check.text || check.text.length > 5000)) throw new Error('内容检查缺少原文'); return { kind: check.kind, path: relative(check.path), ...(check.kind === 'contains' ? { text: check.text } : {}) }; });
    if (node.outputs.some((file) => !checks.some((check) => check.path === file))) throw new Error('每个产物至少需要一个明确检查');
    return { id: node.id, title: node.title, role: node.role, instruction: node.instruction, dependencies: [...node.dependencies], tools: [...new Set(node.tools)], outputs: [...node.outputs], checks, status: 'queued', attempts: 0, summary: '', taskId: null };
  });
  for (const node of nodes) if (node.dependencies.some((id) => !ids.has(id))) throw new Error('规划引用不存在的依赖');
  const done = new Set();
  while (done.size < nodes.length) { const ready = nodes.filter((node) => !done.has(node.id) && node.dependencies.every((id) => done.has(id))); if (!ready.length) throw new Error('规划存在循环依赖'); ready.forEach((node) => done.add(node.id)); }
  return { schemaVersion: 1, summary: raw.summary, nodes };
}
export const plannerInstructions = `你是梅花的 Task Planner。将用户目标拆为可验证的依赖图，只使用登记工具和 research、document、action 三个角色。research 读取和核对资料；document 写报告；action 执行确认过的操作。独立的读取节点可以并行，产物需要唯一相对路径，后续节点通过 dependencies 引用前置成果。不要编造已执行结果，不要执行工具，不要请求或展示密钥。只返回 JSON：{"summary":"任务计划","nodes":[{"id":"research","title":"读取材料","role":"research","instruction":"具体任务","dependencies":[],"tools":["read_file"],"outputs":[],"checks":[]}]}。写文件节点 checks 使用 {"kind":"exists|contains|json","path":"产物路径","text":"contains时必填"}。每个产物至少一个检查。最多24节点，不用为了凑角色创建无意义节点。`;
