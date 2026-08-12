import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { diagnosticRequestBody, extractFollowerCount, extractLinkedInPosts, followerLookupRequest, isCommentRecord, normalizeLinkedInPost, normalizeRedditPost, normalizeSubstackPost, normalizeTikTokVideo, normalizeXPost, normalizeYouTubeVideo, parsePostDate, sourceQuery, sourceRequest } from '../server.js';

const linkedinFixture = JSON.parse(await readFile(new URL('./fixtures/linkedin.search_posts.createdUtc.json', import.meta.url), 'utf8'));
const linkedinFullFixture = JSON.parse(await readFile(new URL('./fixtures/linkedin.search_posts_full.sanitized.json', import.meta.url), 'utf8'));
const twitterProfileFixture = JSON.parse(await readFile(new URL('./fixtures/twitter.profile.sanitized.json', import.meta.url), 'utf8'));
const linkedinProfileFixture = JSON.parse(await readFile(new URL('./fixtures/linkedin.profile.sanitized.json', import.meta.url), 'utf8'));
const redditFixture = JSON.parse(await readFile(new URL('./fixtures/reddit.search.sanitized.json', import.meta.url), 'utf8'));
const youtubeFixture = JSON.parse(await readFile(new URL('./fixtures/youtube.search.sanitized.json', import.meta.url), 'utf8'));
const tiktokFixture = JSON.parse(await readFile(new URL('./fixtures/tiktok.hashtag_videos.sanitized.json', import.meta.url), 'utf8'));
const substackFixture = JSON.parse(await readFile(new URL('./fixtures/substack.posts.sanitized.json', import.meta.url), 'utf8'));

test('parses the real LinkedIn response shape and createdUtc Unix seconds', () => {
  const rawPosts = extractLinkedInPosts(linkedinFixture);
  assert.equal(rawPosts.length, 5);

  const posts = rawPosts.map((raw, index) => normalizeLinkedInPost(raw, 'Power Platform', index));
  assert.equal(posts.filter(post => post.createdAt).length, 5);
  assert.equal(posts[0].createdAt, new Date(1785811801 * 1000).toISOString());
  assert.equal(posts[0].text, '[sanitized LinkedIn post 1]');
});

test('parses rich LinkedIn search results with author and engagement details', () => {
  const rawPosts = extractLinkedInPosts(linkedinFullFixture);
  assert.equal(rawPosts.length, 1);

  const post = normalizeLinkedInPost(rawPosts[0], 'Power Platform', 0);
  assert.equal(post.createdAt, new Date(1786441088 * 1000).toISOString());
  assert.equal(post.author.name, 'Sanitized LinkedIn author');
  assert.equal(post.author.username, 'sanitized-linkedin-author');
  assert.equal(post.author.profileUrl, 'https://www.linkedin.com/in/sanitized-linkedin-author/');
  assert.equal(post.author.followers, null);
  assert.equal(post.replies, 3);
  assert.equal(post.likes, 10);
  assert.equal(post.reposts, 2);
});

test('parses publishedAt variants without treating Unix seconds as milliseconds', () => {
  const post = normalizeLinkedInPost({
    publishedAt: { value: 1785939242 },
    text: 'fixture',
    url: 'https://www.linkedin.com/posts/fixture-activity-7490772107048464384-fixture'
  }, 'fixture', 0);
  assert.equal(post.createdAt, new Date(1785939242 * 1000).toISOString());
  assert.equal(parsePostDate('2026-08-07T13:00:00Z'), '2026-08-07T13:00:00.000Z');
});

test('keeps source topics separate from platform query syntax', () => {
  const topic = '"AI agents" AND (enterprise OR SaaS) -is:repost -is:retweet';
  assert.equal(sourceQuery('linkedin', topic), '"AI agents" AND (enterprise OR SaaS)');
  assert.equal(sourceQuery('x', topic), '"AI agents" enterprise OR SaaS -is:retweet');
});

test('normalizes X createdAt and keeps the Latest query compatible', () => {
  const post = normalizeXPost({
    id: '1234567890123456789',
    created_at: 'Wed Aug 06 12:00:02 +0000 2026',
    user: { name: 'Sanitized author', screen_name: 'fixture_author', followers_count: 24680 },
    full_text: 'fixture X post',
    url: 'https://x.com/fixture_author/status/1234567890123456789'
  }, 'Power Platform', 0);
  assert.equal(post.createdAt, '2026-08-06T12:00:02.000Z');
  assert.equal(post.author.username, 'fixture_author');
  assert.equal(post.author.followers, 24680);
});

test('parses follower counts from sanitized real profile responses', () => {
  assert.equal(extractFollowerCount(twitterProfileFixture, 'x'), 1234567);
  assert.equal(extractFollowerCount(linkedinProfileFixture, 'linkedin'), 123456);
});

test('builds validated follower profile lookups', () => {
  assert.deepEqual(followerLookupRequest({ platform: 'x', username: '@fixture_author' }), {
    platform: 'x',
    username: 'fixture_author',
    profileUrl: 'https://x.com/fixture_author',
    cacheKey: 'x:fixture_author',
    sku: 'twitter.profile',
    body: { handle: 'fixture_author' }
  });
  assert.deepEqual(followerLookupRequest({ platform: 'linkedin', username: 'fixture-author', profileUrl: 'https://www.linkedin.com/in/fixture-author/' })?.body, { url: 'https://www.linkedin.com/in/fixture-author' });
  assert.equal(followerLookupRequest({ platform: 'linkedin', username: 'fixture', profileUrl: 'https://example.com/in/fixture' })?.body.url, 'https://www.linkedin.com/in/fixture');
  assert.equal(followerLookupRequest({ platform: 'linkedin', username: 'unknown', profileUrl: 'https://example.com/in/fixture' }), null);
  assert.equal(followerLookupRequest({ platform: 'x', username: 'not a handle' }), null);
});

test('keeps profile request field names but redacts their values in diagnostics', () => {
  assert.deepEqual(diagnosticRequestBody({ handle: 'fixture_author' }, true), { handle: '[redacted]' });
  assert.deepEqual(diagnosticRequestBody({ url: 'https://www.linkedin.com/in/fixture-author' }, true), { url: '[redacted]' });
});

test('identifies comments and replies without rejecting ordinary posts', () => {
  assert.equal(isCommentRecord({ referenced_tweets: [{ type: 'replied_to', id: '123' }] }, 'x'), true);
  assert.equal(isCommentRecord({ in_reply_to_status_id_str: '123' }, 'x'), true);
  assert.equal(isCommentRecord({ urn: 'urn:li:comment:(activity,comment)' }, 'linkedin'), true);
  assert.equal(isCommentRecord({ url: 'https://www.linkedin.com/posts/fixture-activity-123' }, 'linkedin'), false);
});

test('normalizes the timestamped expansion source fixtures', () => {
  const reddit = normalizeRedditPost(redditFixture.output.data.posts[0], 'AI agents', 0);
  const youtube = normalizeYouTubeVideo(youtubeFixture.output.data.videos[0], 'Microsoft Copilot', 0);
  const tiktok = normalizeTikTokVideo(tiktokFixture.output.data.items[0], '#aiagents', 0);
  const substack = normalizeSubstackPost(substackFixture.output.data.items[0], 'https://sanitized.substack.com', 0);
  for (const post of [reddit, youtube, tiktok, substack]) assert.equal(post.createdAt, new Date(1786101000 * 1000).toISOString());
  assert.equal(reddit.url, 'https://www.reddit.com/r/technology/comments/fixture-reddit-1/sanitized_post/');
  assert.equal(youtube.views, 1200);
  assert.equal(tiktok.author.username, 'fixture_creator');
  assert.match(substack.text, /Building software/);
});

test('builds source-specific expansion requests without leaking X syntax', () => {
  assert.deepEqual(sourceRequest('linkedin', 'AI agents', 12, 1), { query: 'AI agents', datePosted: 'last-day', sort: 'date', limit: 10 });
  assert.deepEqual(sourceRequest('linkedin', 'AI agents', 12, 24), { query: 'AI agents', datePosted: 'last-day', sort: 'date', limit: 10 });
  assert.deepEqual(sourceRequest('linkedin', 'AI agents', 12, 168), { query: 'AI agents', datePosted: 'last-week', sort: 'date', limit: 10 });
  assert.equal(sourceRequest('linkedin', 'AI agents', 5, 24).limit, 5);
  assert.deepEqual(sourceRequest('reddit', 'AI agents', 12), { query: 'AI agents', sort: 'new', timeframe: 'week' });
  assert.deepEqual(sourceRequest('youtube', 'Microsoft Copilot', 12), { query: 'Microsoft Copilot', uploadDate: 'this_week' });
  assert.deepEqual(sourceRequest('tiktok', '#aiagents', 12), { hashtag: 'aiagents', limit: 12 });
  assert.deepEqual(sourceRequest('substack', 'https://sanitized.substack.com', 12), { url: 'https://sanitized.substack.com', limit: 12, includeContent: false });
  assert.equal(sourceQuery('reddit', 'AI agents -is:retweet'), 'AI agents');
  assert.equal(sourceQuery('youtube', 'from:elonmusk Microsoft Copilot'), 'Microsoft Copilot');
});
