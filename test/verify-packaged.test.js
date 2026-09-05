import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import vm from 'node:vm';

const script = await readFile(new URL('../scripts/verify-packaged.cjs', import.meta.url), 'utf8');
function verify({ version = '1.2.3', missing = '', stale = '' } = {}) {
  const scriptDir = path.resolve('scripts'), root = path.join(scriptDir, '..');
  const expected = { version: '1.2.3', build: { files: ['main.js', 'public/**/*'] } };
  const modules = {
    'node:path': path,
    'node:fs': {
      readFileSync: filename => Buffer.from(filename.endsWith('package.json') ? JSON.stringify(expected) : 'fixture source'),
      readdirSync: () => [{ isFile: () => true, parentPath: path.join(root, 'public'), name: 'scan-policy.js' }]
    },
    '@electron/asar': { extractFile: (_, filename) => {
      if (filename === missing) throw new Error(`Missing ${filename}`);
      return Buffer.from(filename === 'package.json' ? JSON.stringify({ version }) : filename === stale ? 'old source' : 'fixture source');
    } }
  };
  vm.runInNewContext(script, { require: name => modules[name], __dirname: scriptDir, process: { argv: ['node', 'verify', 'fixture.asar'] }, console: { log() {} } });
}

test('release verifier accepts matching sources and rejects stale versions, code, or missing modules', () => {
  assert.doesNotThrow(() => verify());
  assert.throws(() => verify({ version: '1.2.2' }), /does not match/);
  assert.throws(() => verify({ stale: 'main.js' }), /stale/);
  assert.throws(() => verify({ missing: 'public/scan-policy.js' }), /Missing/);
});
