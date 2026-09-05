function profile(value) {
  try {
    const url = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return { host: url.hostname.toLowerCase().replace(/^(?:www\.|mobile\.)/, ''), path: url.pathname.replace(/\/+$/, '') };
  } catch { return null; }
}

export function authorIdentity(post) {
  const platform = String(post?.platform || '').toLowerCase();
  const author = post?.author || {};
  let username = String(author.username || '').trim().replace(/^@/, '');
  if (['unknown', '[deleted]', 'deleted', 'youtube', 'substack author'].includes(username.toLowerCase())) username = '';
  const url = profile(author.profileUrl);
  if (platform === 'x') {
    const handle = url && ['x.com', 'twitter.com'].includes(url.host) && /^\/[^/]+$/.test(url.path) ? url.path.slice(1) : username;
    return handle.toLowerCase()!=='unknown' && /^[a-z0-9_]{1,15}$/i.test(handle) ? `x:${handle.toLowerCase()}` : '';
  }
  if (platform === 'linkedin') {
    const match = url && /^(?:[a-z]{2}\.)?linkedin\.com$/.test(url.host) && url.path.match(/^\/(in|company)\/([^/]+)$/i);
    if (match) return match[2].toLowerCase()==='unknown' ? '' : `linkedin:${match[1].toLowerCase()}:${match[2].toLowerCase()}`;
    return /^[a-z0-9_-]+$/i.test(username) ? `linkedin:in:${username.toLowerCase()}` : '';
  }
  if (platform === 'reddit') {
    username = username.replace(/^u\//i, '');
    return /^[a-z0-9_-]{1,30}$/i.test(username) ? `reddit:${username.toLowerCase()}` : '';
  }
  if (platform === 'tiktok') return /^[a-z0-9_.]{1,24}$/i.test(username) ? `tiktok:${username.toLowerCase()}` : '';
  // These providers can return display names as username; only use explicit profiles.
  if (platform === 'youtube' && url?.host === 'youtube.com' && /^\/(?:channel\/[^/]+|@[^/]+)$/.test(url.path)) return `youtube:${url.path}`;
  if (platform === 'substack' && url?.host === 'substack.com' && /^\/@[^/]+$/.test(url.path)) return `substack:${url.path.toLowerCase()}`;
  return '';
}

export function readAuthorRules(storage) {
  try {
    const entries = JSON.parse(storage.getItem('signal:authorRules') || '[]');
    if (!Array.isArray(entries)) return [];
    return [...new Map(entries.filter(entry => entry && typeof entry.key === 'string' && typeof entry.label === 'string' &&
      ['x', 'linkedin', 'reddit', 'youtube', 'tiktok', 'substack'].includes(entry.platform) && entry.key.startsWith(`${entry.platform}:`) &&
      ['blocked', 'preferred'].includes(entry.mode)).map(entry => [entry.key, entry])).values()];
  } catch { return []; }
}

export function authorMode(post, rules) {
  const key = authorIdentity(post);
  return key ? rules.find(rule => rule.key === key)?.mode || '' : '';
}

export function changeAuthorRule(rules, author, mode) {
  if (!author?.key) return rules;
  const next = rules.filter(rule => rule.key !== author.key);
  if (['blocked', 'preferred'].includes(mode)) next.push({ key: author.key, label: author.label, platform: author.platform, mode });
  return next;
}
