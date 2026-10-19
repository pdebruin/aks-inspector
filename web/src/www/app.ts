import {
  buildView,
  cores,
  gib,
  NodeJson,
  NodeView,
  plural,
  PodJson,
  podRequestsText,
  PodView,
  sumRequests,
  toPodView,
  workloadColors,
} from '../model';
import { KubeObject, listWatch, WatchState } from '../watch';
import { el } from './el';

interface Store<T> {
  items: Map<string, T>;
  listed: boolean;
  state?: WatchState;
}
const nodes: Store<NodeJson> = { items: new Map(), listed: false };
const pods: Store<PodJson> = { items: new Map(), listed: false };
const keyOf = (o: KubeObject) => o.metadata.uid ?? `${o.metadata.namespace}/${o.metadata.name}`;

function watch<T extends KubeObject>(path: string, s: Store<T>) {
  void listWatch<T>(
    path,
    {
      onList(items) {
        s.items = new Map(items.map(o => [keyOf(o), o]));
        s.listed = true;
        schedule();
      },
      onEvent(type, o) {
        if (type === 'BOOKMARK') return;
        if (type === 'DELETED') s.items.delete(keyOf(o));
        else s.items.set(keyOf(o), o);
        schedule();
      },
      onState(state) {
        s.state = state;
        schedule();
      },
    },
    new AbortController().signal
  );
}

// UI state, kept in the URL so a view can be reloaded or shared.
const params = new URLSearchParams(location.search);
let pool = params.get('pool') ?? undefined;
let showAgents = false;
function setParam(k: string, v?: string) {
  if (v) params.set(k, v);
  else params.delete(k);
  history.replaceState(null, '', `?${params}`);
}

let pending = false;
function schedule() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    render();
  });
}

const $ = (id: string) => document.getElementById(id)!;
const SOURCE = { nap: 'NAP', agentpool: 'agent pool', unknown: 'no pool label' };
const RBAC = {
  nodes: 'Needs list and watch on nodes, which takes a ClusterRole.',
  pods: 'Needs list and watch on pods in all namespaces.',
};

function failed(s: Store<unknown>) {
  return !s.listed && s.state?.state === 'retrying' ? s.state : undefined;
}

function errorBanner(kind: 'nodes' | 'pods', st: Extract<WatchState, { state: 'retrying' }>) {
  return el(
    'p',
    { class: 'banner' },
    `${kind === 'nodes' ? 'Nodes' : 'Pods'} could not be listed: ${st.message}. `,
    st.status === 403 ? RBAC[kind] : 'Retrying every 5 seconds.'
  );
}

let poolSignature = '';
function renderPools(view: ReturnType<typeof buildView>) {
  const select = $('pool') as HTMLSelectElement;
  const sig = JSON.stringify([view.pools, view.selectedPoolId]);
  if (sig === poolSignature) return;
  poolSignature = sig;
  select.replaceChildren(
    ...view.pools.map(p =>
      el(
        'option',
        { value: p.id, selected: p.id === view.selectedPoolId },
        `${p.name} · ${SOURCE[p.source]} · ${p.mode} · ${plural(p.nodes, 'node')}`
      )
    )
  );
  select.disabled = view.pools.length === 0;
}

function render() {
  const nodeErr = failed(nodes);
  const podErr = failed(pods);
  const live = [nodes, pods].every(s => s.state?.state === 'live');
  $('live').textContent = live ? '● Live' : nodes.listed && pods.listed ? 'Reconnecting…' : '';
  $('live').className = live ? 'ok' : 'muted';

  if ((!nodes.listed && !nodeErr) || (!pods.listed && !podErr)) return;

  const podList = pods.listed ? [...pods.items.values()] : null;
  const view = buildView([...nodes.items.values()], podList, pool);
  renderPools(view);

  const waiting = (podList ?? [])
    .filter(p => !p.spec?.nodeName && p.status?.phase === 'Pending')
    .map(p => ({ pod: toPodView(p), why: schedulingMessage(p) }));
  const colors = workloadColors(view.nodes);
  renderSummary(view.nodes, !!podList, !!nodeErr);

  const parts = [
    nodeErr ? errorBanner('nodes', nodeErr) : null,
    podErr ? errorBanner('pods', podErr) : null,
    waiting.length ? waitingList(waiting) : null,
    nodeErr
      ? null
      : view.nodes.length === 0
        ? el('p', { class: 'muted' }, view.pools.length ? 'This node pool has no nodes.' : 'No nodes found.')
        : el('div', { class: 'grid' }, view.nodes.map(n => nodeColumn(n, colors))),
  ];
  // Rebuilding the grid drops focus; put it back on the same control.
  const focused = (document.activeElement as HTMLElement | null)?.dataset?.focus;
  $('main').replaceChildren(...parts.filter(p => p !== null));
  if (focused) $('main').querySelector<HTMLElement>(`[data-focus="${CSS.escape(focused)}"]`)?.focus();
}

function renderSummary(shown: NodeView[], podsKnown: boolean, nodesFailed: boolean) {
  const all = shown.flatMap(n => n.pods);
  const count = (g: PodView['group']) => all.filter(p => p.group === g).length;
  $('counts').textContent = nodesFailed
    ? 'Nodes unknown'
    : `${plural(shown.length, 'node')}, ` +
      (podsKnown
        ? `${plural(all.length, 'pod')}: ${count('user')} user, ${count('system')} system, ${plural(count('agent'), 'node agent')}`
        : 'pods unknown');
}

function schedulingMessage(p: PodJson): string {
  const c = (p.status?.conditions ?? []) as Array<{ type: string; status: string; message?: string }>;
  return c.find(x => x.type === 'PodScheduled' && x.status === 'False')?.message ?? 'Not scheduled yet.';
}

function waitingList(waiting: Array<{ pod: PodView; why: string }>) {
  return el(
    'section',
    { class: 'waiting' },
    el('h2', null, `Waiting for a node (${waiting.length})`),
    waiting.map(w => el('div', null, podRow(w.pod), el('p', { class: 'why muted' }, w.why)))
  );
}

function nodeColumn(n: NodeView, colors: Map<string, string>) {
  const of = (g: PodView['group']) => n.pods.filter(p => p.group === g);
  const [agents, user, system] = [of('agent'), of('user'), of('system')];
  const notReady = agents.filter(p => p.status !== 'success').length;
  const rows = (list: PodView[]) => {
    const ns = soleNamespace(list);
    return list.map(p => podRow(p, colors.get(`${p.namespace}/${p.workload}`), !ns));
  };
  return el(
    'section',
    { class: 'node', 'aria-label': `Node ${n.name}` },
    el(
      'header',
      null,
      el('h2', { title: n.name }, n.name),
      n.cordoned ? el('span', { class: 'badge warn' }, 'Cordoned') : null,
      el('span', { class: `badge ${n.ready ? 'ok' : 'err'}` }, n.ready ? 'Ready' : 'NotReady')
    ),
    el('p', { class: 'muted small' }, `${n.pool} · ${n.mode} · `, n.requested ? plural(n.pods.length, 'pod') : 'pods unknown'),
    usage('CPU', n.requested?.cpu, n.allocatable.cpu, cores, 'cores'),
    usage('Mem', n.requested?.mem, n.allocatable.mem, gib, 'GiB'),
    n.requested
      ? [
          groupHead(
            `Node agents (${agents.length})`,
            agents,
            el('span', { class: notReady ? 'warn small' : 'muted small' }, agents.length === 0 ? 'none' : notReady ? `${notReady} not ready` : 'all running'),
            agents.length
              ? el('button', { class: 'link small', 'data-focus': `agents/${n.name}`, 'aria-expanded': String(showAgents), onclick: () => { showAgents = !showAgents; render(); } }, showAgents ? 'Hide agent list' : 'Show agent list')
              : null
          ),
          showAgents ? rows(agents) : null,
          groupHead(`User pods (${user.length})`, user, nsHint(user)),
          user.length ? rows(user) : el('p', { class: 'muted small empty' }, 'No user pods on this node.'),
          system.length ? [groupHead(`System pods (${system.length})`, system, nsHint(system)), rows(system)] : null,
        ]
      : null
  );
}

function soleNamespace(list: PodView[]) {
  const set = new Set(list.map(p => p.namespace));
  return set.size === 1 ? [...set][0] : undefined;
}

function nsHint(list: PodView[]) {
  const ns = soleNamespace(list);
  return ns ? el('span', { class: 'muted small' }, `in ${ns}`) : null;
}

function usage(label: string, req: number | undefined, alloc: number, fmt: (n: number) => string, unit: string) {
  const text =
    req === undefined
      ? `requests unknown, ${fmt(alloc)} ${unit} allocatable`
      : `${fmt(req)} / ${fmt(alloc)} ${unit} requested, ` +
        (req > alloc ? `over by ${fmt(req - alloc)}` : `${fmt(alloc - req)} unallocated`);
  const pct = req === undefined || alloc <= 0 ? 0 : Math.min(100, (req / alloc) * 100);
  return el(
    'div',
    { class: 'usage small' },
    el('span', null, label),
    el('span', { class: `bar${req !== undefined && req > alloc ? ' over' : ''}` }, el('span', { style: `width: ${pct}%` })),
    el('span', { class: 'muted' }, text)
  );
}

function groupHead(label: string, list: PodView[], ...extra: Array<Node | null>) {
  const r = sumRequests(list.filter(p => p.counts));
  return el(
    'h3',
    null,
    label,
    extra,
    list.length ? el('span', { class: 'muted right' }, `${cores(r.cpu)} cores, ${gib(r.mem)} GiB`) : null
  );
}

function podRow(p: PodView, color?: string, showNamespace = true) {
  const cls = p.faded ? 'pod faded' : 'pod';
  return el(
    'div',
    { class: cls, style: color ? `border-left-color: ${color}` : undefined, title: `${p.namespace}/${p.name}: ${p.reason}` },
    el('span', { class: `dot s-${p.status || 'none'}`, 'aria-hidden': 'true' }),
    el('button', { class: 'link name', 'data-focus': `pod/${p.key}`, onclick: () => openDetails(p) }, p.workload),
    el('span', { class: 'muted small' }, p.instance),
    showNamespace ? el('span', { class: 'muted small' }, p.namespace) : null,
    p.reason !== 'Running' && p.reason !== 'Succeeded' ? el('span', { class: `s-${p.status || 'none'}` }, p.reason) : null,
    el('span', { class: 'muted small right' }, podRequestsText(p.requests))
  );
}

function openDetails(view: PodView) {
  const pod = pods.items.get(view.key);
  const dialog = $('details') as HTMLDialogElement;
  const refs = pod?.metadata.ownerReferences ?? [];
  const owner = refs.find(o => o.controller) ?? refs[0];
  const containers = (pod?.spec?.containers ?? []) as Array<{ name?: string; image?: string }>;
  const row = (k: string, v: string) => [el('dt', null, k), el('dd', null, v)];
  dialog.replaceChildren(
    el('h2', null, view.name),
    el(
      'dl',
      null,
      row('Namespace', view.namespace),
      row('Node', pod?.spec?.nodeName ?? 'not scheduled'),
      row('Status', view.reason),
      row('Requests', podRequestsText(view.requests)),
      owner ? row('Owner', `${owner.kind} ${owner.name}`) : null,
      containers.map(c => row(`Container ${c.name ?? ''}`, c.image ?? ''))
    ),
    el('form', { method: 'dialog' }, el('button', null, 'Close'))
  );
  dialog.showModal();
}

($('pool') as HTMLSelectElement).addEventListener('change', e => {
  pool = (e.target as HTMLSelectElement).value;
  setParam('pool', pool);
  render();
});

fetch('context.json')
  .then(r => (r.ok ? r.json() : null))
  .then((c: { context?: string } | null) => {
    if (c?.context) {
      $('context').textContent = c.context;
      document.title = `${c.context} · aks-inspector`;
    }
  })
  .catch(() => undefined);

watch('/api/v1/nodes', nodes);
watch('/api/v1/pods', pods);
