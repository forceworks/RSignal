const { readFileSync, readdirSync } = require('node:fs');
const { join, relative } = require('node:path');
const { extractFile } = require('@electron/asar');

const archive = process.argv[2];
const root = join(__dirname, '..');
const expected = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const packaged = JSON.parse(extractFile(archive, 'package.json').toString('utf8'));
if (packaged.version !== expected.version) throw new Error(`Packaged version ${packaged.version} does not match ${expected.version}. Rebuild first.`);
// SkipBuild must not accidentally ship stale application code under a new ZIP name.
const entries = [];
for (const pattern of expected.build.files) {
  if (pattern.endsWith('/**/*')) {
    const directory = pattern.slice(0, -5);
    for (const entry of readdirSync(join(root, directory), { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) entries.push(relative(root, join(entry.parentPath, entry.name)));
    }
  } else entries.push(pattern);
}
for (const entry of entries) {
  const name = entry.replace(/\\/g, '/');
  if (!name.endsWith('.js') && !name.endsWith('.cjs') && !name.endsWith('.html') && !name.endsWith('.css')) continue;
  const local = join(root, name);
  if (relative(root, local).startsWith('..')) throw new Error('Invalid packaged path.');
  if (!extractFile(archive, name).equals(readFileSync(local))) throw new Error(`Packaged ${name} is stale. Rebuild first.`);
}
console.log(`Verified packaged version ${packaged.version} and application sources.`);
