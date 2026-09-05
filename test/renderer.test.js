import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { score } from '../public/scoring.js';
import { authorIdentity, readAuthorRules, authorMode, changeAuthorRule } from '../public/author-rules.js';
import { restoreFeed, mergeScanPosts, normalizePostIdentity, postIdentity } from '../public/feed-state.js';
import { createScanRunner, inQuietHours as quietNow, screenInBatches, fetchFollowerBatches } from '../public/scan-policy.js';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
async function renderer(quiet = false, stored = {}, hooks = {}) {
  const now = Date.now();
  const post = { platform: 'x', id: '123', url: 'https://x.com/fixture/status/123', author: { name: 'Fixture', username: 'fixture', followers: 500 }, text: 'Fresh post', createdAt: new Date(now - 60_000).toISOString(), likes: 0, replies: 0, reposts: 0, query: 'fixture', isNew: false };
  const values = new Map([['signal:posts', JSON.stringify([post])], ['signal:quietHoursEnabled', String(quiet)], ['signal:quietDays', JSON.stringify([new Date(now).getDay()])]]);
  for (const [key, value] of Object.entries(stored)) values.set(key, value);
  const nodes = new Map(), intervals = [], notifications = [];
  let searches = 0, nextPost = post;
  class Element {
    constructor() { this.dataset = {}; this.classList = { toggle() {}, add() {}, remove() {}, contains: () => false }; this.children = new Map(); }
    querySelector(selector) { if (!this.children.has(selector)) this.children.set(selector, new Element()); return this.children.get(selector); }
    querySelectorAll() { return []; }
    replaceChildren(...children) { this.rendered = children; }
    addEventListener() {}
  }
  const node = selector => { if (!nodes.has(selector)) nodes.set(selector, new Element()); return nodes.get(selector); };
  const document = { hidden: false, querySelector: node, querySelectorAll: () => [], createElement: () => new Element(), addEventListener() {} };
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const context = {
    document, Date: Clock, Headers, TextEncoder, URL, console, score, restoreFeed, mergeScanPosts, normalizePostIdentity, postIdentity, createScanRunner, quietNow, screenInBatches, fetchFollowerBatches, authorIdentity, readAuthorRules, authorMode, changeAuthorRule,
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => { hooks.onStore?.(key); values.set(key, value); } },
    requestAnimationFrame() {}, setTimeout() {}, clearInterval() {}, setInterval: (callback, delay) => { intervals.push({ callback, delay }); return intervals.length; },
    window: { addEventListener() {}, signalDesktop: { getApiCapability: async () => '', getStartup: async () => false, onTriggerScan() {}, onNotificationClick() {}, notify: async payload => { notifications.push(payload); return true; } } },
    fetch: async (path, options) => {
      const intercepted = await hooks.onFetch?.(path, options);
      if (intercepted) return intercepted;
      if (path === '/api/search') { searches++; return { ok: true, json: async () => ({ posts: [nextPost], stats: { byPlatform: {}, alreadySeen: 0, tooOld: 0 } }) }; }
      return { ok: true, json: async () => path === '/api/status' ? { configured: true } : { checked: false } };
    }
  };
  const api = await vm.runInNewContext(`(async()=>{${source.replace(/^import .*;\r?\n/gm, '')}\nreturn {state,scan,render,setAuthorRule,notifyFresh};})()`, context);
  await new Promise(resolve => setImmediate(resolve));
  return { api, nodes, intervals, notifications, values, searches: () => searches, setPost: post => { nextPost = post; }, post };
}

test('renderer restores cached cards during quiet startup and its timer does not scan', async () => {
  const app = await renderer(true);
  assert.equal(app.searches(), 0);
  assert.equal(app.nodes.get('#feed').rendered.length, 1);
  app.intervals.find(timer => timer.delay === 15 * 60_000).callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.searches(), 0);
  await app.nodes.get('#scanButton').onclick({ type: 'click' });
  assert.equal(app.searches(), 1);
});

test('actual Scan Now click stays manual and restored posts do not repeat toasts', async () => {
  const app = await renderer();
  assert.equal(app.searches(), 1);
  assert.equal(app.notifications.length, 0);
  app.setPost({ ...app.post, id: '456', url: 'https://x.com/fixture/status/456', isNew: true });
  await app.nodes.get('#scanButton').onclick({ type: 'click' });
  assert.equal(app.notifications.length, 0);
  assert.equal(JSON.parse(app.values.get('signal:posts')).length, 2);
  app.setPost({ ...app.post, id: '789', url: 'https://x.com/fixture/status/789', isNew: true });
  await app.api.scan(true);
  assert.equal(app.notifications.length, 1);
  app.setPost({ ...app.post, id: '789', url: 'https://x.com/fixture/status/789', isNew: false });
  await app.api.scan(true);
  assert.equal(app.notifications.length, 1);
});

test('card author blocking hides cached posts, preserves saved posts, and suppresses rescans and toasts', async () => {
  const app = await renderer();
  app.nodes.get('#feed').rendered[0].querySelector('.save').onclick();
  app.nodes.get('#feed').rendered[0].querySelector('.block-author').onclick();
  assert.equal(app.nodes.get('#feed').rendered.length, 0);
  assert.equal(app.nodes.get('#savedFeed').rendered.length, 1);
  assert.equal(app.nodes.get('#blockedAuthors').rendered.length, 1);
  assert.match(app.nodes.get('#scanMeta').textContent, /^0 shown/);
  assert.equal(JSON.parse(app.values.get('signal:authorRules'))[0].mode, 'blocked');
  app.setPost({ ...app.post, id: '456', url: 'https://x.com/fixture/status/456', isNew: true });
  await app.api.scan(true);
  assert.equal(app.nodes.get('#feed').rendered.length, 0);
  assert.equal(app.notifications.length, 0);
  await app.api.notifyFresh([app.post]);
  assert.equal(app.notifications.length, 0);
  const restarted = await renderer(true, { 'signal:authorRules': app.values.get('signal:authorRules') });
  assert.equal(restarted.nodes.get('#feed').rendered.length, 0);
  restarted.nodes.get('#blockedAuthors').rendered[0].querySelector('button').onclick();
  assert.equal(restarted.nodes.get('#feed').rendered.length, 1);
  assert.deepEqual(JSON.parse(restarted.values.get('signal:authorRules')), []);
});

test('preferred authors lead Best matches only and still pass normal eligibility filters', async () => {
  const app = await renderer(true);
  const preferred = { ...app.post, id: '456', url: 'https://x.com/second/status/456', createdAt: new Date(Date.now() - 60 * 60_000).toISOString(), author: { name: 'Second', username: 'second', followers: 10 } };
  app.api.state.posts.push(preferred);
  app.api.render();
  app.nodes.get('#feed').rendered[1].querySelector('.prefer-author').onclick();
  assert.equal(app.nodes.get('#feed').rendered[0].dataset.postKey, postIdentity(preferred));
  assert.equal(app.nodes.get('#preferredAuthors').rendered.length, 1);
  app.api.state.filter = 'fresh'; app.api.render();
  assert.equal(app.nodes.get('#feed').rendered[0].dataset.postKey, postIdentity(app.post));
  app.api.state.filter = 'momentum'; app.api.state.posts[0].likes = 10; app.api.render();
  assert.equal(app.nodes.get('#feed').rendered[0].dataset.postKey, postIdentity(app.post));
  app.api.state.filter = 'all'; app.api.state.minFollowers = 100; app.api.render();
  assert.equal(app.nodes.get('#feed').rendered.length, 1);
  app.api.state.minFollowers = 0;
  preferred.createdAt = new Date(Date.now() - 4 * 60 * 60_000).toISOString(); app.api.render();
  assert.equal(app.nodes.get('#feed').rendered.length, 1);
});

test('same username on another source is not blocked and unsafe labels are escaped', async () => {
  const app = await renderer(true);
  app.api.setAuthorRule({ ...app.post, author: { ...app.post.author, name: '<img src=x onerror=alert(1)>' } }, 'blocked');
  const linkedin = { ...app.post, platform: 'linkedin', id: '456', url: 'https://www.linkedin.com/feed/update/urn:li:activity:456/' };
  app.api.state.posts.push(linkedin); app.api.render();
  assert.equal(app.nodes.get('#feed').rendered.length, 1);
  assert.equal(app.nodes.get('#feed').rendered[0].dataset.postKey, postIdentity(linkedin));
  assert.match(app.nodes.get('#blockedAuthors').rendered[0].innerHTML, /&lt;img/);
  assert.doesNotMatch(app.nodes.get('#blockedAuthors').rendered[0].innerHTML, /<img/);
});

test('failed author preference persistence leaves the feed and rules unchanged', async () => {
  const app = await renderer(true, {}, { onStore(key) { if (key === 'signal:authorRules') throw new Error('disk full'); } });
  assert.equal(app.api.setAuthorRule(app.post, 'blocked'), false);
  assert.equal(app.api.state.authorRules.length, 0);
  assert.equal(app.nodes.get('#feed').rendered.length, 1);
  assert.match(app.nodes.get('#authorRuleStatus').textContent, /Could not save/);
});

test('blocking during AI screening cannot restore the post or notify for it', async () => {
  let releaseScreen, startedScreen;
  const started = new Promise(resolve => { startedScreen = resolve; });
  const app = await renderer(true, { 'signal:aiInstructions': 'Exclude hiring posts' }, {
    async onFetch(path) {
      if (path !== '/api/ai/screen') return;
      startedScreen();
      return new Promise(resolve => { releaseScreen = () => resolve({ ok: true, json: async () => ({ decisions: [{ index: 0, show: true }] }) }); });
    }
  });
  app.api.state.quietHoursEnabled = false;
  app.setPost({ ...app.post, isNew: true });
  const scan = app.api.scan(true);
  await started;
  app.api.setAuthorRule(app.post, 'blocked');
  releaseScreen(); await scan;
  assert.equal(app.nodes.get('#feed').rendered.length, 0);
  assert.equal(app.notifications.length, 0);
});

test('blocked authors skip AI screening and follower lookups; preferred authors do not bypass AI', async () => {
  const requests = [];
  const app = await renderer(true, { 'signal:aiInstructions': 'Exclude hiring posts' }, {
    onFetch(path, options) {
      requests.push(path);
      if (path === '/api/ai/screen') return { ok: true, json: async () => ({ decisions: JSON.parse(options.body).posts.map((post, index) => ({ index, show: false })) }) };
    }
  });
  app.api.setAuthorRule(app.post, 'blocked');
  app.setPost({ ...app.post, author: { ...app.post.author, followers: null } });
  await app.api.scan(false);
  assert.ok(!requests.includes('/api/ai/screen'));
  assert.ok(!requests.includes('/api/followers'));
  app.api.setAuthorRule(app.post, 'preferred');
  await app.api.scan(false);
  assert.ok(requests.includes('/api/ai/screen'));
  assert.equal(app.nodes.get('#feed').rendered.length, 0);
});
