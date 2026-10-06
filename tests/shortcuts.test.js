import test from 'node:test';
import assert from 'node:assert/strict';
import { allShortcuts, normalizeShortcutDraft } from '../electron/shortcuts.js';

test('custom quick jumps preserve builtin keys and accept only HTTPS destinations', () => {
  const custom = normalizeShortcutDraft({ name: '资料', url: 'https://example.com/docs', key: '4' });
  assert.deepEqual(allShortcuts([custom]).map((item) => item.key), ['1', '2', '3', '4']);
  assert.throws(() => normalizeShortcutDraft({ name: '错误', url: 'javascript:alert(1)', key: '5' }), /HTTPS/);
  assert.throws(() => normalizeShortcutDraft({ name: '冲突', url: 'https://example.com/', key: '4' }, [custom]), /已被使用/);
});
