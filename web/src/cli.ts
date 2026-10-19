import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { proxyArgs, SERVE_LINE, UI_PREFIX } from './proxy';

function currentContext(): string {
  try {
    return execFileSync('kubectl', ['config', 'current-context'], { encoding: 'utf8' }).trim();
  } catch {
    console.error(
      'No current kubeconfig context. Get one with `az aks get-credentials` or `kubectl config use-context`.'
    );
    process.exit(1);
  }
}

const context = currentContext();

// The page learns the context name from a file next to it, so serve a per-run copy.
const www = mkdtempSync(join(tmpdir(), 'aks-inspector-'));
cpSync(join(dirname(fileURLToPath(import.meta.url)), 'www'), www, { recursive: true });
writeFileSync(join(www, 'context.json'), JSON.stringify({ context }));
const cleanup = () => rmSync(www, { recursive: true, force: true });

const proxy = spawn('kubectl', proxyArgs(www, context), { stdio: ['ignore', 'pipe', 'inherit'] });
proxy.on('error', e => {
  console.error(`Could not start kubectl proxy: ${e.message}`);
  cleanup();
  process.exit(1);
});
proxy.on('exit', code => {
  cleanup();
  process.exit(code ?? 0);
});

let out = '';
proxy.stdout.on('data', (chunk: Buffer) => {
  out += chunk.toString();
  const m = SERVE_LINE.exec(out);
  if (m) {
    console.log(`aks-inspector on ${context}: http://${m[1]}${UI_PREFIX}  (Ctrl+C to stop)`);
    proxy.stdout.removeAllListeners('data');
  }
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => proxy.kill(sig));
