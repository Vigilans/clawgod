import { readFileSync, writeFileSync, unlinkSync, existsSync, readdirSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const artifactDir = process.argv[2] || here;
const src = join(artifactDir, 'cli.original.js');
const dst = join(artifactDir, 'cli.original.cjs');
const pathMapFile = join(artifactDir, 'pathmap.json');

let code = readFileSync(src, 'utf8');

// v2.1.245+ splits the app into an ESM chunk graph; post-process then
// rewrites the whole bunfs/ dir too. Legacy single-bundle has no pathmap.
const isChunked = existsSync(pathMapFile);

// (0) Strip leading @bun pragma comments (e.g. "// @bun @bytecode @bun-cjs\n")
// Bun requires the file to start directly with "(function" (CJS) or the
// first import (ESM) — any preceding comment breaks that detection.
function stripPragma(c) { return c.replace(/^(?:\/\/[^\n]*\n)+/, ''); }

// build-time fileURLToPath() leaks → use cli.cjs's own __filename
function fixFileURLs(c) {
  return c.replace(
    /[\w$]+\.fileURLToPath\("file:\/\/\/home\/runner\/work\/claude-cli-internal\/claude-cli-internal\/[^"]*"\)/g,
    () => '__filename',
  );
}

if (isChunked) {
  // ── v2.1.245+ ESM chunk graph path ──
  const pathMap = JSON.parse(readFileSync(pathMapFile, 'utf8'));
  function rewriteGraph(text, sourcePath) {
    // Replace string literals containing the virtual in-bundle root
    // (POSIX "/$bunfs/root/..." or Windows single-drive "B:/~BUN/root/...")
    // with a relative path so an atomically staged artifact remains valid
    // after its directory is renamed into the version cache.
    return text.replace(/["'`](?:\/\$bunfs\/root|[A-Za-z]:\/~BUN\/root)\/[^"'`]+["'`]/g, (m) => {
      const body = m.slice(1, -1);
      const rel = pathMap[body] || pathMap[body.replaceAll('\\','/')];
      if (!rel) return m;
      let target = relative(dirname(sourcePath), join(artifactDir, rel)).replaceAll('\\', '/');
      if (!target.startsWith('.')) target = `./${target}`;
      return JSON.stringify(target);
    });
  }

  // entry → cli.original.cjs (ESM, no IIFE wrap)
  code = stripPragma(code);
  code = rewriteGraph(code, dst);
  code = fixFileURLs(code);
  writeFileSync(dst, code);
  unlinkSync(src);

  // rewrite every chunk/asset file in bunfs/ in place
  const bunfsDir = join(artifactDir, 'bunfs');
  let n = 0;
  for (const f of readdirSync(bunfsDir)) {
    if (!f.endsWith('.js') && !f.endsWith('.mjs')) continue;
    const fp = join(bunfsDir, f);
    const content = readFileSync(fp);
    let fc = content.toString('utf8');
    // File-loader assets can retain a .js name while containing compressed bytes.
    if (!Buffer.from(fc, 'utf8').equals(content)) continue;
    fc = stripPragma(fc);
    fc = rewriteGraph(fc, fp);
    fc = fixFileURLs(fc);
    writeFileSync(fp, fc);
    n++;
  }
  console.log(`cli.original.cjs: ${code.length} bytes (chunked, rewrote ${n} graph files)`);
} else {
  // ── Legacy single-bundle path ──
  code = stripPragma(code);

  // (1) bunfs .node module paths → runtime vendor lookup
  code = code.replace(
    /require\(['"](\/\$bunfs\/root\/([\w-]+)\.node)['"]\)/g,
    (m, _full, name) =>
      `require(require('path').join(__dirname,'vendor',${JSON.stringify(name)},\`\${process.arch==='arm64'?'arm64':'x64'}-\${process.platform==='darwin'?'darwin':process.platform==='linux'?'linux':'win32'}\`,${JSON.stringify(name + '.node')}))`,
  );

  code = fixFileURLs(code);

  // (3) make the outer (function(...){...}) actually run
  code = code.replace(/\}\)\s*$/, '})(exports, require, module, __filename, __dirname)');

  writeFileSync(dst, code);
  unlinkSync(src);
  console.log(`cli.original.cjs: ${code.length} bytes`);
}
