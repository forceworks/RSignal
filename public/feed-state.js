function platformName(value) {
  return String(value || 'unknown').trim().toLowerCase() || 'unknown';
}

function urlPostId(platform, value) {
  const source = String(value || '');
  if (!source) return '';
  if (platform === 'x') return source.match(/(?:x\.com|twitter\.com)\/(?:[^/?#]+|i\/web)\/status\/(\d+)/i)?.[1] || '';
  if (platform === 'linkedin') return source.match(/activity[:-](\d+)/i)?.[1] || '';
  if (platform === 'reddit') return source.match(/\/comments\/([A-Za-z0-9]+)/i)?.[1] || '';
  if (platform === 'youtube') {
    try { const parsed = new URL(source); return parsed.hostname.toLowerCase().replace(/^www\./, '') === 'youtu.be' ? parsed.pathname.split('/').filter(Boolean)[0] || '' : parsed.searchParams.get('v') || ''; }
    catch { return ''; }
  }
  if (platform === 'tiktok') return source.match(/\/video\/(\d+)/i)?.[1] || '';
  return '';
}

function canonicalUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    parsed.protocol = 'https:';
    parsed.hostname = parsed.hostname.toLowerCase().replace(/^(?:www\.|mobile\.)/, '');
    if (parsed.hostname === 'twitter.com') parsed.hostname = 'x.com';
    parsed.port = '';
    parsed.search = '';
    parsed.hash = '';
    parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    return parsed.toString();
  } catch { return ''; }
}

function contentHash(value) {
  let hash = 2166136261;
  for (const character of String(value || '')) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(36);
}

export function postIdentity(post) {
  const platform = platformName(post?.platform), urlId = urlPostId(platform, post?.url);
  if (urlId) return `${platform}:${urlId}`;
  const id = String(post?.id || '').trim(), idFromValue = urlPostId(platform, id);
  if (idFromValue) return `${platform}:${idFromValue}`;
  if (id && !/^content-/i.test(id)) return `${platform}:${id}`;
  const url = canonicalUrl(post?.url);
  if (url && !/^https:\/\/(?:x\.com\/?|linkedin\.com\/(?:feed\/?)?|reddit\.com\/?|youtube\.com\/?|tiktok\.com\/?|substack\.com\/?)$/i.test(url)) return `${platform}:url:${url}`;
  const publishedAt = new Date(post?.createdAt).getTime();
  const content = `${post?.author?.username || post?.author?.name || ''}|${Number.isFinite(publishedAt) ? publishedAt : ''}|${post?.text || ''}`;
  return content.replace(/\|/g, '') ? `${platform}:content:${contentHash(content)}` : 'unknown:';
}

export function normalizePostIdentity(value) {
  const key = String(value || '').trim(), separator = key.indexOf(':');
  if (separator < 1) return key;
  const platform = platformName(key.slice(0, separator)), identity = key.slice(separator + 1);
  if (/^https?:\/\//i.test(identity)) return postIdentity({ platform, url: identity });
  if (/^url:https?:\/\//i.test(identity)) return postIdentity({ platform, url: identity.slice(4) });
  return `${platform}:${identity}`;
}

export function mergeScanPosts(existingPosts, incomingPosts, { maxAgeHours = 3, hidden = [], now = Date.now() } = {}) {
  const cutoff = now - Math.max(0, Number(maxAgeHours) || 0) * 60 * 60 * 1000;
  const hiddenKeys = new Set((Array.isArray(hidden) ? hidden : []).map(normalizePostIdentity));
  const existingByKey = new Map((Array.isArray(existingPosts) ? existingPosts : []).map(post => [postIdentity(post), post]));
  const merged = new Map();

  const keep = post => {
    const key = postIdentity(post);
    const publishedAt = new Date(post?.createdAt).getTime();
    return key !== 'unknown:' && !hiddenKeys.has(key) && Number.isFinite(publishedAt) && publishedAt > cutoff;
  };

  for (const post of Array.isArray(incomingPosts) ? incomingPosts : []) {
    if (!keep(post)) continue;
    const key = postIdentity(post), prior = existingByKey.get(key);
    const followers = post?.author?.followers;
    const candidate = (followers === null || followers === undefined) && prior?.author?.followers !== null && prior?.author?.followers !== undefined
      ? { ...post, author: { ...post.author, followers: prior.author.followers } }
      : post;
    merged.set(key, candidate);
  }

  for (const post of Array.isArray(existingPosts) ? existingPosts : []) {
    const key = postIdentity(post);
    if (!merged.has(key) && keep(post)) merged.set(key, post);
  }

  return [...merged.values()].sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt));
}
