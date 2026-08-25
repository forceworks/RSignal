import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeScanPosts, normalizePostIdentity, postIdentity } from '../public/feed-state.js';

function fixture(id, ageMinutes, extra = {}) {
  return {
    platform: 'x',
    id,
    url: `https://x.com/fixture/status/${id}`,
    createdAt: new Date(Date.UTC(2026, 7, 19, 12) - ageMinutes * 60_000).toISOString(),
    author: { username: 'fixture', followers: null },
    ...extra
  };
}

test('merges new scan posts while expiring old and hidden results', () => {
  const now = Date.UTC(2026, 7, 19, 12);
  const retained = fixture('retained', 60, { author: { username: 'fixture', followers: 4200 } });
  const expired = fixture('expired', 200);
  const hidden = fixture('hidden', 30);
  const incoming = fixture('incoming', 5);
  const refreshed = fixture('retained', 55);

  const result = mergeScanPosts([retained, expired, hidden], [incoming, refreshed], {
    maxAgeHours: 3,
    hidden: [postIdentity(hidden)],
    now
  });

  assert.deepEqual(result.map(post => post.id), ['incoming', 'retained']);
  assert.equal(result[1].createdAt, refreshed.createdAt);
  assert.equal(result[1].author.followers, 4200);
});

test('keeps current opportunities when a scan returns no new posts', () => {
  const now = Date.UTC(2026, 7, 19, 12);
  const current = fixture('current', 20);
  assert.deepEqual(mergeScanPosts([current], [], { maxAgeHours: 3, now }), [current]);
});

test('expires opportunities as soon as they reach the freshness limit', () => {
  const now = Date.UTC(2026, 7, 19, 12);
  const justFresh = fixture('just-fresh', 179.5);
  const atLimit = fixture('at-limit', 180);

  assert.deepEqual(
    mergeScanPosts([justFresh, atLimit], [], { maxAgeHours: 3, now }).map(post => post.id),
    ['just-fresh']
  );
});

test('uses stable identities across provider URL variants and legacy hidden keys', () => {
  const now = Date.UTC(2026, 7, 19, 12);
  const xPost = fixture('1905545699552375179', 10, { url: 'https://x.com/first_handle/status/1905545699552375179?s=20#fragment' });
  const xDuplicate = fixture('provider-specific-id', 10, { url: 'https://twitter.com/renamed_handle/status/1905545699552375179/' });
  assert.equal(postIdentity(xPost), 'x:1905545699552375179');
  assert.equal(postIdentity(xDuplicate), postIdentity(xPost));
  assert.equal(normalizePostIdentity('x:https://twitter.com/old_handle/status/1905545699552375179?s=20'), postIdentity(xPost));
  assert.deepEqual(mergeScanPosts([], [xPost, xDuplicate], { maxAgeHours: 3, now }).map(postIdentity), ['x:1905545699552375179']);
  assert.deepEqual(mergeScanPosts([], [xDuplicate], {
    maxAgeHours: 3,
    hidden: ['x:https://x.com/old_handle/status/1905545699552375179?s=20'],
    now
  }), []);

  const linkedInPost = fixture('7490772107048464384', 10, { platform: 'linkedin', url: 'https://www.linkedin.com/posts/example_activity-7490772107048464384-test?trackingId=one' });
  const linkedInDuplicate = { ...linkedInPost, id: 'different-provider-id', url: 'https://linkedin.com/feed/update/urn:li:activity:7490772107048464384/' };
  assert.equal(postIdentity(linkedInPost), 'linkedin:7490772107048464384');
  assert.equal(postIdentity(linkedInDuplicate), postIdentity(linkedInPost));
});
