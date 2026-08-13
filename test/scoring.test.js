import test from 'node:test';
import assert from 'node:assert/strict';
import { score } from '../public/scoring.js';

const now = Date.parse('2026-08-12T20:00:00Z');
const post = (minutesOld, overrides = {}) => ({
  createdAt: new Date(now - minutesOld * 60000).toISOString(),
  likes: 0,
  replies: 0,
  reposts: 0,
  views: 100,
  ...overrides
});

test('rewards an unanswered post over otherwise identical posts with replies', () => {
  const unanswered = score(post(10), now);
  const oneReply = score(post(10, { replies: 1 }), now);
  const severalReplies = score(post(10, { replies: 5 }), now);

  assert.ok(unanswered > oneReply);
  assert.ok(oneReply > severalReplies);
  assert.equal(unanswered - oneReply, 3);
});

test('prioritizes a fresh unanswered opportunity over an older viral conversation', () => {
  const freshUnanswered = score(post(5), now);
  const olderViral = score(post(180, {
    likes: 5000,
    replies: 100,
    reposts: 1000,
    views: 1_000_000
  }), now);

  assert.ok(freshUnanswered > olderViral);
});

test('caps momentum and handles missing engagement values safely', () => {
  assert.ok(Number.isFinite(score({ createdAt: post(5).createdAt }, now)));
  assert.ok(score(post(5, { likes: 1_000_000, reposts: 1_000_000 }), now) <= 99);
});
