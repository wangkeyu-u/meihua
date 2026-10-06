import { validatePlan } from './task-planner.js';

const specification = ({ id, title, role, instruction, dependencies, tools, outputs, checks }) => ({ id, title, role, instruction, dependencies, tools, outputs, checks });
export function revisePlan(previous, raw, catalog, children = []) {
  const next = validatePlan(raw, catalog), preserved = new Set();
  for (const node of next.nodes) {
    const old = previous.nodes.find((item) => item.id === node.id);
    if (old?.status === 'completed' && JSON.stringify(specification(old)) === JSON.stringify(specification(node))) preserved.add(node.id);
  }
  // If a dependency will run again, downstream evidence is stale too.
  let changed = true;
  while (changed) { changed = false; for (const node of next.nodes) if (preserved.has(node.id) && node.dependencies.some((id) => !preserved.has(id))) { preserved.delete(node.id); changed = true; } }
  for (const node of next.nodes) {
    const old = previous.nodes.find((item) => item.id === node.id);
    if (preserved.has(node.id)) Object.assign(node, structuredClone(old));
    else if (old) {
      const child = children.find((item) => item?.id === old.taskId);
      if (child?.steps.some((step) => ['running', 'interrupted'].includes(step.status) && step.metadata.sideEffect && !['write_file', 'edit_file', 'export_office'].includes(step.tool))) throw new Error(`「${node.title}」包含结果不明的外部操作，须先核对，不能重新派发`);
      node.previousTaskId = old.taskId; node.attempts = old.attempts; node.taskId = null;
    }
  }
  return next;
}
