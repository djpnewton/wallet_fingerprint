/**
 * Builds the backend-free web version into `dist/web/`.
 *
 * Two things happen here that the Node build never needs:
 *  - the rule set is inlined as text, so the page needs no rules request;
 *  - the dashboard markup is copied verbatim from `src/dashboard/index.html`
 *    and given an `app.js` tag, so one renderer serves both the served
 *    dashboard and the static page.
 */

import { build } from 'esbuild';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'dist', 'web');
const APP_TAG = '<script src="./app.js"></script>';

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const result = await build({
  entryPoints: [resolve(ROOT, 'src', 'web', 'main.ts')],
  outfile: resolve(OUT, 'app.js'),
  bundle: true,
  format: 'iife',
  target: ['es2022'],
  platform: 'browser',
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  loader: { '.yaml': 'text' },
  metafile: true,
});

const page = readFileSync(resolve(ROOT, 'src', 'dashboard', 'index.html'), 'utf8');
const marker = '    <script>\n';
const at = page.lastIndexOf(marker);
if (at < 0) throw new Error('dashboard page has no inline renderer script to precede');
// The transport must exist before the renderer runs, and a classic (non-module)
// script tag executes in document order, so the bundle goes immediately before
// the inline script rather than at the end of the body.
const injected = page.slice(0, at) + `    ${APP_TAG}\n` + page.slice(at);
writeFileSync(resolve(OUT, 'index.html'), injected);

const bytes = Object.values(result.metafile.outputs).reduce((sum, o) => sum + o.bytes, 0);
const kib = (bytes / 1024).toFixed(1);
process.stdout.write(`built dist/web/ (app.js ${kib} KiB)\n`);
