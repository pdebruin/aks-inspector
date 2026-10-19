/**
 * List then watch one Kubernetes collection (Kubernetes API concepts, "Efficient detection of
 * changes"). Works with any fetch that streams response bodies: browser or Node.
 */

export type WatchEventType = 'ADDED' | 'MODIFIED' | 'DELETED' | 'BOOKMARK' | 'ERROR';

export interface KubeObject {
  metadata: { name?: string; namespace?: string; uid?: string; resourceVersion?: string };
}

/** live: watch open. retrying: the last list or watch failed; status is the HTTP status if any. */
export type WatchState =
  | { state: 'live' }
  | { state: 'retrying'; status?: number; message: string };

export interface WatchCallbacks<T extends KubeObject> {
  /** Full state, after the initial list and after every relist. */
  onList(items: T[]): void;
  onEvent(type: Exclude<WatchEventType, 'ERROR'>, object: T): void;
  onState?(s: WatchState): void;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export interface WatchOptions {
  /** Prefix for the path, for example "http://127.0.0.1:8001". */
  base?: string;
  /** Wait after a failed list or watch. */
  retryMs?: number;
  /** Wait before reopening a watch that ended without delivering any event. */
  idleMs?: number;
}

/** Runs until the signal aborts. */
export async function listWatch<T extends KubeObject>(
  path: string,
  cb: WatchCallbacks<T>,
  signal: AbortSignal,
  { base = '', retryMs = 5000, idleMs = 1000 }: WatchOptions = {}
): Promise<void> {
  let rv = '';
  while (!signal.aborted) {
    let events = 0;
    try {
      if (!rv) {
        const res = await fetch(`${base}${path}`, { signal });
        if (!res.ok) throw new HttpError(res.status, `${path}: HTTP ${res.status}`);
        const list = (await res.json()) as { metadata: { resourceVersion: string }; items: T[] };
        rv = list.metadata.resourceVersion;
        cb.onList(list.items);
        // The list just succeeded; watch response headers can arrive only with the first event.
        cb.onState?.({ state: 'live' });
      }
      const sep = path.includes('?') ? '&' : '?';
      const url = `${base}${path}${sep}watch=1&allowWatchBookmarks=true&resourceVersion=${rv}`;
      const res = await fetch(url, { signal });
      if (!res.ok || !res.body) throw new HttpError(res.status, `${path}: HTTP ${res.status}`);
      cb.onState?.({ state: 'live' });
      for await (const line of lines(res.body)) {
        const ev = JSON.parse(line) as {
          type: WatchEventType;
          object: T & { code?: number; message?: string };
        };
        if (ev.type === 'ERROR') {
          throw new HttpError(ev.object.code ?? 0, `${path}: ${ev.object.message ?? 'error'}`);
        }
        events++;
        rv = ev.object.metadata.resourceVersion ?? rv;
        cb.onEvent(ev.type, ev.object);
      }
    } catch (e) {
      if (signal.aborted) return;
      if (e instanceof HttpError && e.status === 410) {
        rv = '';
      } else {
        const status = e instanceof HttpError ? e.status : undefined;
        cb.onState?.({ state: 'retrying', status, message: (e as Error).message });
        await sleep(retryMs, signal);
        continue;
      }
    }
    if (events === 0) await sleep(idleMs, signal);
  }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>(resolve => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

/** Newline-delimited JSON documents from a streamed body. */
async function* lines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) yield line;
    }
  }
  if (buf.trim()) yield buf.trim();
}
