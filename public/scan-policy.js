export function inQuietHours(settings, date = new Date()) {
  if (!settings.quietHoursEnabled) return false;
  if (settings.quietDays.map(Number).includes(date.getDay())) return true;
  const minutes = value => {
    const match = String(value || '').match(/^(\d{2}):(\d{2})$/);
    if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return null;
    return Number(match[1]) * 60 + Number(match[2]);
  };
  const start = minutes(settings.quietStart), end = minutes(settings.quietEnd);
  if (start === null || end === null || start === end) return false;
  const now = date.getHours() * 60 + date.getMinutes();
  return start < end ? now >= start && now < end : now >= start || now < end;
}

export function createScanRunner({ run, isQuiet, onStart = () => {} }) {
  let busy = false;
  return async function scan(automatic = false) {
    if (busy || (automatic && isQuiet())) return false;
    busy = true;
    try {
      onStart(automatic);
      await run(automatic);
      return true;
    } finally { busy = false; }
  };
}

// Bound each request by bytes as well as post count: article bodies can be large.
export async function screenInBatches(posts, instructions, profile, request) {
  const shown = [];
  let cachedCount = 0, processed = 0, batch = [];
  const bodyFor = items => JSON.stringify({ posts: items, instructions, profile });
  const send = async () => {
    if (!batch.length) return;
    const result = await request(bodyFor(batch));
    const decisions = result.decisions;
    if (!Array.isArray(decisions) || decisions.length !== batch.length ||
      new Set(decisions.map(item => item.index)).size !== batch.length ||
      decisions.some(item => !Number.isInteger(item.index) || item.index < 0 || item.index >= batch.length || typeof item.show !== 'boolean')) {
      throw new Error('AI screening returned incomplete results');
    }
    const keep = new Set(decisions.filter(item => item.show).map(item => item.index));
    shown.push(...batch.filter((_, index) => keep.has(index)));
    cachedCount += Number(result.cachedCount) || 0;
    processed += batch.length;
    batch = [];
  };
  try {
    for (const post of posts) {
      const candidate = [...batch, post];
      if (candidate.length > 100 || new TextEncoder().encode(bodyFor(candidate)).length > 900_000) await send();
      if (new TextEncoder().encode(bodyFor([post])).length > 900_000) throw new Error('A post is too large for AI screening.');
      batch.push(post);
    }
    await send();
  } catch (error) {
    return { posts: shown, excluded: processed - shown.length, skipped: true, cachedCount, pendingPosts: posts.slice(processed), error: error.message || 'AI screening unavailable' };
  }
  return { posts: shown, excluded: posts.length - shown.length, skipped: false, cachedCount };
}

export async function fetchFollowerBatches(authors, request) {
  const unique = new Map();
  for (const author of authors) {
    if (!['x', 'linkedin'].includes(author.platform)) continue;
    const username = String(author.username || '').replace(/^@/, '').toLowerCase();
    const identity = username && username !== 'unknown' ? username : String(author.profileUrl || '').toLowerCase().replace(/\/+$/, '');
    if (identity) unique.set(`${author.platform}:${identity}`, author);
  }
  const entries = [...unique.values()], result = { profiles: [], costUsd: 0, failures: 0 };
  for (let offset = 0; offset < entries.length; offset += 100) {
    const batch = entries.slice(offset, offset + 100);
    try {
      const response = await request(batch);
      result.profiles.push(...(response.profiles || []));
      result.costUsd += Number(response.costUsd) || 0;
      result.failures += Number(response.failures) || 0;
    } catch { result.failures += batch.length; }
  }
  return result;
}
