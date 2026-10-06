const disabledByReadOnly = new Set([
  'write_file', 'edit_file', 'export_office', 'run_command', 'start_command', 'write_command_input', 'stop_command',
  'open_application', 'compose_email', 'send_email', 'list_mcp_tools', 'call_mcp_tool', 'browser_action', 'call_registered_api', 'list_mcp_resources', 'read_mcp_resource', 'list_mcp_prompts', 'get_mcp_prompt',
]);
const nativeTools = new Set(['list_installed_apps', 'find_contact', 'open_application', 'compose_email', 'send_email']);
const mcpTools = new Set(['list_mcp_tools', 'call_mcp_tool', 'search_mcp_servers', 'list_mcp_resources', 'read_mcp_resource', 'list_mcp_prompts', 'get_mcp_prompt']);

export const defaultPreferences = Object.freeze({
  permissionMode: 'ask',
  webAccess: true,
  mcpEnabled: true,
  nativeToolsEnabled: true,
  commandTimeoutSeconds: 120,
  customInstructions: '',
  theme: 'system',
  fontSize: 'medium',
  sendShortcut: 'enter',
  completionNotifications: false,
  preventSleep: false,
  memoryEnabled: true,
  autoMemory: true,
});

export function normalizePreferences(value = {}) {
  if (value.permissionMode !== undefined && !['ask', 'read-only'].includes(value.permissionMode)) throw new Error('无效的权限模式');
  for (const key of ['webAccess', 'mcpEnabled', 'nativeToolsEnabled', 'completionNotifications', 'preventSleep', 'memoryEnabled', 'autoMemory']) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') throw new Error(`无效的设置：${key}`);
  }
  for (const [key, allowed] of Object.entries({ theme: ['system', 'light', 'dark'], fontSize: ['small', 'medium', 'large'], sendShortcut: ['enter', 'mod-enter'] })) {
    if (value[key] !== undefined && !allowed.includes(value[key])) throw new Error(`无效的设置：${key}`);
  }
  const timeout = value.commandTimeoutSeconds ?? defaultPreferences.commandTimeoutSeconds;
  if (![30, 120, 300].includes(timeout)) throw new Error('命令超时时间只支持 30、120 或 300 秒');
  const instructions = value.customInstructions ?? '';
  if (typeof instructions !== 'string' || instructions.length > 8000) throw new Error('个人指令不能超过 8000 个字符');
  return {
    permissionMode: value.permissionMode ?? defaultPreferences.permissionMode,
    webAccess: value.webAccess ?? defaultPreferences.webAccess,
    mcpEnabled: value.mcpEnabled ?? defaultPreferences.mcpEnabled,
    nativeToolsEnabled: value.nativeToolsEnabled ?? defaultPreferences.nativeToolsEnabled,
    commandTimeoutSeconds: timeout,
    customInstructions: instructions.trim(),
    theme: value.theme ?? defaultPreferences.theme,
    fontSize: value.fontSize ?? defaultPreferences.fontSize,
    sendShortcut: value.sendShortcut ?? defaultPreferences.sendShortcut,
    completionNotifications: value.completionNotifications ?? false,
    preventSleep: value.preventSleep ?? false,
    memoryEnabled: value.memoryEnabled ?? true,
    autoMemory: value.autoMemory ?? true,
  };
}

export function filterToolsByPreferences(tools, preferences) {
  return tools.filter(({ name }) =>
    !(preferences.permissionMode === 'read-only' && disabledByReadOnly.has(name)) &&
    !(!preferences.webAccess && ['fetch_webpage', 'search_mcp_servers', 'browser_read', 'browser_action', 'call_registered_api'].includes(name)) &&
    !(!preferences.mcpEnabled && mcpTools.has(name)) &&
    !(!preferences.nativeToolsEnabled && nativeTools.has(name))
  );
}
