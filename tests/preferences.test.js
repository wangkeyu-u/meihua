import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultPreferences, filterToolsByPreferences, normalizePreferences } from '../electron/preferences.js';

test('older settings receive working defaults', () => {
  assert.deepEqual(normalizePreferences({}), defaultPreferences);
});

test('preferences reject invalid permission and timeout values', () => {
  assert.throws(() => normalizePreferences({ permissionMode: 'bypass' }), /权限模式/);
  assert.throws(() => normalizePreferences({ commandTimeoutSeconds: 999 }), /超时时间/);
  assert.throws(() => normalizePreferences({ webAccess: 'false' }), /webAccess/);
});

test('read-only mode and tool switches remove capabilities before an agent runs', () => {
  const tools = ['read_file', 'write_file', 'run_command', 'fetch_webpage', 'search_mcp_servers', 'list_mcp_tools', 'call_mcp_tool', 'find_contact', 'send_email'].map((name) => ({ name }));
  const preferences = normalizePreferences({ permissionMode: 'read-only', webAccess: false, mcpEnabled: false, nativeToolsEnabled: false });
  assert.deepEqual(filterToolsByPreferences(tools, preferences).map(({ name }) => name), ['read_file']);
  assert.deepEqual(filterToolsByPreferences(tools, defaultPreferences).map(({ name }) => name), tools.map(({ name }) => name));
  assert.equal(filterToolsByPreferences(tools, { ...defaultPreferences, permissionMode: 'read-only' }).some(({ name }) => name === 'search_mcp_servers'), true);
  assert.equal(filterToolsByPreferences(tools, { ...defaultPreferences, webAccess: false }).some(({ name }) => name === 'search_mcp_servers'), false);
});
