import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { score } from '../public/scoring.js';
import { restoreFeed, mergeScanPosts, normalizePostIdentity, postIdentity } from '../public/feed-state.js';
import { createScanRunner, inQuietHours as quietNow, screenInBatches, fetchFollowerBatches } from '../public/scan-policy.js';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
async function renderer(quiet = false) {
  const now = Date.now();
  const post = { platform: 'x', id: '123', url: 'https://x.com/fixture/status/123', author: { name: 'Fixture', username: 'fixture', followers: 500 }, text: 'Fresh post', createdAt: new Date(now - 60_000).toISOString(), likes: 0, replies: 0, reposts: 0, query: 'fixture', isNew: false };
  const values = new Map([['signal:posts', JSON.stringify([post])], ['signal:quietHoursEnabled', String(quiet)], ['signal:quietDays', JSON.stringify([new Date(now).getDay()])]]);
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
    document, Date: Clock, Headers, TextEncoder, URL, console, score, restoreFeed, mergeScanPosts, normalizePostIdentity, postIdentity, createScanRunner, quietNow, screenInBatches, fetchFollowerBatches,
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    requestAnimationFrame() {}, setTimeout() {}, clearInterval() {}, setInterval: (callback, delay) => { intervals.push({ callback, delay }); return intervals.length; },
    window: { addEventListener() {}, signalDesktop: { getApiCapability: async () => '', getStartup: async () => false, onTriggerScan() {}, onNotificationClick() {}, notify: async payload => { notifications.push(payload); return true; } } },
    fetch: async path => {
      if (path === '/api/search') { searches++; return { ok: true, json: async () => ({ posts: [nextPost], stats: { byPlatform: {}, alreadySeen: 0, tooOld: 0 } }) }; }
      return { ok: true, json: async () => path === '/api/status' ? { configured: true } : { checked: false } };
    }
  };
  const api = await vm.runInNewContext(`(async()=>{${source.replace(/^import .*;\r?\n/gm, '')}\nreturn {state,scan};})()`, context);
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
