import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { canonicalLinkedInArticleUrl, canonicalXPostUrl, compareVersions, createUpdateChecker, diagnosticRequestBody, extractFollowerCount, extractLinkedInPosts, followerLookupRequest, isCommentRecord, isRepostRecord, isXArticleCandidate, normalizeLinkedInArticle, normalizeLinkedInPost, normalizeRedditPost, normalizeSubstackPost, normalizeTikTokVideo, normalizeXArticle, normalizeXPost, normalizeYouTubeVideo, parsePostDate, releaseUpdateStatus, sourceQuery, sourceRequest } from '../server.js';

const linkedinFixture = JSON.parse(await readFile(new URL('./fixtures/linkedin.search_posts.createdUtc.json', import.meta.url), 'utf8'));
const linkedinFullFixture = JSON.parse(await readFile(new URL('./fixtures/linkedin.search_posts_full.sanitized.json', import.meta.url), 'utf8'));
const linkedinAttachmentsFixture = JSON.parse(await readFile(new URL('./fixtures/linkedin.search_posts_full.attachments.sanitized.json', import.meta.url), 'utf8'));
const linkedinArticleFixture = JSON.parse(await readFile(new URL('./fixtures/linkedin.article.sanitized.json', import.meta.url), 'utf8'));
const twitterProfileFixture = JSON.parse(await readFile(new URL('./fixtures/twitter.profile.sanitized.json', import.meta.url), 'utf8'));
const twitterArticleFixture = JSON.parse(await readFile(new URL('./fixtures/twitter.article.sanitized.json', import.meta.url), 'utf8'));
const linkedinProfileFixture = JSON.parse(await readFile(new URL('./fixtures/linkedin.profile.sanitized.json', import.meta.url), 'utf8'));
const redditFixture = JSON.parse(await readFile(new URL('./fixtures/reddit.search.sanitized.json', import.meta.url), 'utf8'));
const youtubeFixture = JSON.parse(await readFile(new URL('./fixtures/youtube.search.sanitized.json', import.meta.url), 'utf8'));
const tiktokFixture = JSON.parse(await readFile(new URL('./fixtures/tiktok.hashtag_videos.sanitized.json', import.meta.url), 'utf8'));
const substackFixture = JSON.parse(await readFile(new URL('./fixtures/substack.posts.sanitized.json', import.meta.url), 'utf8'));

test('detects and caches newer public GitHub releases', async () => {
  let calls = 0;
  const checker = createUpdateChecker({
    currentVersion: '1.5.2',
    now: () => Date.UTC(2026, 7, 18, 12),
    fetchImpl: async () => {
      calls++;
      return { ok: true, json: async () => ({ tag_name: 'v1.6.0' }) };
    }
  });
  const expected = {
    checked: true,
    checkedAt: '2026-08-18T12:00:00.000Z',
    currentVersion: '1.5.2',
    latestVersion: '1.6.0',
    updateAvailable: true,
    releaseUrl: 'https://github.com/forceworks/RSignal/releases/tag/v1.6.0'
  };
  assert.deepEqual(await checker(), expected);
  assert.deepEqual(await checker(), expected);
  assert.equal(calls, 1);
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(releaseUpdateStatus({ tag_name: 'v1.5.2' }, '1.5.2').updateAvailable, false);
});

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

test('parses real LinkedIn article and video attachment fields', () => {
  const rawPosts = extractLinkedInPosts(linkedinAttachmentsFixture);
  assert.equal(rawPosts.length, 2);

  const articlePost = normalizeLinkedInPost(rawPosts[0], 'Power Platform', 0);
  assert.equal(articlePost.createdAt, new Date(1787212800 * 1000).toISOString());
  assert.deepEqual(articlePost.attachment, {
    type: 'article',
    title: '[sanitized LinkedIn article title]',
    subtitle: '[sanitized article subtitle]',
    description: '',
    url: 'https://www.linkedin.com/pulse/sanitized-linkedin-article-slug',
    image: 'https://media.licdn.com/dms/image/sanitized-article-image'
  });

  const videoPost = normalizeLinkedInPost(rawPosts[1], 'Power Platform', 1);
  assert.equal(videoPost.attachment.type, 'video');
  assert.equal(videoPost.attachment.image, 'https://media.licdn.com/dms/image/sanitized-video-image');
});

test('normalizes the real linkedin.article response without changing post freshness', () => {
  const article = normalizeLinkedInArticle(linkedinArticleFixture);
  assert.equal(article.title, '[sanitized full LinkedIn article title]');
  assert.equal(article.body, '[sanitized first article paragraph]\n\n[sanitized second article paragraph]');
  assert.equal(article.author.followers, 12345);
  assert.equal(article.createdAt, new Date(1787126400 * 1000).toISOString());
  assert.equal(article.updatedAt, new Date(1787212800 * 1000).toISOString());
  assert.equal(article.comments, 4);
  assert.equal(article.reactions, 27);
  assert.equal(canonicalLinkedInArticleUrl(`${article.url}?trackingId=sanitized#section`), article.url);
  assert.equal(canonicalLinkedInArticleUrl('https://www.linkedin.com/posts/not-an-article'), '');
  assert.equal(canonicalLinkedInArticleUrl('https://example.com/pulse/not-linkedin'), '');
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
  assert.equal(sourceQuery('x', topic), '"AI agents" enterprise OR SaaS');
  assert.equal(sourceQuery('x', 'build your own CRM OR vibe coded CRM'), '"build your own CRM" OR "vibe coded CRM"');
  assert.equal(sourceQuery('x', '"Microsoft Copilot" OR "Microsoft Scout" OR OpenClaw'), '"Microsoft Copilot" OR "Microsoft Scout" OR OpenClaw');
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

test('normalizes real X article blocks and identifies link-only wrapper posts', () => {
  const wrapperUrl = 'https://x.com/sanitized_author/status/1905545699552375179';
  const article = normalizeXArticle(twitterArticleFixture, wrapperUrl);
  assert.equal(article.title, '[sanitized X article title]');
  assert.equal(article.description, '[sanitized X article preview]');
  assert.equal(article.image, 'https://pbs.twimg.com/media/sanitized-article-cover.jpg');
  assert.equal(article.author.followers, 12345);
  assert.equal(article.likes, 42);
  assert.match(article.body, /1\. \[sanitized numbered point\]/);
  assert.match(article.body, /• \[sanitized bullet point\]/);
  assert.doesNotMatch(article.body, /sanitized-inline-image/);
  assert.equal(canonicalXPostUrl(`${wrapperUrl}?s=20#fragment`), wrapperUrl);
  assert.equal(canonicalXPostUrl('https://example.com/sanitized_author/status/1905545699552375179'), '');
  assert.equal(isXArticleCandidate({platform:'x',text:'https://t.co/AbC123',url:wrapperUrl}), true);
  assert.equal(isXArticleCandidate({platform:'x',text:'Read this https://t.co/AbC123',url:wrapperUrl}), false);
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

test('identifies X reposts locally without sending exclusion operators', () => {
  assert.equal(isRepostRecord({ isRetweet: true, text: 'fixture' }, 'x'), true);
  assert.equal(isRepostRecord({ referenced_tweets: [{ type: 'retweeted', id: '123' }] }, 'x'), true);
  assert.equal(isRepostRecord({ text: 'RT @fixture_author: fixture' }, 'x'), true);
  assert.equal(isRepostRecord({ retweetCount: 12, text: 'ordinary original post' }, 'x'), false);
  assert.equal(isRepostRecord({ isRepost: true, text: 'fixture' }, 'linkedin'), false);
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
