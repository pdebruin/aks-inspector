import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { proxyArgs, SERVE_LINE } from './proxy';

/** Starts the real kubectl proxy with the tool's arguments. Needs kubectl and a current context. */
let context = '';
try {
  context = execFileSync('kubectl', ['config', 'current-context'], { encoding: 'utf8' }).trim();
} catch {
  // no kubectl or no context: skipped below
}

describe.skipIf(!context)('kubectl proxy is read-only and limited to nodes and pods', () => {
  const www = mkdtempSync(join(tmpdir(), 'aks-inspector-test-'));
  writeFileSync(join(www, 'index.html'), 'ok');
  const proxy = spawn('kubectl', proxyArgs(www, context), { stdio: ['ignore', 'pipe', 'inherit'] });
  let base = '';

  beforeAll(
    () =>
      new Promise<void>((resolve, reject) => {
        let out = '';
        proxy.stdout.on('data', (c: Buffer) => {
          const m = SERVE_LINE.exec((out += c));
          if (m) resolve(void (base = `http://${m[1]}`));
        });
        proxy.on('exit', code => reject(new Error(`kubectl proxy exited with ${code}`)));
      })
  );
  afterAll(() => {
    proxy.kill();
    rmSync(www, { recursive: true, force: true });
  });

  const status = async (path: string, method = 'GET') =>
    (await fetch(`${base}${path}`, { method, redirect: 'manual' })).status;

  it('serves the page', async () => expect(await status('/ui/')).toBe(200));

  it('passes node and pod lists and watches', async () => {
    expect(await status('/api/v1/nodes')).not.toBe(403);
    expect(await status('/api/v1/pods?watch=1&timeoutSeconds=1')).not.toBe(403);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('rejects %s', async method =>
    expect(await status('/api/v1/pods', method)).toBe(403)
  );

  it.each([
    '/api/v1/namespaces/kube-system/secrets',
    '/api/v1/namespaces/default/configmaps',
    '/api/v1/namespaces/kube-system/pods/x',
    '/api/v1/namespaces/kube-system/pods/x/log',
    '/api/v1/namespaces/kube-system/pods/x/exec',
    '/api/v1/namespaces/kube-system/pods/x/portforward',
    '/api/v1/namespaces/kube-system/services/x/proxy/',
    '/api/v1/nodes/x/proxy/',
    '/apis/apps/v1/deployments',
  ])('rejects GET %s', async path => expect(await status(path)).toBe(403));
});
