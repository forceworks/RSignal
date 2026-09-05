import test from 'node:test';
import assert from 'node:assert/strict';
import { createScanRunner, inQuietHours, screenInBatches, fetchFollowerBatches } from '../public/scan-policy.js';
import { restoreFeed } from '../public/feed-state.js';

test('startup and timer scans honor quiet days while manual scans still work', async () => {
  const settings = { quietHoursEnabled: true, quietDays: [0, 6], quietStart: '22:00', quietEnd: '07:00' };
  let now = new Date(2026, 8, 5, 12), runs = 0, attempts = 0;
  const scan = createScanRunner({ isQuiet: () => inQuietHours(settings, now), onStart: () => attempts++, run: async () => runs++ });
  assert.equal(await scan(true), false);
  assert.equal(attempts, 0);
  assert.equal(await scan(false), true);
  now = new Date(2026, 8, 7, 22);
  assert.equal(await scan(true), false);
  now = new Date(2026, 8, 8, 6, 59);
  assert.equal(await scan(true), false);
  now = new Date(2026, 8, 8, 7);
  assert.equal(await scan(true), true);
  assert.equal(runs, 2);
  assert.equal(attempts, 2);
});

test('timer and tray requests cannot overlap an active scan and failures release the guard', async () => {
  let release;
  const scan = createScanRunner({ isQuiet: () => false, run: () => new Promise((_, reject) => { release = reject; }) });
  const active = scan(false);
  assert.equal(await scan(true), false);
  assert.equal(await scan(false), false);
  release(new Error('fixture failure'));
  await assert.rejects(active, /fixture failure/);
  const retry = scan(true);
  release(new Error('second failure'));
  await assert.rejects(retry, /second failure/);
});

test('large scans screen every post in bounded batches and preserve order', async () => {
  const posts = Array.from({ length: 601 }, (_, id) => ({ id, text: `Post ${id}` }));
  const requests = [];
  const result = await screenInBatches(posts, 'Avoid hiring', '', async body => {
    const batch = JSON.parse(body).posts;
    requests.push(batch.length);
    return { decisions: batch.map((post, index) => ({ index, show: post.id % 2 === 0 })), cachedCount: batch.length };
  });
  assert.deepEqual(requests, [100, 100, 100, 100, 100, 100, 1]);
  assert.deepEqual(result.posts.map(post => post.id), posts.filter(post => post.id % 2 === 0).map(post => post.id));
  assert.equal(result.excluded, 300);
  assert.equal(result.cachedCount, 601);
});

test('screening bounds UTF-8 request bytes and rejects incomplete decisions', async () => {
  const posts = [{ text: 'é'.repeat(240_000) }, { text: 'é'.repeat(240_000) }];
  let calls = 0;
  await screenInBatches(posts, 'preferences', '', async body => {
    calls++;
    assert.ok(Buffer.byteLength(body) < 1_000_000);
    return { decisions: [{ index: 0, show: true }] };
  });
  assert.equal(calls, 2);
  const incomplete = await screenInBatches([{}], '', '', async () => ({ decisions: [] }));
  assert.match(incomplete.error, /incomplete/);
  assert.equal(incomplete.posts.length, 0);
});

test('later AI batch failure preserves exclusions and never approves unscreened posts', async () => {
  const posts = Array.from({ length: 101 }, (_, id) => ({ id }));
  let calls = 0;
  const result = await screenInBatches(posts, 'exclude hiring', '', async body => {
    if (++calls === 2) throw new Error('fixture service outage');
    return { decisions: JSON.parse(body).posts.map((_, index) => ({ index, show: index === 0 })) };
  });
  assert.deepEqual(result.posts, [posts[0]]);
  assert.equal(result.excluded, 99);
  assert.deepEqual(result.pendingPosts, [posts[100]]);
  assert.equal(result.skipped, true);
});

test('follower lookups deduplicate and include authors beyond the first 100', async () => {
  const authors = Array.from({ length: 101 }, (_, index) => ({ platform: 'x', username: `author${index}` }));
  const sizes = [];
  const result = await fetchFollowerBatches([...authors, ...authors, { platform: 'x', username: 'unknown' }], async batch => {
    sizes.push(batch.length);
    return { profiles: batch.map(author => ({ ...author, followers: 500 })), costUsd: 1 };
  });
  assert.deepEqual(sizes, [100, 1]);
  assert.equal(result.profiles.length, 101);
  assert.equal(result.profiles[100].username, 'author100');
  assert.equal(result.costUsd, 2);
});

test('restores fresh feed after restart and expires old or hidden posts', () => {
  const now = Date.now();
  const post = { platform: 'x', id: '1', text: 'Fresh', author: { name: 'Fixture' }, createdAt: new Date(now - 60_000).toISOString() };
  const expired = { ...post, id: '2', createdAt: new Date(now - 3 * 3_600_000).toISOString() };
  const storage = { getItem: () => JSON.stringify([post, expired]) };
  assert.deepEqual(restoreFeed(storage, { now, maxAgeHours: 3 }), [post]);
  assert.deepEqual(restoreFeed(storage, { now, maxAgeHours: 3, hidden: ['x:1'] }), []);
  assert.deepEqual(restoreFeed({ getItem: () => 'broken JSON' }), []);
});
