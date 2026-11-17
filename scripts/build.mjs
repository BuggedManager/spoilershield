// Production build: bundles TypeScript with esbuild, copies static assets,
// stamps the manifest version and writes dist/ (Load unpacked) + a store zip.
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipDir } from './zip.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const dev = process.argv.includes('--dev');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

if (!existsSync(join(root, 'public/icons/icon128.png'))) {
  await import('./make-icons.mjs');
}

const t0 = Date.now();
await build({
  entryPoints: {
    content: join(root, 'src/content/index.ts'),
    background: join(root, 'src/background/index.ts'),
    popup: join(root, 'src/popup/popup.ts'),
    options: join(root, 'src/settings/options.ts'),
  },
  outdir: dist,
  bundle: true,
  format: 'iife',
  target: ['chrome111'],
  minify: !dev,
  sourcemap: dev ? 'inline' : false,
  legalComments: 'none',
  charset: 'utf8',
  define: { 'process.env.NODE_ENV': dev ? '"development"' : '"production"' },
  logLevel: 'warning',
});

cpSync(join(root, 'public'), dist, { recursive: true });
const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
manifest.version = pkg.version;
writeFileSync(join(dist, 'manifest.json'), JSON.stringify(manifest, null, 2));

// Guard rails: no eval / remote code in the bundle.
for (const f of ['content.js', 'background.js', 'popup.js', 'options.js']) {
  const src = readFileSync(join(dist, f), 'utf8');
  if (/\beval\(|new Function\(/.test(src)) throw new Error(`${f} contains eval/new Function`);
  if (/https?:\/\/[^"'\s]*\.js\b/.test(src)) throw new Error(`${f} references a remote script`);
}

const sizes = readdirSync(dist)
  .filter((f) => f.endsWith('.js'))
  .map((f) => `${f} ${(statSync(join(dist, f)).size / 1024).toFixed(1)} KB`);
const zipName = `spoilershield-${pkg.version}.zip`;
const n = zipDir(dist, join(root, zipName));
console.log(`Built SpoilerShield ${pkg.version} in ${Date.now() - t0} ms → dist/ (${sizes.join(', ')}); ${zipName} (${n} files)`);
