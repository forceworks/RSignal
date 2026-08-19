import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeScanPosts, postIdentity } from '../public/feed-state.js';

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
