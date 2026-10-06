import test from 'node:test';
import assert from 'node:assert/strict';
import { replaceOnce } from '../electron/edit.js';

test('an edit requires one unique matching span', () => {
  assert.equal(replaceOnce('alpha\nbeta\n', 'beta', 'gamma'), 'alpha\ngamma\n');
  assert.throws(() => replaceOnce('alpha alpha', 'alpha', 'gamma'), /多次/);
  assert.throws(() => replaceOnce('alpha', 'beta', 'gamma'), /找不到/);
});
