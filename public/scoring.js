function count(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

export function score(post, now = Date.now()) {
  const publishedAt = new Date(post?.createdAt).getTime();
  const age = Math.max(1, Number.isFinite(publishedAt) ? (now - publishedAt) / 60000 : 180);
  const replies = count(post?.replies);
  const engagement = count(post?.likes) + count(post?.reposts) * 2;
  const freshness = Math.max(0, 50 - age / 3);
  const openConversation = Math.max(0, 18 - replies * 3);
  const reach = Math.min(6, Math.log10(Math.max(10, count(post?.views))) * 1.5);
  const momentum = Math.min(8, engagement / Math.pow(age + 10, 0.75) * 3);
  return Math.max(1, Math.min(99, Math.round(20 + freshness + openConversation + reach + momentum)));
}
