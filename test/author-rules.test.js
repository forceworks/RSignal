import test from 'node:test';
import assert from 'node:assert/strict';
import { authorIdentity, authorMode, changeAuthorRule, readAuthorRules } from '../public/author-rules.js';

const post = (platform, username, profileUrl) => ({ platform, author: { username, profileUrl } });

test('X handles and profile aliases resolve to the same source-specific identity', () => {
  assert.equal(authorIdentity(post('x', '@Example')), 'x:example');
  assert.equal(authorIdentity(post('x', 'unknown', 'https://mobile.twitter.com/Example/?ref=test')), 'x:example');
  assert.equal(authorIdentity(post('x', 'example', 'https://x.com/example/status/123')), 'x:example');
  assert.equal(authorIdentity(post('x', 'unknown')), '');
  assert.equal(authorIdentity(post('x', 'unknown', 'https://x.com/unknown')), '');
  assert.equal(authorIdentity(post('x', 'Example Person')), '');
  assert.equal(authorIdentity(post('x', 'unknown', 'https://x.com.evil.test/example')), '');
});

test('LinkedIn uses canonical profile identity and distinguishes people from companies', () => {
  assert.equal(authorIdentity(post('linkedin', '@Example')), 'linkedin:in:example');
  assert.equal(authorIdentity(post('linkedin', 'unknown', 'https://www.linkedin.com/in/Example/?tracking=1')), 'linkedin:in:example');
  assert.equal(authorIdentity(post('linkedin', 'example', 'https://uk.linkedin.com/company/Example/')), 'linkedin:company:example');
  assert.equal(authorIdentity(post('linkedin', 'Example Person')), '');
  assert.equal(authorIdentity(post('linkedin', 'unknown', 'https://www.linkedin.com/in/unknown')), '');
});

test('display-only and deleted authors cannot become shared blocking identities', () => {
  assert.equal(authorIdentity(post('reddit', 'u/Example')), 'reddit:example');
  assert.equal(authorIdentity(post('reddit', '[deleted]')), '');
  assert.equal(authorIdentity(post('tiktok', '@Example.name')), 'tiktok:example.name');
  assert.equal(authorIdentity(post('youtube', 'Example')), '');
  assert.equal(authorIdentity(post('substack', 'Example')), '');
  assert.equal(authorIdentity(post('youtube', 'Example', 'https://www.youtube.com/channel/UCAbC')), 'youtube:/channel/UCAbC');
});

test('blocking and preference are exclusive, removable, and source-specific', () => {
  const author = { key: 'x:example', label: 'Example', platform: 'x' };
  const blocked = changeAuthorRule([], author, 'blocked');
  assert.equal(authorMode(post('x', 'Example'), blocked), 'blocked');
  assert.equal(authorMode(post('linkedin', 'Example'), blocked), '');
  const preferred = changeAuthorRule(blocked, author, 'preferred');
  assert.equal(preferred.length, 1);
  assert.equal(preferred[0].mode, 'preferred');
  assert.equal(blocked[0].mode, 'blocked');
  assert.deepEqual(changeAuthorRule(preferred, author, ''), []);
});

test('stored rules tolerate invalid JSON, wrong shapes, and duplicates', () => {
  const read = value => readAuthorRules({ getItem: () => value });
  for (const value of ['{', 'null', '{}', '42']) assert.deepEqual(read(value), []);
  const rule = { key: 'x:example', label: '<script>Example</script>', platform: 'x', mode: 'blocked' };
  assert.deepEqual(read(JSON.stringify([null, {}, rule, { ...rule, mode: 'preferred' }, { ...rule, platform: 'linkedin' }])), [{ ...rule, mode: 'preferred' }]);
  assert.deepEqual(readAuthorRules({ getItem() { throw new Error('unavailable'); } }), []);
});
