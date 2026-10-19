import { afterEach, describe, expect, it, vi } from 'vitest';
import { KubeObject, listWatch, WatchState } from './watch';

type Reply = Response | Error | Promise<Response>;

/** fetch that answers from a queue; once empty, requests hang until aborted. */
function fakeFetch(replies: Reply[]) {
  const urls: string[] = [];
  const fn = vi.fn((url: string, init?: { signal?: AbortSignal }) => {
    urls.push(url);
    const r = replies.shift();
    if (r instanceof Error) return Promise.reject(r);
    if (r) return Promise.resolve(r);
    return new Promise<Response>((_, reject) =>
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    );
  });
  vi.stubGlobal('fetch', fn);
  return urls;
}

const obj = (name: string, rv: string): KubeObject => ({ metadata: { name, uid: name, resourceVersion: rv } });
const list = (rv: string, ...items: KubeObject[]) =>
  new Response(JSON.stringify({ metadata: { resourceVersion: rv }, items }));
/** A streamed watch body, delivered in the given chunks. */
const stream = (...chunks: string[]) =>
  new Response(
    new ReadableStream({
      start(c) {
        for (const s of chunks) c.enqueue(new TextEncoder().encode(s));
        c.close();
      },
    })
  );
const line = (type: string, o: unknown) => JSON.stringify({ type, object: o }) + '\n';

function run(replies: Reply[], opts = { retryMs: 5, idleMs: 5 }) {
  const urls = fakeFetch(replies);
  const log: string[] = [];
  const states: WatchState[] = [];
  const ac = new AbortController();
  const done = listWatch(
    '/api/v1/pods',
    {
      onList: items => log.push(`list ${items.map(i => i.metadata.name).join(',')}`),
      onEvent: (t, o) => log.push(`${t} ${o.metadata.name}`),
      onState: s => states.push(s),
    },
    ac.signal,
    opts
  );
  const until = async (pred: () => boolean) => {
    for (let i = 0; i < 200 && !pred(); i++) await new Promise(r => setTimeout(r, 5));
    expect(pred()).toBe(true);
  };
  const stop = async () => {
    ac.abort();
    await done;
  };
  return { urls, log, states, until, stop };
}

afterEach(() => vi.unstubAllGlobals());

describe('listWatch', () => {
  it('lists, then watches from the list version and resumes from the last event', async () => {
    const half = line('ADDED', obj('b', '11'));
    const t = run([
      list('10', obj('a', '10')),
      stream(half.slice(0, 15), half.slice(15) + line('MODIFIED', obj('a', '12'))),
    ]);
    await t.until(() => t.urls.length === 3);
    expect(t.log).toEqual(['list a', 'ADDED b', 'MODIFIED a']);
    expect(t.urls[1]).toContain('watch=1&allowWatchBookmarks=true&resourceVersion=10');
    expect(t.urls[2]).toContain('resourceVersion=12');
    await t.stop();
  });

  it('takes the resource version from bookmarks without changing state', async () => {
    const t = run([list('10'), stream(line('BOOKMARK', obj('', '20')))]);
    await t.until(() => t.urls.length === 3);
    expect(t.urls[2]).toContain('resourceVersion=20');
    await t.stop();
  });

  it('relists on a 410 ERROR event', async () => {
    const t = run([list('10'), stream(line('ERROR', { code: 410, message: 'too old' })), list('30', obj('c', '30'))]);
    await t.until(() => t.log.length === 2);
    expect(t.log).toEqual(['list ', 'list c']);
    expect(t.urls[2]).toBe('/api/v1/pods');
    expect(t.states.every(s => s.state === 'live')).toBe(true);
    await t.stop();
  });

  it('relists on an HTTP 410 from the watch', async () => {
    const t = run([list('10'), new Response('', { status: 410 }), list('30')]);
    await t.until(() => t.log.length === 2);
    expect(t.urls[2]).toBe('/api/v1/pods');
    await t.stop();
  });

  it('reports a failed list with its HTTP status and retries', async () => {
    const t = run([new Response('', { status: 403 }), list('10')]);
    await t.until(() => t.log.length === 1);
    expect(t.states[0]).toMatchObject({ state: 'retrying', status: 403 });
    expect(t.states.at(-1)).toEqual({ state: 'live' });
    await t.stop();
  });

  it('stays retrying until a reopened watch is answered', async () => {
    let answer!: (r: Response) => void;
    const pending = new Promise<Response>(r => (answer = r));
    const t = run([list('10'), new Error('connection refused'), pending]);
    await t.until(() => t.urls.length === 3);
    expect(t.states.map(s => s.state)).toEqual(['live', 'retrying']);
    answer(stream(line('ADDED', obj('a', '11'))));
    await t.until(() => t.states.length === 3);
    expect(t.states[2]).toEqual({ state: 'live' });
    await t.stop();
  });

  it('waits before reopening a watch that ended without events', async () => {
    const t = run([list('10'), stream(), stream()], { retryMs: 5, idleMs: 300 });
    await new Promise(r => setTimeout(r, 100));
    expect(t.urls.length).toBe(2);
    await t.until(() => t.urls.length === 3);
    expect(t.urls[2]).toContain('resourceVersion=10');
    await t.stop();
  });
});
