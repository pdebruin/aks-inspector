import { build } from 'esbuild';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';

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

// npm shows the README from the package folder; image paths must be absolute there.
const readme = await readFile('../README.md', 'utf8');
await writeFile('README.md', readme.replaceAll('](docs/', '](https://raw.githubusercontent.com/pdebruin/aks-inspector/main/docs/'));
