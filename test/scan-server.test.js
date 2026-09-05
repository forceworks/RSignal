import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSignalServer } from '../server.js';

test('fresh seen posts survive server restart without being flagged new; scans are exclusive', async t => {
  const previousDataDir = process.env.SIGNAL_DATA_DIR, previousKey = process.env.ANYAPI_KEY;
  const dataDir = await mkdtemp(join(tmpdir(), 'rsignals-scan-test-'));
  process.env.SIGNAL_DATA_DIR = dataDir;
  delete process.env.ANYAPI_KEY;
  let server;
  const close = async () => { if (server) { const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed; server = null; } };
  t.after(async () => {
    await close();
    if (previousDataDir === undefined) delete process.env.SIGNAL_DATA_DIR; else process.env.SIGNAL_DATA_DIR = previousDataDir;
    if (previousKey === undefined) delete process.env.ANYAPI_KEY; else process.env.ANYAPI_KEY = previousKey;
    await rm(dataDir, { recursive: true, force: true });
  });
  let readKey = async () => '';
  const start = async () => {
    server = createSignalServer({ capabilityToken: 'test-only', credentialStore: { read: () => readKey() }, aiService: { stop() {} } });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
  };
  const scan = () => fetch(`http://127.0.0.1:${server.address().port}/api/search`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-RSignals-Capability': 'test-only' },
    body: JSON.stringify({ platforms: ['x'], queriesByPlatform: { x: ['fixture'] }, limit: 4, maxAgeHours: 3 })
  });
  await start();
  const first = await (await scan()).json();
  assert.equal(first.posts.length, 4);
  assert.ok(first.posts.every(post => post.isNew));
  await close(); await start();
  const restored = await (await scan()).json();
  assert.deepEqual(restored.posts.map(post => post.id), first.posts.map(post => post.id));
  assert.ok(restored.posts.every(post => post.isNew === false));
  assert.equal(restored.stats.byPlatform.x.new, 0);
  let release, entered;
  const reading = new Promise(resolve => { entered = resolve; });
  readKey = () => new Promise(resolve => { release = resolve; entered(); });
  const pending = scan();
  await reading;
  assert.equal((await scan()).status, 409);
  release('');
  assert.equal((await pending).status, 200);
  readKey = async () => { throw new Error('fixture read failure'); };
  assert.equal((await scan()).status, 500);
  readKey = async () => '';
  assert.equal((await scan()).status, 200);

  // Returning seen results must not pay to fetch the same X article on each scan.
  const realFetch = globalThis.fetch;
  const article = JSON.parse(await readFile(new URL('./fixtures/twitter.article.sanitized.json', import.meta.url), 'utf8'));
  let articleLookups = 0;
  readKey = async () => 'test-only-key';
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('https://api.getanyapi.com/')) {
      if (String(url).endsWith('/twitter.article')) { articleLookups++; return new Response(JSON.stringify(article)); }
      return new Response(JSON.stringify({ output: { tweets: [{ id: '123456789', text: 'https://t.co/fixture', url: 'https://x.com/fixture/status/123456789', createdAt: new Date().toISOString(), author: { name: 'Fixture', userName: 'fixture' } }] } }));
    }
    return realFetch(url, options);
  };
  try {
    const initialArticle = await (await scan()).json();
    assert.ok(initialArticle.posts[0].article?.body);
    await close(); await start();
    const restoredArticle = await (await scan()).json();
    assert.ok(restoredArticle.posts[0].article?.body);
    assert.equal(restoredArticle.posts[0].isNew, false);
    assert.equal(articleLookups, 1);
  } finally { globalThis.fetch = realFetch; }
});
