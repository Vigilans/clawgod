#!/usr/bin/env bun
// Re-extract + post-process + patch a supplied native Claude binary.
import { spawnSync } from 'child_process';
import { writeFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const nativeBin = process.argv[2];
const artifactDir = process.argv[3] || here;
const requestedVersion = process.argv[4];

if (!nativeBin || !existsSync(nativeBin)) {
  console.error('repatch: native binary path required and must exist');
  process.exit(1);
}

function queryVersion() {
  const result = spawnSync(nativeBin, ['--version'], {
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
  });
  if (result.status !== 0 || result.error || typeof result.stdout !== 'string') return null;
  return result.stdout.trim().match(/^([0-9]+(?:\.[0-9]+){2}(?:-[0-9A-Za-z.-]+)?) \(Claude Code\)$/)?.[1] || null;
}

const sourceVersion = queryVersion();
if (!sourceVersion || (requestedVersion && requestedVersion !== sourceVersion)) {
  console.error('repatch: native Claude version could not be verified');
  process.exit(1);
}

mkdirSync(artifactDir, { recursive: true });
for (const name of ['vendor', 'bunfs', 'pathmap.json', 'cli.original.js', 'cli.original.cjs', 'cli.original.cjs.bak', '.source-version']) {
  rmSync(join(artifactDir, name), { recursive: true, force: true });
}

const runtime = process.execPath;

function run(label, args) {
  const result = spawnSync(runtime, args, { cwd: here, encoding: 'utf8' });
  if (result.stdout) process.stderr.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0 || result.error) {
    console.error(`repatch: ${label} failed (exit ${result.status})`);
    process.exit(1);
  }
}

const extractor = join(here, 'extract-natives.mjs');
const postProc = join(here, 'post-process.mjs');
const patcher = join(here, 'patch.mjs');

run('extract', [extractor, nativeBin, artifactDir]);
run('post-process', [postProc, artifactDir]);
run('patcher', [patcher, '--target', artifactDir]);

for (const arg of ['--version', '--help']) {
  const smoke = spawnSync(runtime, [
    '--preload', join(here, 'feature-gates.cjs'),
    '--preload', join(here, 'runtime-helpers.cjs'),
    join(artifactDir, 'cli.original.cjs'), arg,
  ], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  if (smoke.status !== 0 || smoke.error || typeof smoke.stdout !== 'string' ||
      (arg === '--version' && !smoke.stdout.includes(`${sourceVersion} (Claude Code)`))) {
    if (smoke.stderr) process.stderr.write(smoke.stderr);
    console.error(`repatch: patched Claude ${arg} check failed`);
    process.exit(1);
  }
}

writeFileSync(join(artifactDir, '.source-version'), sourceVersion + '\n');
if (resolve(artifactDir) === resolve(here)) rmSync(join(here, 'versions'), { recursive: true, force: true });
console.error(`[clawgod] patched Claude ${sourceVersion}`);
