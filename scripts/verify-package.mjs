import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = path.join(root, 'release', '梅花-darwin-arm64', '梅花.app');
const packaged = path.join(bundle, 'Contents', 'Resources', 'app');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const expectedRoots = ['THIRD_PARTY_NOTICES.md', 'dist', 'electron', 'node_modules', 'package.json'];
assert.deepEqual((await readdir(packaged)).sort(), expectedRoots);

async function* files(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* files(file);
    else if (entry.isFile()) yield file;
    else throw new Error(`Unexpected source entry: ${path.relative(root, file)}`);
  }
}

let checked = 0;
for (const directory of ['electron', 'dist']) {
  for await (const source of files(path.join(root, directory))) {
    const relative = path.relative(root, source);
    assert.equal(digest(await readFile(path.join(packaged, relative))), digest(await readFile(source)), relative);
    checked++;
  }
}
assert.equal(
  digest(await readFile(path.join(packaged, 'THIRD_PARTY_NOTICES.md'))),
  digest(await readFile(path.join(root, 'THIRD_PARTY_NOTICES.md'))),
);
assert.equal(
  digest(await readFile(path.join(bundle, 'Contents', 'Resources', 'electron.icns'))),
  digest(await readFile(path.join(root, 'assets', 'Meihua.icns'))),
);

// Packager intentionally removes development scripts and metadata from this file.
const sourcePackage = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const bundledPackage = JSON.parse(await readFile(path.join(packaged, 'package.json'), 'utf8'));
for (const field of ['name', 'version', 'main', 'type', 'dependencies']) {
  assert.deepEqual(bundledPackage[field], sourcePackage[field], field);
}
assert.equal(bundledPackage.devDependencies, undefined);
assert.equal(bundledPackage.scripts, undefined);

const vendor = path.join(packaged, 'electron', 'vendor', 'sandbox-runtime');
const provenance = JSON.parse(await readFile(path.join(vendor, 'provenance.json'), 'utf8'));
for (const [file, expected] of Object.entries(provenance.files)) {
  assert.equal(digest(await readFile(path.join(vendor, file))), expected, file);
}
console.log(`PASS package roots, icon, ${checked} runtime/frontend files and vendored provenance`);

// Run imports with the shipped Node runtime and only the packaged dependencies.
const program = `
  const { pathToFileURL } = require('node:url');
  const path = require('node:path');
  const root = ${JSON.stringify(packaged)};
  const modules = ['electron/model.js', 'electron/mcp.js', 'electron/office.js',
    'electron/workspace.js', 'electron/runtime/runtime.js'];
  Promise.all(modules.map(file => import(pathToFileURL(path.join(root, file)).href)))
    .then(() => console.log('PASS packaged production module imports'), error => {
      console.error(error); process.exitCode = 1;
    });
`;
execFileSync(path.join(bundle, 'Contents', 'MacOS', '梅花'), ['-e', program], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: 'inherit',
});
