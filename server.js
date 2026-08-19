import http from 'node:http';
import { readFile, writeFile, appendFile, rename, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexService, safeError as safeCodexError } from './codex-service.js';

const root = fileURLToPath(new URL('.', import.meta.url));
const publicDir = join(root, 'public');
const appVersion = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
function getDataDir() { return process.env.SIGNAL_DATA_DIR || root; }
const port = Number(process.env.PORT || 3000);
const updateCheckMaxAgeMs = 24 * 60 * 60 * 1000;
const latestReleaseApi = 'https://api.github.com/repos/forceworks/RSignal/releases/latest';
let activeApiKey = '';

export function compareVersions(left, right) {
  const parts = value => String(value || '').replace(/^v/i, '').split('.').slice(0, 3).map(part => Number.parseInt(part, 10));
  const a = parts(left), b = parts(right);
  if (a.length !== 3 || b.length !== 3 || [...a, ...b].some(part => !Number.isInteger(part) || part < 0)) return 0;
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  return 0;
}

export function releaseUpdateStatus(release, currentVersion = appVersion, checkedAt = new Date().toISOString()) {
  const tag = String(release?.tag_name || '').trim();
  const match = tag.match(/^v?(\d+\.\d+\.\d+)$/i);
  if (!match) throw new Error('GitHub returned an invalid release version.');
  const latestVersion = match[1];
  return {
    checked: true,
    checkedAt,
    currentVersion,
    latestVersion,
    updateAvailable: compareVersions(currentVersion, latestVersion) < 0,
    releaseUrl: `https://github.com/forceworks/RSignal/releases/tag/${encodeURIComponent(tag)}`
  };
}

export function createUpdateChecker({ fetchImpl = globalThis.fetch, currentVersion = appVersion, now = Date.now, maxAgeMs = updateCheckMaxAgeMs } = {}) {
  let cached = null;
  return async function checkForUpdate() {
    const timestamp = Number(now());
    if (cached && timestamp - cached.timestamp < maxAgeMs) return cached.result;
    try {
      const response = await fetchImpl(latestReleaseApi, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': `RSignals/${currentVersion}`,
          'X-GitHub-Api-Version': '2022-11-28'
        },
        signal: AbortSignal.timeout(8_000)
      });
      if (!response.ok) throw new Error(`GitHub release check failed (${response.status}).`);
      const result = releaseUpdateStatus(await response.json(), currentVersion, new Date(timestamp).toISOString());
      cached = { timestamp, result };
      return result;
    } catch {
      return { checked: false, currentVersion, updateAvailable: false };
    }
  };
}

async function getAnyApiKey() {
  if (process.env.ANYAPI_KEY) {
    activeApiKey = process.env.ANYAPI_KEY.trim();
    return activeApiKey;
  }
  try { activeApiKey = (await readFile(join(getDataDir(), 'anyapi-key.txt'), 'utf8')).trim(); return activeApiKey; }
  catch { activeApiKey = ''; return ''; }
}

function redactString(value, secret = activeApiKey) {
  let result = String(value);
  if (secret) result = result.split(secret).join('[redacted]');
  return result.replace(/Bearer\s+[^\s"',}]+/gi, 'Bearer [redacted]');
}

function sanitize(value, seen = new WeakSet()) {
  if (typeof value === 'string') return redactString(value);
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map(item => sanitize(item, seen));
  const sensitiveKey = key => /^(?:key|api[_-]?key|x-api-key|authorization|auth[_-]?token|access[_-]?token|refresh[_-]?token|token|secret|password|credential|credentials)$/i.test(key);
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, sensitiveKey(key) ? '[redacted]' : sanitize(child, seen)]));
}

function safeErrorMessage(error) {
  return redactString(error?.message || String(error));
}

function diagnosticRequestBody(body,redact=false) {
  return redact&&body&&typeof body==='object'?Object.fromEntries(Object.keys(body).map(field=>[field,'[redacted]'])):body;
}

const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.json':'application/json; charset=utf-8', '.svg':'image/svg+xml' };
function sendJson(res,status,body){ res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(body)); }
function collect(req){ return new Promise((resolve,reject)=>{ let data=''; req.on('data',c=>{ data+=c; if(data.length>1_000_000) reject(new Error('Request too large')); }); req.on('end',()=>resolve(data)); req.on('error',reject); }); }
function aiErrorStatus(error){ if(Number(error?.statusCode))return Number(error.statusCode); const message=String(error?.message||''); return /usage.?limit|rate.?limit/i.test(message)?429:/unavailable|incomplete|not running|stopped/i.test(message)?503:500; }

function pickArray(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  for (const candidate of [value.items,value.data,value.results,value.tweets,value.posts,value.videos,value.elements,value.activities]) {
    if (Array.isArray(candidate)) return candidate;
    if (candidate && typeof candidate === 'object') { const nested=pickArray(candidate); if(nested.length) return nested; }
  }
  for (const child of Object.values(value)) { const nested=pickArray(child); if(nested.length) return nested; }
  return [];
}

function extractLinkedInPosts(payload) {
  const candidates = [
    payload?.output?.data?.posts,
    payload?.output?.posts,
    payload?.data?.posts,
    payload?.posts
  ];
  for (const c of candidates) if (Array.isArray(c)) return c;

  function walk(value, seen = new Set()) {
    if (!value || typeof value !== 'object' || seen.has(value)) return null;
    seen.add(value);
    if (Array.isArray(value.posts)) return value.posts;
    for (const child of Object.values(value)) {
      const found = walk(child, seen);
      if (found) return found;
    }
    return null;
  }
  return walk(payload) || [];
}

function firstValue(...values){ for(const value of values){ if(value!==undefined&&value!==null&&value!=='') return value; } }
function deepFindByKeys(value,keys,seen=new Set()){
  if(!value||typeof value!=='object'||seen.has(value)) return undefined; seen.add(value);
  for(const [key,child] of Object.entries(value)){ if(keys.has(key.toLowerCase())&&child!==undefined&&child!==null&&child!=='') return child; }
  for(const child of Object.values(value)){ const found=deepFindByKeys(child,keys,seen); if(found!==undefined) return found; }
}
function deepFindUrl(value,hostPattern,seen=new Set()){
  if(value===undefined||value===null) return undefined;
  if(typeof value==='string' && hostPattern.test(value)) return value;
  if(typeof value!=='object'||seen.has(value)) return undefined; seen.add(value);
  for(const child of Object.values(value)){ const found=deepFindUrl(child,hostPattern,seen); if(found) return found; }
}
function deepFindXHandle(value,seen=new Set()){
  if(value===undefined||value===null) return undefined;
  if(typeof value==='string'){
    const status=value.match(/(?:https?:\/\/)?(?:www\.)?(?:x\.com|twitter\.com)\/([^/?#]+)\/status\//i); if(status&&status[1]&&status[1].toLowerCase()!=='i') return status[1];
    const profile=value.match(/(?:https?:\/\/)?(?:www\.)?(?:x\.com|twitter\.com)\/([^/?#]+)/i); if(profile&&profile[1]&&!['i','home','search','explore','intent','share'].includes(profile[1].toLowerCase())) return profile[1];
    const at=value.match(/^@([A-Za-z0-9_]{1,15})$/); if(at) return at[1]; return undefined;
  }
  if(typeof value!=='object'||seen.has(value)) return undefined; seen.add(value);
  for(const child of Object.values(value)){ const found=deepFindXHandle(child,seen); if(found) return found; }
}

function sourceQuery(platform, topic) {
  const clean = String(topic || '')
    .replace(/(^|\s)-is:(?:repost|retweet)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (platform !== 'x') {
    return clean
      .replace(/(^|\s)(?:from|to|lang|since|until|filter):\S+/gi, ' ')
      .replace(/(^|\s)-is:repost\b/gi, ' ')
      .replace(/(^|\s)-is:retweet\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  // Keep the first X pass deliberately small: phrases, terms, and OR are supported
  // by the observed provider response. Do not assume the full native X grammar.
  const simplified = clean.replace(/[()]/g, ' ').replace(/\bAND\b/gi, ' ').replace(/\s+/g, ' ').trim();
  const alternatives = simplified.split(/\s+OR\s+/i);
  if (alternatives.length < 2) return simplified;
  return alternatives.map(alternative => {
    const value = alternative.trim();
    if (!value || value.includes('"') || /(?:^|\s)(?:from|to|lang|since|until|filter|is):/i.test(value)) return value;
    return value.split(/\s+/).length > 1 ? `"${value}"` : value;
  }).join(' OR ');
}

function isRepostRecord(raw, platform) {
  if (platform !== 'x' || !raw || typeof raw !== 'object') return false;
  const candidates = [raw, raw.post, raw.tweet, raw.activity].filter(value => value && typeof value === 'object');
  const valueFor = keys => firstValue(...candidates.flatMap(candidate => keys.map(key => candidate[key])));
  const type = String(valueFor(['type', 'postType', 'post_type', 'contentType', 'content_type']) || '').toLowerCase();
  if (['retweet', 'retweeted', 'repost', 'reposted'].includes(type)) return true;
  const flag = valueFor(['isRetweet', 'is_retweet', 'retweeted', 'isRepost', 'is_repost', 'reposted']);
  if (flag === true || String(flag).toLowerCase() === 'true') return true;
  const references = candidates.flatMap(candidate => {
    const value = firstValue(candidate.referenced_tweets, candidate.referencedTweets);
    return Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : [];
  });
  if (references.some(reference => ['retweeted', 'retweet', 'reposted', 'repost'].includes(String(reference?.type || '').toLowerCase()))) return true;
  return /^RT\s+@[A-Za-z0-9_]{1,15}(?::|\s)/i.test(String(valueFor(['text', 'fullText', 'full_text', 'content', 'body']) || '').trim());
}

function isCommentRecord(raw, platform) {
  if (!raw || typeof raw !== 'object') return false;
  const candidates = [raw, raw.post, raw.tweet, raw.activity].filter(value => value && typeof value === 'object');
  const valueFor = keys => firstValue(...candidates.flatMap(candidate => keys.map(key => candidate[key])));
  const type = String(valueFor(['type', 'postType', 'post_type', 'contentType', 'content_type']) || '').toLowerCase();
  if (['comment', 'reply', 'replied_to', 'comment_reply'].includes(type)) return true;
  const flag = valueFor(['isComment', 'is_comment', 'isReply', 'is_reply', 'isCommentaryReply', 'is_commentary_reply']);
  if (flag === true || String(flag).toLowerCase() === 'true') return true;
  if (valueFor(['parentComment', 'parent_comment', 'parentCommentId', 'parent_comment_id', 'parentId', 'parent_id', 'replyTo', 'reply_to', 'replyToId', 'reply_to_id']) != null) return true;

  if (platform === 'x') {
    const references = candidates.flatMap(candidate => {
      const value = firstValue(candidate.referenced_tweets, candidate.referencedTweets);
      return Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : [];
    });
    if (references.some(reference => String(reference?.type || '').toLowerCase() === 'replied_to')) return true;
    if (valueFor(['in_reply_to_status_id', 'in_reply_to_status_id_str', 'inReplyToStatusId', 'in_reply_to_user_id', 'inReplyToUserId']) != null) return true;
  }

  if (platform === 'linkedin') {
    const urn = String(valueFor(['urn', 'activityUrn', 'activity_urn', 'commentUrn', 'comment_urn']) || '');
    const url = String(valueFor(['url', 'postUrl', 'post_url', 'linkedinUrl', 'linkedin_url', 'link']) || '');
    if (/comment/i.test(urn) || /\/comments?\//i.test(url)) return true;
  }
  return false;
}

function parsePostDate(value, { now = Date.now() } = {}) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'object' && !Array.isArray(value)) {
    const nested = firstValue(value.value, value.timestamp, value.time, value.date, value.createdAt, value.created_at, value.publishedAt, value.published_at, value.milliseconds, value.seconds);
    return nested === undefined ? null : parsePostDate(nested, { now });
  }
  if (Array.isArray(value)) return value.length ? parsePostDate(value[0], { now }) : null;
  if (typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(String(value).trim())) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    const absolute = Math.abs(numeric);
    const milliseconds = absolute < 100_000_000_000 ? numeric * 1000
      : absolute < 100_000_000_000_000 ? numeric
      : absolute < 100_000_000_000_000_000 ? numeric / 1000
      : numeric / 1_000_000;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const relative = String(value).trim().match(/^(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w)\s*(?:ago)?$/i);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2].toLowerCase()[0];
    const multiplier = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : unit === 'd' ? 86_400_000 : 604_800_000;
    return new Date(now - amount * multiplier).toISOString();
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
function dateFromXPostId(id){
  try { const digits=String(id||'').match(/^\d{15,22}$/)?.[0]; if(!digits) return null; const ms=Number((BigInt(digits)>>22n)+1288834974657n); const d=new Date(ms); if(Number.isNaN(d.getTime())||ms<1288834974657||ms>Date.now()+86400000) return null; return d.toISOString(); } catch { return null; }
}
function dateFromLinkedInActivityId(id){
  try { const digits=String(id||'').match(/\d{15,22}/)?.[0]; if(!digits) return null; const ms=Number(BigInt(digits)>>22n); const d=new Date(ms); const min=Date.UTC(2003,0,1); if(Number.isNaN(d.getTime())||ms<min||ms>Date.now()+86400000) return null; return d.toISOString(); } catch { return null; }
}

function stableHash(value) {
  let hash = 2166136261;
  for (const char of String(value)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(16);
}

function textValue(value) {
  if (value && typeof value === 'object') return firstValue(value.text, value.textContent, value.content, value.description, '');
  return value;
}

function metricValue(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function optionalMetricValue(...values) {
  const value = firstValue(...values);
  if (value === undefined) return null;
  const text = String(value).trim().replace(/,/g, '');
  const compact = text.match(/^(\d+(?:\.\d+)?)\s*([kmb])?$/i);
  if (!compact) return null;
  const multiplier = { k:1_000, m:1_000_000, b:1_000_000_000 }[String(compact[2] || '').toLowerCase()] || 1;
  const number = Number(compact[1]) * multiplier;
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
}

function normalizeXPost(raw,query,index){
  const legacyUser=raw?.core?.user_results?.result?.legacy||raw?.user_results?.result?.legacy||{};
  const tweet=raw?.tweet||raw?.post||raw;
  const authorObject=firstValue(tweet?.author,tweet?.user,tweet?.userInfo,tweet?.user_info,raw?.author,raw?.user,{});
  const username=firstValue(typeof authorObject==='string'?authorObject:undefined,tweet?.username,tweet?.userName,tweet?.screenName,tweet?.screen_name,tweet?.handle,authorObject?.username,authorObject?.userName,authorObject?.screenName,authorObject?.screen_name,authorObject?.handle,legacyUser?.screen_name,raw?.username,raw?.screen_name,raw?.handle,deepFindByKeys(raw,new Set(['username','user_name','screenname','screen_name','handle','twitterhandle','twitter_handle','xhandle','x_handle'])),deepFindXHandle(raw),'unknown');
  const name=firstValue(tweet?.name,tweet?.authorName,authorObject?.name,authorObject?.fullName,authorObject?.displayName,legacyUser?.name,raw?.name,username);
  const text=textValue(firstValue(tweet?.text,tweet?.fullText,tweet?.full_text,tweet?.content,tweet?.body,tweet?.description,tweet?.legacy?.full_text,raw?.text,raw?.fullText,raw?.full_text,raw?.content,raw?.body,raw?.description,''));
  const suppliedId=firstValue(tweet?.id,tweet?.id_str,tweet?.tweetId,tweet?.tweet_id,tweet?.postId,tweet?.rest_id,raw?.id,raw?.id_str,raw?.tweetId,raw?.tweet_id,raw?.postId,raw?.rest_id);
  const id=String(suppliedId || `content-${stableHash(`${username || ''}|${text || ''}`)}-${index}`);
  let cleanUsername=String(username).replace(/^@/,'');
  const suppliedUrl=firstValue(tweet?.url,tweet?.tweetUrl,tweet?.tweet_url,tweet?.link,raw?.url,raw?.tweetUrl,raw?.tweet_url,raw?.link,deepFindUrl(raw,/(?:x\.com|twitter\.com)\//i));
  if(cleanUsername==='unknown'&&suppliedUrl){ const m=String(suppliedUrl).match(/(?:x\.com|twitter\.com)\/([^/?#]+)\/status\//i); if(m&&m[1]&&m[1]!=='i') cleanUsername=m[1]; }
  if(cleanUsername==='unknown'){ const anywhere=deepFindXHandle(raw); if(anywhere) cleanUsername=anywhere; }
  const url=suppliedUrl||(cleanUsername!=='unknown'?`https://x.com/${cleanUsername}/status/${id}`:`https://x.com/i/web/status/${id}`);
  const created=firstValue(tweet?.createdAt,tweet?.created_at,tweet?.createdUtc,tweet?.createdUTC,tweet?.date,tweet?.timestamp,tweet?.publishedAt,tweet?.published_at,tweet?.legacy?.created_at,raw?.createdAt,raw?.created_at,raw?.createdUtc,raw?.createdUTC,raw?.date,raw?.timestamp,raw?.publishedAt,raw?.published_at,deepFindByKeys(raw,new Set(['createdat','created_at','createdutc','created_utc','timestamp','publishedat','published_at','tweetcreatedat','tweet_created_at'])));
  const metrics=tweet?.metrics||tweet?.public_metrics||raw?.metrics||raw?.public_metrics||{}; const legacy=tweet?.legacy||raw?.legacy||{};
  const followers=optionalMetricValue(tweet?.followers,tweet?.followerCount,tweet?.followersCount,tweet?.followers_count,authorObject?.followers,authorObject?.followerCount,authorObject?.followersCount,authorObject?.followers_count,legacyUser?.followers_count,raw?.followers,raw?.followerCount,raw?.followersCount,raw?.followers_count);
  return { platform:'x', id, query, author:{name:String(name),username:cleanUsername,profileUrl:cleanUsername!=='unknown'?`https://x.com/${cleanUsername}`:'',verified:Boolean(firstValue(tweet?.verified,authorObject?.verified,authorObject?.isVerified,legacyUser?.verified,raw?.verified,false)),followers}, text:String(text), url:String(url), createdAt:parsePostDate(created)||dateFromXPostId(id), replies:metricValue(firstValue(tweet?.replies,tweet?.replyCount,tweet?.reply_count,metrics.reply_count,legacy.reply_count,raw?.replies,raw?.replyCount,0)), likes:metricValue(firstValue(tweet?.likes,tweet?.likeCount,tweet?.like_count,metrics.like_count,legacy.favorite_count,raw?.likes,raw?.likeCount,0)), reposts:metricValue(firstValue(tweet?.reposts,tweet?.retweets,tweet?.retweetCount,tweet?.retweet_count,metrics.retweet_count,legacy.retweet_count,raw?.reposts,raw?.retweets,0)), views:metricValue(firstValue(tweet?.views,tweet?.viewCount,tweet?.view_count,metrics.impression_count,raw?.views,raw?.viewCount,0)) };
}

function normalizeLinkedInPost(raw,query,index){
  const post=raw?.post||raw?.activity||raw;
  const author=firstValue(post?.author,post?.actor,post?.user,raw?.author,raw?.actor,{});
  const name=firstValue(post?.authorName,post?.author_name,author?.name,author?.fullName,author?.full_name,author?.displayName,raw?.authorName,raw?.author_name,raw?.name,deepFindByKeys(raw,new Set(['authorname','author_name','fullname','full_name','displayname','display_name'])),'Unknown');
  let username=String(firstValue(author?.publicIdentifier,author?.public_identifier,author?.username,post?.publicIdentifier,raw?.publicIdentifier,raw?.username,'unknown')).replace(/^@/,'');
  const text=textValue(firstValue(post?.text,post?.commentary,post?.content,post?.body,post?.description,post?.title,raw?.text,raw?.commentary,raw?.content,raw?.body,raw?.description,''));
  const urn=String(firstValue(post?.urn,post?.activityUrn,post?.activity_urn,raw?.urn,raw?.activityUrn,raw?.activity_urn,''));
  const suppliedId=firstValue(post?.activityId,post?.activity_id,post?.postId,post?.post_id,post?.id,raw?.activityId,raw?.activity_id,raw?.postId,raw?.post_id,raw?.id,urn.match(/activity:(\d+)/)?.[1]);
  const id=String(suppliedId || `content-${stableHash(`${username || ''}|${text || ''}`)}-${index}`);
  const profileUrl=String(firstValue(author?.profileUrl,author?.profile_url,author?.url,post?.authorProfileUrl,post?.author_profile_url,raw?.authorProfileUrl,raw?.author_profile_url,''));
  const suppliedUrl=firstValue(post?.url,post?.postUrl,post?.post_url,post?.linkedinUrl,post?.linkedin_url,post?.link,raw?.url,raw?.postUrl,raw?.post_url,raw?.linkedinUrl,raw?.linkedin_url,raw?.link,deepFindUrl(raw,/linkedin\.com\//i));
  if(username==='unknown'&&suppliedUrl){ const m=String(suppliedUrl).match(/linkedin\.com\/in\/([^/?#]+)/i); if(m?.[1]) username=m[1]; }
  const url=suppliedUrl||(id.match(/^\d+$/)?`https://www.linkedin.com/feed/update/urn:li:activity:${id}/`:'https://www.linkedin.com/feed/');
  const created=firstValue(post?.publishedAt,post?.published_at,post?.publishedTime,post?.published_time,post?.createdUtc,post?.createdUTC,post?.createdAt,post?.created_at,post?.postedAt,post?.posted_at,post?.date,post?.timestamp,post?.time,raw?.publishedAt,raw?.published_at,raw?.publishedTime,raw?.published_time,raw?.createdUtc,raw?.createdUTC,raw?.createdAt,raw?.created_at,raw?.postedAt,raw?.posted_at,raw?.date,raw?.timestamp,deepFindByKeys(raw,new Set(['publishedat','published_at','publishedtime','published_time','createdutc','created_utc','createdat','created_at','postedat','posted_at','timestamp'])));
  const metrics=post?.metrics||post?.engagement||raw?.metrics||raw?.engagement||{};
  const followers=optionalMetricValue(author?.followers,author?.followerCount,author?.followersCount,author?.follower_count,post?.followers,post?.followerCount,raw?.followers,raw?.followerCount);
  return { platform:'linkedin', id, query, author:{name:String(name),username,profileUrl:profileUrl||(username!=='unknown'?`https://www.linkedin.com/in/${username}`:''),verified:Boolean(firstValue(author?.verified,author?.isVerified,raw?.verified,false)),followers}, text:String(text), url:String(url), createdAt:parsePostDate(created), replies:metricValue(firstValue(post?.comments,post?.commentCount,post?.comment_count,post?.replies,metrics.comments,metrics.commentCount,raw?.comments,raw?.commentCount,0)), likes:metricValue(firstValue(post?.likes,post?.likeCount,post?.like_count,post?.reactions,post?.reactionCount,post?.reaction_count,metrics.likes,metrics.reactions,raw?.likes,raw?.reactions,0)), reposts:metricValue(firstValue(post?.reposts,post?.repostCount,post?.repost_count,post?.shares,post?.shareCount,metrics.reposts,metrics.shares,raw?.reposts,raw?.shares,0)), views:metricValue(firstValue(post?.views,post?.viewCount,post?.impressions,post?.impressionCount,metrics.views,metrics.impressions,raw?.views,raw?.impressions,0)) };
}

function normalizeRedditPost(raw,query,index){
  const author=String(firstValue(raw?.author,raw?.username,'unknown')).replace(/^u\//,'');
  const title=String(firstValue(raw?.title,raw?.text,raw?.body,raw?.selftext,''));
  const permalink=String(firstValue(raw?.permalink,''));
  const url=permalink?`https://www.reddit.com${permalink.startsWith('/')?permalink:`/${permalink}`}`:String(firstValue(raw?.url,'https://www.reddit.com/'));
  const id=String(firstValue(raw?.id,`content-${stableHash(`${author}|${title}`)}-${index}`));
  return {platform:'reddit',id,query,author:{name:author==='unknown'?'Reddit user':`u/${author}`,username:author,verified:false},text:title,url,createdAt:parsePostDate(firstValue(raw?.createdUtc,raw?.createdAt,raw?.created_at,raw?.publishedAt,raw?.timestamp)),replies:metricValue(firstValue(raw?.numComments,raw?.commentCount,raw?.comments)),likes:metricValue(firstValue(raw?.score,raw?.ups,raw?.likes)),reposts:0,views:metricValue(firstValue(raw?.views,0)),subreddit:String(firstValue(raw?.subreddit,''))};
}

function normalizeYouTubeVideo(raw,query,index){
  const channel=String(firstValue(raw?.channel,raw?.channelName,raw?.author,'YouTube'));
  const title=String(firstValue(raw?.title,raw?.text,raw?.description,''));
  const id=String(firstValue(raw?.id,`content-${stableHash(`${channel}|${title}`)}-${index}`));
  return {platform:'youtube',id,query,author:{name:channel,username:channel,verified:false},text:title,url:String(firstValue(raw?.url,raw?.link,id?`https://www.youtube.com/watch?v=${id}`:'https://www.youtube.com/')),createdAt:parsePostDate(firstValue(raw?.publishedTime,raw?.publishedAt,raw?.published_at,raw?.createdUtc,raw?.createdAt,raw?.timestamp)),replies:metricValue(firstValue(raw?.comments,raw?.commentCount)),likes:metricValue(firstValue(raw?.likes,raw?.likeCount)),reposts:0,views:metricValue(firstValue(raw?.views,raw?.viewCount))};
}

function normalizeTikTokVideo(raw,query,index){
  const username=String(firstValue(raw?.authorHandle,raw?.author,raw?.username,'unknown')).replace(/^@/,'');
  const text=String(firstValue(raw?.text,raw?.caption,raw?.title,''));
  const id=String(firstValue(raw?.id,`content-${stableHash(`${username}|${text}`)}-${index}`));
  return {platform:'tiktok',id,query,author:{name:username==='unknown'?'TikTok creator':`@${username}`,username,verified:false},text,url:String(firstValue(raw?.url,raw?.link,'https://www.tiktok.com/')),createdAt:parsePostDate(firstValue(raw?.createdUtc,raw?.createdAt,raw?.created_at,raw?.publishedAt,raw?.timestamp)),replies:metricValue(firstValue(raw?.commentCount,raw?.comments)),likes:metricValue(firstValue(raw?.likeCount,raw?.likes)),reposts:metricValue(firstValue(raw?.shareCount,raw?.shares)),views:metricValue(firstValue(raw?.playCount,raw?.views))};
}

function normalizeSubstackPost(raw,query,index){
  const authorName=String(firstValue(raw?.authorName,raw?.author,'Substack author'));
  const title=String(firstValue(raw?.title,raw?.text,''));
  const subtitle=String(firstValue(raw?.subtitle,''));
  const text=subtitle&&subtitle!==title?`${title} — ${subtitle}`:title;
  const id=String(firstValue(raw?.postId,raw?.id,`content-${stableHash(`${authorName}|${text}`)}-${index}`));
  return {platform:'substack',id,query,author:{name:authorName,username:String(firstValue(raw?.authorHandle,authorName)).replace(/^@/,''),verified:false},text,url:String(firstValue(raw?.url,'https://substack.com/')),createdAt:parsePostDate(firstValue(raw?.createdUtc,raw?.publishedAt,raw?.published_at,raw?.createdAt,raw?.timestamp)),replies:metricValue(firstValue(raw?.commentCount,raw?.comments)),likes:metricValue(firstValue(raw?.reactionCount,raw?.reactions,raw?.likes)),reposts:metricValue(firstValue(raw?.restackCount,raw?.restacks)),views:0};
}

const sourceLabels={x:'X',linkedin:'LinkedIn',reddit:'Reddit',youtube:'YouTube',tiktok:'TikTok',substack:'Substack'};
function sourceLabel(platform){ return sourceLabels[platform]||platform; }
function sourceSku(platform){
  return {
    x:process.env.ANYAPI_TWITTER_SEARCH_SKU||'twitter.search',
    linkedin:process.env.ANYAPI_LINKEDIN_SEARCH_SKU||'linkedin.search_posts_full',
    reddit:process.env.ANYAPI_REDDIT_SEARCH_SKU||'reddit.search',
    youtube:process.env.ANYAPI_YOUTUBE_SEARCH_SKU||'youtube.search',
    tiktok:process.env.ANYAPI_TIKTOK_SEARCH_SKU||'tiktok.hashtag_videos',
    substack:process.env.ANYAPI_SUBSTACK_SEARCH_SKU||'substack.posts'
  }[platform];
}
function sourceRequest(platform,query,limit,maxAgeHours=168){
  if(platform==='x') return {query,limit,queryType:'Latest',requireSinglePage:false};
  if(platform==='linkedin') return {query,datePosted:maxAgeHours<=24?'last-day':'last-week',sort:'date',limit:Math.min(limit,10)};
  if(platform==='reddit') return {query,sort:'new',timeframe:'week'};
  if(platform==='youtube') return {query,uploadDate:'this_week'};
  if(platform==='tiktok') return {hashtag:String(query).replace(/^#/,'').trim(),limit:Math.min(limit,20)};
  if(platform==='substack') return {url:query,limit:Math.min(limit,100),includeContent:false};
  return {query};
}
function extractSourceItems(platform,payload){
  if(platform==='linkedin') return extractLinkedInPosts(payload);
  return pickArray(payload?.output);
}
function sourceNormalizer(platform){
  return {x:normalizeXPost,linkedin:normalizeLinkedInPost,reddit:normalizeRedditPost,youtube:normalizeYouTubeVideo,tiktok:normalizeTikTokVideo,substack:normalizeSubstackPost}[platform];
}

function normalizedUrl(value) {
  try {
    const parsed = new URL(String(value));
    parsed.protocol = 'https:';
    parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
    parsed.search = '';
    parsed.hash = '';
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.toString();
  } catch { return ''; }
}

function postKey(post){
  const platform=String(post.platform||'x').toLowerCase();
  const url=String(post.url||'');
  const x=url.match(/(?:x\.com|twitter\.com)\/[^/]+\/status\/(\d+)/i)?.[1];
  const li=url.match(/activity[:-](\d+)/i)?.[1];
  const id=String(post.id||'');
  const stableId=x||li||(id&&!/^content-/.test(id)?id:'');
  if(stableId) return `${platform}:${stableId}`;
  const canonical=normalizedUrl(url);
  if(canonical) return `${platform}:url:${canonical}`;
  return `${platform}:content:${stableHash(`${post.author?.username||post.author?.name||''}|${post.createdAt||''}|${post.text||''}`)}`;
}
async function readSeenPosts(){ try{ const p=JSON.parse(await readFile(join(getDataDir(),'seen-posts.json'),'utf8')); return p&&typeof p==='object'?p:{}; }catch{return{};} }
async function writeSeenPosts(seen){ const cutoff=Date.now()-90*24*60*60*1000; const trimmed=Object.fromEntries(Object.entries(seen).filter(([,when])=>Number.isFinite(Number(when))&&Number(when)>=cutoff)); const target=join(getDataDir(),'seen-posts.json'); const temporary=`${target}.tmp`; await writeFile(temporary,JSON.stringify(trimmed,null,2),'utf8'); await rename(temporary,target); }

const followerCacheMaxAgeMs=24*60*60*1000;
function canonicalLinkedInProfileUrl(value){
  try{
    const parsed=new URL(String(value));
    const hostname=parsed.hostname.toLowerCase().replace(/^www\./,'');
    if(hostname!=='linkedin.com'||!/^\/in\/[^/?#]+\/?$/i.test(parsed.pathname)) return '';
    return `https://www.linkedin.com${parsed.pathname.replace(/\/+$/,'')}`;
  }catch{return '';}
}
function followerLookupRequest(author){
  const platform=String(author?.platform||'').toLowerCase();
  const username=String(author?.username||'').replace(/^@/,'').trim();
  if(platform==='x'&&username.toLowerCase()!=='unknown'&&/^[A-Za-z0-9_]{1,15}$/.test(username)) return {platform,username,profileUrl:`https://x.com/${username}`,cacheKey:`x:${username.toLowerCase()}`,sku:'twitter.profile',body:{handle:username}};
  if(platform==='linkedin'){
    const fallback=username.toLowerCase()!=='unknown'&&/^[A-Za-z0-9_-]{2,100}$/.test(username)?`https://www.linkedin.com/in/${username}`:'';
    const profileUrl=canonicalLinkedInProfileUrl(author?.profileUrl)||canonicalLinkedInProfileUrl(fallback);
    if(profileUrl) return {platform,username,profileUrl,cacheKey:`linkedin:${profileUrl.toLowerCase()}`,sku:'linkedin.profile',body:{url:profileUrl}};
  }
  return null;
}
function extractFollowerCount(payload,platform){
  const data=firstValue(payload?.output?.data,payload?.data,payload?.output,{});
  return platform==='linkedin'
    ? optionalMetricValue(data?.followerCount,data?.followersCount,data?.followers,data?.follower_count)
    : optionalMetricValue(data?.followers,data?.followerCount,data?.followersCount,data?.followers_count);
}
async function readFollowerCache(){ try{ const value=JSON.parse(await readFile(join(getDataDir(),'follower-cache.json'),'utf8')); return value&&typeof value==='object'?value:{}; }catch{return{};} }
async function writeFollowerCache(cache){
  const cutoff=Date.now()-30*24*60*60*1000;
  const trimmed=Object.fromEntries(Object.entries(cache).filter(([,entry])=>Number(entry?.fetchedAt)>=cutoff));
  const target=join(getDataDir(),'follower-cache.json'); const temporary=`${target}.tmp`;
  await writeFile(temporary,JSON.stringify(trimmed,null,2),'utf8'); await rename(temporary,target);
}
async function enrichFollowerProfiles(authors,key){
  const now=Date.now(),cache=await readFollowerCache(),profiles=[],pending=[],seen=new Set();
  for(const author of authors){
    const lookup=followerLookupRequest(author);
    if(!lookup||seen.has(lookup.cacheKey)) continue;
    seen.add(lookup.cacheKey);
    const embedded=optionalMetricValue(author?.followers);
    if(embedded!==null){ cache[lookup.cacheKey]={followers:embedded,fetchedAt:now}; profiles.push({...lookup,followers:embedded,cached:true}); continue; }
    const cached=cache[lookup.cacheKey];
    if(cached&&now-Number(cached.fetchedAt)<followerCacheMaxAgeMs){ const followers=optionalMetricValue(cached.followers); if(followers!==null) profiles.push({...lookup,followers,cached:true}); continue; }
    pending.push(lookup);
  }
  let cursor=0,costUsd=0,failures=0;
  const worker=async()=>{ while(cursor<pending.length){
    const lookup=pending[cursor++];
    try{
      const {payload}=await callAnyApi(lookup.sku,key,[lookup.body],{platform:lookup.platform,operation:'follower_lookup',redactBody:true});
      const followers=extractFollowerCount(payload,lookup.platform);
      cache[lookup.cacheKey]={followers,fetchedAt:Date.now()}; costUsd+=Number(payload.costUsd||0);
      if(followers!==null) profiles.push({...lookup,followers,cached:false});
    }catch(error){ failures++; await logDiagnostic('followers.failed',{platform:lookup.platform,message:safeErrorMessage(error)}); }
  }};
  await Promise.all(Array.from({length:Math.min(4,pending.length)},worker));
  if(pending.length||profiles.some(profile=>profile.cached&&cache[profile.cacheKey]?.fetchedAt===now)) try{await writeFollowerCache(cache);}catch{}
  return {profiles:profiles.map(({body,sku,cacheKey,...profile})=>profile),costUsd,lookups:pending.length,failures};
}

async function logDiagnostic(event, data={}) {
  try {
    const safe = sanitize(data);
    const line = JSON.stringify({at:new Date().toISOString(),event,...safe})+'\n';
    await appendFile(join(getDataDir(),'signal-debug.log'), line, 'utf8');
  } catch {}
}

function dateRange(posts){
  const times=posts.map(p=>p.createdAt?new Date(p.createdAt).getTime():NaN).filter(Number.isFinite).sort((a,b)=>a-b);
  return {dated:times.length,missing:posts.length-times.length,oldest:times.length?new Date(times[0]).toISOString():null,newest:times.length?new Date(times[times.length-1]).toISOString():null};
}

async function callAnyApi(sku,key,bodies,context={}){
  let lastPayload={}; let lastStatus=0; let attempt=0;
  for(const body of bodies){
    attempt++;
    const started=Date.now();
    const {redactBody=false,...logContext}=context;
    const diagnosticBody=diagnosticRequestBody(body,redactBody);
    await logDiagnostic('anyapi.request',{...logContext,sku,attempt,body:diagnosticBody});
    let response;
    try {
      response=await fetch(`https://api.getanyapi.com/v1/run/${encodeURIComponent(sku)}`,{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
    } catch (error) {
      await logDiagnostic('anyapi.network_error',{...logContext,sku,attempt,message:safeErrorMessage(error)});
      throw error;
    }
    const text=await response.text();
    let payload={}; try{payload=text?JSON.parse(text):{};}catch{payload={raw:text.slice(0,2000)};}
    lastPayload=payload; lastStatus=response.status;
    await logDiagnostic('anyapi.response',{...logContext,sku,attempt,status:response.status,ok:response.ok,durationMs:Date.now()-started,costUsd:Number(payload.costUsd||0),items:Number(payload.items||0),topLevelKeys:Object.keys(payload||{}),outputKeys:payload?.output&&typeof payload.output==='object'?Object.keys(payload.output):[]});
    if(response.ok) return {payload,response,status:response.status,requestBody:body,durationMs:Date.now()-started};
    if(![400,404,422].includes(response.status)) break;
  }
  const message=safeErrorMessage({message:lastPayload.error||lastPayload.message||`AnyAPI ${sku} request failed (${lastStatus})`});
  const {redactBody:_,...logContext}=context;
  await logDiagnostic('anyapi.failed',{...logContext,sku,status:lastStatus,message});
  const error=new Error(message); error.status=lastStatus; error.payload=lastPayload; throw error;
}

async function saveAnyApiResponse(platform, payload) {
  const safePayload = sanitize(payload);
  try { await writeFile(join(getDataDir(),`anyapi-last-response-${platform}.json`),JSON.stringify(safePayload,null,2),'utf8'); } catch {}
  if (!['1','true','yes'].includes(String(process.env.SIGNAL_DIAGNOSTIC_MODE || '').toLowerCase())) return;
  try {
    const fixtureDir = join(getDataDir(), 'diagnostic-fixtures');
    await mkdir(fixtureDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await writeFile(join(fixtureDir, `${stamp}-${platform}.json`), JSON.stringify(safePayload, null, 2), 'utf8');
  } catch {}
}

async function runSearch(platform, topic, limit, maxAgeHours){
  const key=await getAnyApiKey();
  const query=sourceQuery(platform, topic);
  if(!key){
    const posts=demoPosts(platform,topic,limit);
    return {demo:true,posts,costUsd:0,platform,debug:{platform,query:topic,sourceQuery:query,demo:true,sku:'demo',requestBody:null,httpStatus:200,returned:posts.length,...dateRange(posts)}};
  }
  const sku=sourceSku(platform);
  const bodies=[sourceRequest(platform,query,limit,maxAgeHours)];
  const {payload,status,requestBody,durationMs}=await callAnyApi(sku,key,bodies,{platform,query:topic,sourceQuery:query});
  await saveAnyApiResponse(platform, payload);
  const normalizer=sourceNormalizer(platform);
  const sourceItems=extractSourceItems(platform,payload);
  const nonComments=sourceItems.filter(item=>!isCommentRecord(item,platform));
  const commentFiltered=sourceItems.length-nonComments.length;
  const nonReposts=nonComments.filter(item=>!isRepostRecord(item,platform));
  const repostFiltered=nonComments.length-nonReposts.length;
  const normalizedPosts=nonReposts.map((item,i)=>normalizer(item,topic,i));
  const posts=normalizedPosts;
  const range=dateRange(posts);
  const firstRaw=sourceItems[0]&&typeof sourceItems[0]==='object'?Object.keys(sourceItems[0]).slice(0,30):[];
  const debug={platform,query:topic,sourceQuery:query,sku,requestBody,httpStatus:status,durationMs,provider:payload.provider||'AnyAPI',costUsd:Number(payload.costUsd||0),reportedItems:Number(payload.items||0),returned:posts.length,commentFiltered,repostFiltered,rawFirstItemKeys:firstRaw,...range};
  await logDiagnostic('search.normalized',debug);
  return {demo:false,posts,costUsd:Number(payload.costUsd||0),provider:payload.provider||'AnyAPI',items:Number(payload.items||0),platform,debug};
}

function demoPosts(platform,query,limit=12){
  const now=Date.now();
  const templates=[['Maya Chen','mayac_builds','The hidden cost of workflow automation is not the first two months. It is the next five years of ownership.',8,34,6,4100],['Jordan Hale','jhalesoftware','Enterprise software teams: are customers asking for more assistants, or are they asking for fewer screens and less work?',5,28,4,2600],['Priya Raman','priyaram_ai','AI systems are exposing a strange truth: most enterprise workflows exist because the software never understood the work.',12,47,9,6300],['Daniel Frost','dfrostcloud','Model routing looks boring until you realize it may become the economic control plane for every enterprise workflow.',3,19,5,1700]];
  return templates.slice(0,limit).map((t,i)=>{const id=`demo-${platform}-${i}`;const urls={x:`https://x.com/${t[1]}/status/${id}`,linkedin:`https://www.linkedin.com/feed/update/urn:li:activity:700000000000000000${i}/`,reddit:`https://www.reddit.com/r/technology/comments/${id}/`,youtube:`https://www.youtube.com/watch?v=${id}`,tiktok:`https://www.tiktok.com/@${t[1]}/video/${id}`,substack:`https://signal-demo.substack.com/p/${id}`};return {platform,id,query,author:{name:t[0],username:t[1],verified:i%3===0,followers:[18400,7200,31500,4900][i]},text:t[2],url:urls[platform]||urls.x,createdAt:new Date(now-[11,19,27,43][i]*60000).toISOString(),replies:t[3],likes:t[4],reposts:t[5],views:t[6]};});
}

export function createSignalServer(options={}){ const aiService=options.aiService||new CodexService({dataDir:getDataDir(),version:appVersion}); const updateChecker=options.updateChecker||createUpdateChecker(); const server=http.createServer(async(req,res)=>{ try{
  const url=new URL(req.url,`http://${req.headers.host}`);
  if(req.method==='GET'&&url.pathname==='/api/update') return sendJson(res,200,await updateChecker());
  if(req.method==='GET'&&url.pathname==='/api/ai/status') return sendJson(res,200,await aiService.status());
  if(req.method==='POST'&&url.pathname==='/api/ai/login/chatgpt'){
    try{return sendJson(res,200,await aiService.loginChatGPT());}catch(error){return sendJson(res,aiErrorStatus(error),{error:safeCodexError(error)});}
  }
  if(req.method==='POST'&&url.pathname==='/api/ai/login/key'){
    try{const body=JSON.parse((await collect(req))||'{}');return sendJson(res,200,await aiService.loginApiKey(body.apiKey||body.key));}catch(error){return sendJson(res,aiErrorStatus(error),{error:safeCodexError(error)});}
  }
  if(req.method==='POST'&&url.pathname==='/api/ai/logout'){
    try{return sendJson(res,200,await aiService.logout());}catch(error){return sendJson(res,aiErrorStatus(error),{error:safeCodexError(error)});}
  }
  if(req.method==='POST'&&url.pathname==='/api/ai/analyze'){
    try{const body=JSON.parse((await collect(req))||'{}');return sendJson(res,200,await aiService.analyze(body.post,body.profile,body.instructions));}catch(error){return sendJson(res,aiErrorStatus(error),{error:safeCodexError(error)});}
  }
  if(req.method==='POST'&&url.pathname==='/api/ai/screen'){
    try{const body=JSON.parse((await collect(req))||'{}');return sendJson(res,200,await aiService.screen(body.posts,body.instructions,body.profile));}catch(error){return sendJson(res,aiErrorStatus(error),{error:safeCodexError(error)});}
  }
  if(req.method==='POST'&&url.pathname==='/api/search'){
    const body=JSON.parse((await collect(req))||'{}');
    const supportedPlatforms=['x','linkedin','reddit','youtube','tiktok','substack'];
    const platforms=Array.isArray(body.platforms)?[...new Set(body.platforms.filter(p=>supportedPlatforms.includes(p)))]:['x'];
    const queriesByPlatform=body.queriesByPlatform&&typeof body.queriesByPlatform==='object'?Object.fromEntries(supportedPlatforms.map(platform=>[platform,Array.isArray(body.queriesByPlatform[platform])?body.queriesByPlatform[platform].map(q=>String(q).trim()).filter(Boolean).slice(0,12):[]])):{};
    const limit=Math.min(Math.max(Number(body.limit||12),1),50); const maxAgeHours=Math.min(Math.max(Number(body.maxAgeHours||3),.25),168);
    if(!platforms.length) return sendJson(res,400,{error:'Select at least one source.'});
    const missingPlatform=platforms.find(platform=>!queriesByPlatform[platform]?.length);
    if(missingPlatform) return sendJson(res,400,{error:`Add at least one ${sourceLabel(missingPlatform)} watchlist entry.`});
    const jobs=[]; for(const platform of platforms) for(const q of queriesByPlatform[platform]) jobs.push({platform,query:q,promise:runSearch(platform,q,limit,maxAgeHours)});
    const settled=await Promise.allSettled(jobs.map(j=>j.promise));
    const failures=settled.map((r,i)=>r.status==='rejected'?`${sourceLabel(jobs[i].platform)} (${jobs[i].query}): ${r.reason?.message||String(r.reason)}`:null).filter(Boolean);
    const results=settled.filter(r=>r.status==='fulfilled').map(r=>r.value);
    const diagnostics=settled.map((r,i)=>r.status==='fulfilled'?{...r.value.debug}:{platform:jobs[i].platform,query:jobs[i].query,error:r.reason?.message||String(r.reason),httpStatus:r.reason?.status||null});
    if(!results.length) return sendJson(res,502,{error:failures[0]||'All searches failed.'});
    const history=await readSeenPosts(); const dedupe=new Set(); const now=Date.now();
    let duplicates=0;
    const all=[];
    for (const post of results.flatMap(r=>r.posts)) {
      const key=postKey(post);
      if (!post.text || !key) continue;
      if (dedupe.has(key)) { duplicates++; continue; }
      dedupe.add(key); all.push(post);
    }
    let missingDate=0,tooOld=0,alreadySeen=0; const posts=[];
    const rejectionByJob={};
    const bump=(post,kind)=>{const k=`${post.platform}|||${post.query}`; rejectionByJob[k]??={missingDate:0,tooOld:0,alreadySeen:0,duplicates:0,new:0}; rejectionByJob[k][kind]++;};
    for(const post of all){ const key=postKey(post); const legacyKey=key.startsWith('x:')?key.slice(2):null; const postedAt=post.createdAt?new Date(post.createdAt).getTime():NaN; if(!Number.isFinite(postedAt)){missingDate++;bump(post,'missingDate');continue;} const ageHours=Math.max(0,(now-postedAt)/3_600_000); if(ageHours>maxAgeHours){tooOld++;bump(post,'tooOld');continue;} if(history[key]||(legacyKey&&history[legacyKey])){alreadySeen++;bump(post,'alreadySeen');continue;} posts.push(post); bump(post,'new'); history[key]=now; }
    for(const d of diagnostics){ const k=`${d.platform}|||${d.query}`; Object.assign(d,rejectionByJob[k]||{missingDate:0,tooOld:0,alreadySeen:0,duplicates:0,new:0}); }
    await writeSeenPosts(history); posts.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
    const byPlatform={}; for(const p of platforms) byPlatform[p]={fetched:all.filter(x=>x.platform===p).length,new:posts.filter(x=>x.platform===p).length,costUsd:results.filter(r=>r.platform===p).reduce((s,r)=>s+r.costUsd,0)};
    const responseBody={demo:results.every(r=>r.demo),posts,costUsd:results.reduce((s,r)=>s+r.costUsd,0),stats:{fetched:all.length,duplicates,alreadySeen,tooOld,missingDate,maxAgeHours,byPlatform,failures,diagnostics}};
    await logDiagnostic('scan.complete',{maxAgeHours,totalFetched:all.length,new:posts.length,duplicates,alreadySeen,tooOld,missingDate,failures,diagnostics});
    return sendJson(res,200,responseBody);
  }
  if(req.method==='POST'&&url.pathname==='/api/followers'){
    const body=JSON.parse((await collect(req))||'{}');
    const authors=Array.isArray(body.authors)?body.authors.slice(0,100).filter(author=>author&&['x','linkedin'].includes(String(author.platform).toLowerCase())):[];
    if(!authors.length) return sendJson(res,200,{profiles:[],costUsd:0,lookups:0,failures:0});
    const key=await getAnyApiKey();
    if(!key) return sendJson(res,200,{profiles:[],costUsd:0,lookups:0,failures:0});
    return sendJson(res,200,await enrichFollowerProfiles(authors,key));
  }
  if(req.method==='POST'&&url.pathname==='/api/key'){ const body=JSON.parse((await collect(req))||'{}'); const key=String(body.key||'').trim().replace(/^Bearer\s+/i,''); if(!key) return sendJson(res,400,{error:'Enter an AnyAPI key.'}); await writeFile(join(getDataDir(),'anyapi-key.txt'),key+'\n','utf8'); return sendJson(res,200,{configured:true}); }
  if(req.method==='DELETE'&&url.pathname==='/api/key'){ await writeFile(join(getDataDir(),'anyapi-key.txt'),'','utf8'); return sendJson(res,200,{configured:false}); }
  if(req.method==='GET'&&url.pathname==='/api/status'){ return sendJson(res,200,{configured:Boolean(await getAnyApiKey()),version:appVersion,skus:Object.fromEntries(['x','linkedin','reddit','youtube','tiktok','substack'].map(platform=>[platform,sourceSku(platform)]))}); }
  if(req.method==='GET'&&url.pathname==='/api/log'){ try{ const text=await readFile(join(getDataDir(),'signal-debug.log'),'utf8'); return sendJson(res,200,{log:text.split('\n').filter(Boolean).slice(-300).join('\n')}); }catch{return sendJson(res,200,{log:''});} }
  const requested=url.pathname==='/'?'/index.html':url.pathname; const safe=normalize(requested).replace(/^(\.\.(\/|\\|$))+/,''); const path=join(publicDir,safe); if(!path.startsWith(publicDir)) return sendJson(res,403,{error:'Forbidden'}); const file=await readFile(path); res.writeHead(200,{'Content-Type':mime[extname(path)]||'application/octet-stream'}); res.end(file);
}catch(error){ if(error.code==='ENOENT') return sendJson(res,404,{error:'Not found'}); sendJson(res,500,{error:error.message||'Unexpected error'}); }}); server.on('close',()=>{void aiService.stop?.();}); return server; }
export async function startSignalServer(options={}){ const listenPort=Number(options.port||port); const server=createSignalServer(options); await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(listenPort,'127.0.0.1',resolve);}); return server; }
export { diagnosticRequestBody, extractFollowerCount, extractLinkedInPosts, followerLookupRequest, isCommentRecord, isRepostRecord, normalizeLinkedInPost, normalizeRedditPost, normalizeSubstackPost, normalizeTikTokVideo, normalizeXPost, normalizeYouTubeVideo, parsePostDate, postKey, sourceQuery, sourceRequest };
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){ startSignalServer().then(()=>console.log(`RSignals running at http://127.0.0.1:${port}`)).catch(e=>{console.error(e);process.exitCode=1;}); }
