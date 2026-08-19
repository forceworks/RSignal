export function postIdentity(post) {
  return `${post?.platform || 'unknown'}:${post?.url || post?.id || post?.text || ''}`;
}

export function mergeScanPosts(existingPosts, incomingPosts, { maxAgeHours = 3, hidden = [], now = Date.now() } = {}) {
  const cutoff = now - Math.max(0, Number(maxAgeHours) || 0) * 60 * 60 * 1000;
  const hiddenKeys = new Set(Array.isArray(hidden) ? hidden : []);
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
