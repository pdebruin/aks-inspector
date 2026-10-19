import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

await mkdir('dist/www', { recursive: true });
await build({
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/cli.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  banner: { js: '#!/usr/bin/env node' },
});
await build({
  entryPoints: ['src/www/app.ts'],
  outfile: 'dist/www/app.js',
  bundle: true,
  platform: 'browser',
  format: 'esm',
});
for (const f of ['index.html', 'style.css']) await copyFile(`src/www/${f}`, `dist/www/${f}`);
