// Bundles the game into one self-contained HTML file in dist/.
//
// The game never needs this: index.html runs straight from source over file://, and that
// stays the way the project is developed. The bundle exists for handing the game to
// someone as a single file, and for seeing what the code actually weighs.
//
//   node tools/build.js
//
// Minification is done by terser, fetched on demand through npx and pinned so two builds
// of the same source produce the same output. Without it the bundle is still written, just
// unminified, and the script says so.

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const TERSER = 'terser@5.49.0';
const project = path.dirname(__dirname);
const dist = path.join(project, 'dist');
const outFile = path.join(dist, 'courier.html');

const read = p => fs.readFileSync(p, 'utf8');
const bytes = s => Buffer.byteLength(s, 'utf8');
const gzip = s => zlib.gzipSync(Buffer.from(s, 'utf8'), { level: 9 }).length;
const kb = n => `${(n / 1024).toFixed(1)} kB`;

// The load order in index.html is the single source of truth: a subsystem added there is
// picked up here without touching this script.
const html = read(path.join(project, 'index.html'));
const localPath = ref => path.join(project, ref.split(/[?#]/)[0].replace(/\//g, path.sep));

const scripts = [...html.matchAll(/<script\s+src="([^"]+)"><\/script>/g)].map(m => m[1]);
const styles = [...html.matchAll(/<link\s+rel="stylesheet"\s+href="([^"]+)">/g)].map(m => m[1]);
if (!scripts.length) throw new Error('No subsystem scripts found in index.html.');
if (styles.length !== 1) throw new Error(`Expected one stylesheet in index.html, found ${styles.length}.`);

const sources = scripts.map(ref => ({ ref, file: localPath(ref), code: read(localPath(ref)) }));
const rawJs = sources.map(s => s.code).join('\n;\n');
const css = read(localPath(styles[0]));

// ---------- minify ----------
// terser concatenates the inputs itself, so the order above is preserved and the whole
// bundle is compressed as one unit. Property names are never mangled: they reach the DOM,
// the canvas API, and the subsystem registry by name.
const tmp = path.join(dist, '.bundle.js');
fs.mkdirSync(dist, { recursive: true });

let js = rawJs, minified = false, note = '';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const terser = spawnSync(npx, ['--yes', TERSER, ...sources.map(s => s.file),
  '--compress', 'passes=2', '--mangle', '--output', tmp], { encoding: 'utf8', shell: process.platform === 'win32' });

if (terser.status === 0 && fs.existsSync(tmp)) {
  js = read(tmp);
  fs.unlinkSync(tmp);
  minified = true;
} else {
  note = `terser was unavailable, so the bundle is not minified.\n${(terser.stderr || terser.error || '').toString().trim()}`;
}

// ---------- assemble ----------
// A closing script tag inside a string would end the inline block early; nothing in the
// sources does that today, but a bundle that silently breaks later is worse than this line.
const safeJs = js.replace(/<\/script/gi, '<\\/script');

const bundle = html
  .replace(/\s*<link\s+rel="stylesheet"[^>]*>/, `\n<style>\n${css}\n</style>`)
  .replace(/\s*<!-- Ordered classic scripts[^>]*-->/, '')
  .replace(/\s*<script\s+src="[^"]+"><\/script>/g, '')
  .replace('</body>', `<script>\n${safeJs}\n</script>\n</body>`);

if (/<script\s+src=/.test(bundle) || /<link\s+rel="stylesheet"/.test(bundle))
  throw new Error('An external reference survived bundling; the output would not be self-contained.');

fs.writeFileSync(outFile, bundle);

// ---------- report ----------
const rawTotal = bytes(rawJs);
const longest = Math.max(...sources.map(s => path.basename(s.file).length));
console.log('source');
for (const s of [...sources].sort((a, b) => bytes(b.code) - bytes(a.code)))
  console.log(`  ${path.basename(s.file).padEnd(longest)}  ${kb(bytes(s.code)).padStart(9)}`);
console.log(`  ${'total JavaScript'.padEnd(longest)}  ${kb(rawTotal).padStart(9)}`);
console.log(`  ${'CSS + HTML'.padEnd(longest)}  ${kb(bytes(css) + bytes(html)).padStart(9)}`);
console.log('');
console.log('bundle');
console.log(`  JavaScript ${minified ? 'minified' : 'as written'}   ${kb(bytes(js)).padStart(9)}   ${(100 * bytes(js) / rawTotal).toFixed(1)} % of source`);
console.log(`  dist/courier.html        ${kb(bytes(bundle)).padStart(9)}`);
console.log(`  the same file, gzipped   ${kb(gzip(bundle)).padStart(9)}`);
if (note) console.log(`\n${note}`);
