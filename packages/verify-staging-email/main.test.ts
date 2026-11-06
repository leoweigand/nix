import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verificationLink } from './main.ts';

test('finds the verification CTA and decodes HTML without losing the token fragment', () => {
  assert.equal(verificationLink(`<a href="https://example.com">Logo</a>
    <a href='https://hub.example.com/authentication/verify-email#token=a&amp;email=leo&#64;test.com'>Verify</a>`),
  'https://hub.example.com/authentication/verify-email#token=a&email=leo@test.com');
});

test('ignores unrelated links and terminal control characters', () => {
  for (const href of ['javascript:alert(1)', 'https://example.com/reset',
    'https://example.com/authentication/verify-email#token=&#27;bad']) {
    assert.equal(verificationLink(`<a href="${href}">Link</a>`), undefined);
  }
});
