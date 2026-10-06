export const roleTools = {
  research: new Set(['list_files', 'read_file', 'search_text', 'search_memory', 'read_skill', 'retrieve_knowledge', 'query_database', 'fetch_webpage', 'browser_read', 'call_registered_api', 'list_mcp_tools', 'call_mcp_tool', 'list_mcp_resources', 'read_mcp_resource', 'list_mcp_prompts', 'get_mcp_prompt']),
  document: new Set(['list_files', 'read_file', 'search_text', 'retrieve_knowledge', 'query_database', 'write_file', 'edit_file', 'export_office', 'read_skill']),
  action: new Set(['list_files', 'read_file', 'search_text', 'write_file', 'edit_file', 'run_command', 'start_command', 'poll_command', 'write_command_input', 'stop_command', 'list_mcp_tools', 'call_mcp_tool', 'call_registered_api', 'browser_read', 'browser_action', 'export_office', 'read_skill', 'search_memory', 'search_mcp_servers', 'list_installed_apps', 'find_contact', 'open_application', 'compose_email', 'send_email']),
};
export class ToolRegistry {
  constructor(tools) { this.tools = new Map(); for (const tool of tools) { if (this.tools.has(tool.name) || !tool.metadata) throw new Error('工具重复或缺少权限元数据'); this.tools.set(tool.name, tool); } }
  forRole(role, requested = null) {
    if (!roleTools[role]) throw new Error('未知分工角色');
    if (requested && requested.some((name) => !roleTools[role].has(name) || !this.tools.has(name))) throw new Error('计划请求了角色范围以外或不可用的工具');
    return [...this.tools.values()].filter((tool) => roleTools[role].has(tool.name) && (!requested || requested.includes(tool.name)));
  }
  catalog() { return [...this.tools.values()].map(({ name, description, metadata }) => ({ name, description, capabilities: metadata.capabilities, sideEffect: metadata.sideEffect })); }
}
