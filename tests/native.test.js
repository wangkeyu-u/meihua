import test from 'node:test';
import assert from 'node:assert/strict';
import { findApps, resolveApp, mailtoUrl, validateEmailAddress } from '../electron/native.js';

test('native macOS app index resolves a requested mail app and builds a safe draft address', async () => {
  const mail = await resolveApp('邮件');
  assert.equal(mail.name, 'Mail');
  assert.match(mail.path, /Mail\.app$/);
  assert.equal((await findApps('Mail')).some((item) => item.name === 'Mail'), true);
  const url = mailtoUrl('person@example.com', '你好', '正文');
  assert.match(url, /^mailto:person%40example\.com\?/);
  assert.match(url, /subject=/);
  assert.throws(() => validateEmailAddress('not-an-email'), /邮箱地址/);
});
