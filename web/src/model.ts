/**
 * Pure logic for the node view: Kubernetes JSON in, view values out. No UI imports.
 * Copied from aks-viz plugin/src/model.ts; keep the two in step.
 */

type ResourceMap = Record<string, string | undefined>;
type Condition = { type: string; status: string };
interface Container {
  name?: string;
  restartPolicy?: string;
  resources?: { requests?: ResourceMap };
}
interface ContainerStatus {
  state?: { waiting?: { reason?: string }; terminated?: { reason?: string; exitCode?: number } };
}

export interface NodeJson {
  metadata: { name: string; labels?: Record<string, string> };
  spec?: { unschedulable?: boolean };
  status?: { allocatable?: ResourceMap; conditions?: Condition[] };
}

export interface PodJson {
  metadata: {
    name: string;
    namespace?: string;
    uid?: string;
    deletionTimestamp?: string;
    ownerReferences?: Array<{ kind: string; name: string; controller?: boolean }>;
  };
  spec?: {
    nodeName?: string;
    containers?: Container[];
    initContainers?: Container[];
    overhead?: ResourceMap;
    resources?: { requests?: ResourceMap };
  };
  status?: {
    phase?: string;
    reason?: string;
    conditions?: Condition[];
    containerStatuses?: ContainerStatus[];
    initContainerStatuses?: ContainerStatus[];
  };
}

/** CPU in millicores, memory in bytes. */
export interface CpuMem {
  cpu: number;
  mem: number;
}

const SUFFIX: Record<string, number> = {
  n: 1e-9,
  u: 1e-6,
  m: 1e-3,
  '': 1,
  k: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  E: 1e18,
  Ki: 2 ** 10,
  Mi: 2 ** 20,
  Gi: 2 ** 30,
  Ti: 2 ** 40,
  Pi: 2 ** 50,
  Ei: 2 ** 60,
};

/** Kubernetes resource.Quantity in base units (cores, bytes); 0 when it does not parse. */
export function parseQuantity(q?: string): number {
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+))([eE][+-]?\d+|[a-zA-Z]*)$/.exec(q?.trim() ?? '');
  if (!m) return 0;
  const mult = /^[eE]\d|^[eE][+-]/.test(m[2]) ? 10 ** Number(m[2].slice(1)) : SUFFIX[m[2]];
  return mult === undefined ? 0 : Number(m[1]) * mult;
}

const cpuMem = (r?: ResourceMap): CpuMem => ({
  cpu: Math.round(parseQuantity(r?.cpu) * 1e6) / 1e3,
  mem: Math.round(parseQuantity(r?.memory)),
});
const add = (a: CpuMem, b: CpuMem): CpuMem => ({ cpu: a.cpu + b.cpu, mem: a.mem + b.mem });
const max = (a: CpuMem, b: CpuMem): CpuMem => ({
  cpu: Math.max(a.cpu, b.cpu),
  mem: Math.max(a.mem, b.mem),
});
export const sumRequests = (pods: Array<{ requests: CpuMem }>) =>
  pods.reduce((acc, p) => add(acc, p.requests), { cpu: 0, mem: 0 });

/**
 * Effective requests as the scheduler counts them (PodRequests in k8s.io/component-helpers/resource):
 * app containers plus sidecars (init containers with restartPolicy Always); each regular init
 * container counts with the sidecars started before it, and the max of both paths wins; pod-level
 * spec.resources.requests replace the aggregate per resource; spec.overhead is added.
 */
export function podRequests(pod: PodJson): CpuMem {
  const spec = pod.spec ?? {};
  let reqs = sumRequests(
    (spec.containers ?? []).map(c => ({ requests: cpuMem(c.resources?.requests) }))
  );
  let sidecars: CpuMem = { cpu: 0, mem: 0 };
  let initMax: CpuMem = { cpu: 0, mem: 0 };
  for (const c of spec.initContainers ?? []) {
    const own = cpuMem(c.resources?.requests);
    if (c.restartPolicy === 'Always') {
      reqs = add(reqs, own);
      sidecars = add(sidecars, own);
      initMax = max(initMax, sidecars);
    } else {
      initMax = max(initMax, add(own, sidecars));
    }
  }
  reqs = max(reqs, initMax);
  const podLevel = spec.resources?.requests;
  if (podLevel) {
    const pl = cpuMem(podLevel);
    reqs = {
      cpu: podLevel.cpu !== undefined ? pl.cpu : reqs.cpu,
      mem: podLevel.memory !== undefined ? pl.mem : reqs.mem,
    };
  }
  return add(reqs, cpuMem(spec.overhead));
}

export type PoolSource = 'nap' | 'agentpool' | 'unknown';
export interface Pool {
  /** `<source>/<name>`, so a NAP NodePool and an agent pool with the same name stay apart. */
  id: string;
  name: string;
  source: PoolSource;
  mode: 'System' | 'User' | 'Unknown';
  nodes: number;
}

/** karpenter.sh/nodepool wins: NAP nodes on AKS also carry an empty kubernetes.azure.com/agentpool. */
export function poolOf(node: NodeJson): { id: string; name: string; source: PoolSource } {
  const labels = node.metadata.labels ?? {};
  const nap = labels['karpenter.sh/nodepool'];
  const ap = labels['kubernetes.azure.com/agentpool'];
  if (nap) return { id: `nap/${nap}`, name: nap, source: 'nap' };
  if (ap) return { id: `agentpool/${ap}`, name: ap, source: 'agentpool' };
  return { id: 'unknown/(no pool label)', name: '(no pool label)', source: 'unknown' };
}

function modeOf(node: NodeJson): Pool['mode'] {
  const v = (node.metadata.labels?.['kubernetes.azure.com/mode'] ?? '').toLowerCase();
  return v === 'system' ? 'System' : v === 'user' ? 'User' : 'Unknown';
}

/** Pools sorted by name. A pool is System if any node says so, else User if any node says so. */
export function listPools(nodes: NodeJson[]): Pool[] {
  const byId = new Map<string, Pool>();
  for (const n of nodes) {
    const ref = poolOf(n);
    const pool: Pool = byId.get(ref.id) ?? { ...ref, mode: 'Unknown', nodes: 0 };
    byId.set(ref.id, pool);
    pool.nodes++;
    const mode = modeOf(n);
    if (mode === 'System' || (mode === 'User' && pool.mode === 'Unknown')) pool.mode = mode;
  }
  return [...byId.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source)
  );
}

/** NAP NodePool "default", else the first System-mode agent pool, else the first pool. */
export function defaultPool(pools: Pool[]): Pool | undefined {
  return (
    pools.find(p => p.source === 'nap' && p.name === 'default') ??
    pools.find(p => p.source === 'agentpool' && p.mode === 'System') ??
    pools[0]
  );
}

export type UiStatus = 'success' | 'warning' | 'error' | '';

/**
 * Status color and short reason. Error: Failed, or a container waiting or exited with an error
 * (CrashLoopBackOff, ImagePullBackOff, Error, ...). Success: Succeeded, or Running and Ready.
 * Warning: Running but not Ready. Neutral: Pending, ContainerCreating, PodInitializing, Unknown.
 */
export function podStatus(pod: PodJson): { status: UiStatus; reason: string } {
  const st = pod.status ?? {};
  const problemOf = (c: ContainerStatus) => {
    const t = c.state?.terminated;
    return (
      c.state?.waiting?.reason ??
      (t && t.exitCode !== 0 ? t.reason || `ExitCode:${t.exitCode}` : undefined)
    );
  };
  const init = (st.initContainerStatuses ?? [])
    .map(problemOf)
    .find(r => r && r !== 'PodInitializing');
  const problem = init ? `Init:${init}` : (st.containerStatuses ?? []).map(problemOf).find(Boolean);
  const phase = st.phase ?? 'Unknown';
  const reason = pod.metadata.deletionTimestamp ? 'Terminating' : problem ?? (st.reason || phase);
  const ready = (st.conditions ?? []).some(c => c.type === 'Ready' && c.status === 'True');
  let status: UiStatus = '';
  if (phase === 'Failed' || (problem && !/ContainerCreating|PodInitializing/.test(problem))) {
    status = 'error';
  } else if (phase === 'Succeeded' || (phase === 'Running' && ready)) {
    status = 'success';
  } else if (phase === 'Running') {
    status = 'warning';
  }
  return { status, reason };
}

const SYSTEM_NAMESPACES = [
  'kube-system',
  'kube-node-lease',
  'kube-public',
  'gatekeeper-system',
  'calico-system',
  'tigera-operator',
  'app-routing-system',
];

export interface PodView {
  name: string;
  namespace: string;
  key: string;
  /** agent: owned by a DaemonSet. system: system namespace (kube-*, aks-*, listed). user: the rest. */
  group: 'agent' | 'system' | 'user';
  /** Name a person recognizes: Deployment (ReplicaSet without hash), DaemonSet, Job, owner or pod. */
  workload: string;
  /** Rest of the pod name, for example "2ch9b" or "0". */
  instance: string;
  requests: CpuMem;
  /** Succeeded and Failed pods no longer hold node resources. */
  counts: boolean;
  status: UiStatus;
  reason: string;
  faded: boolean;
}

export function toPodView(pod: PodJson): PodView {
  const { name, namespace = '', uid, ownerReferences = [] } = pod.metadata;
  const owner = ownerReferences.find(o => o.controller) ?? ownerReferences[0];
  const phase = pod.status?.phase;
  let workload = owner?.name ?? name;
  // ReplicaSet hashes use an alphabet without vowels; CronJob Jobs end in a minute timestamp.
  if (owner?.kind === 'ReplicaSet')
    workload = workload.replace(/-[bcdfghjklmnpqrstvwxz2456789]{5,10}$/, '');
  if (owner?.kind === 'Job') workload = workload.replace(/-\d{8,}$/, '');
  if (owner?.kind === 'Node') workload = name.replace(`-${pod.spec?.nodeName}`, '');
  const rest = name.startsWith(`${workload}-`) ? name.slice(workload.length + 1) : '';
  const isSystem = SYSTEM_NAMESPACES.includes(namespace) || /^(aks|kube)-/.test(namespace);
  return {
    name,
    namespace,
    key: uid ?? `${namespace}/${name}`,
    group: owner?.kind === 'DaemonSet' ? 'agent' : isSystem ? 'system' : 'user',
    workload,
    instance: owner?.kind === 'Node' ? '' : rest.split('-').pop() ?? '',
    requests: podRequests(pod),
    counts: phase !== 'Succeeded' && phase !== 'Failed',
    ...podStatus(pod),
    faded: phase === 'Succeeded' || !!pod.metadata.deletionTimestamp,
  };
}

export interface NodeView {
  name: string;
  pool: string;
  mode: Pool['mode'];
  ready: boolean;
  cordoned: boolean;
  allocatable: CpuMem;
  /** Null when the pod list failed: requests are unknown, not zero. */
  requested: CpuMem | null;
  /** Problems first (error, warning, neutral, success), then workload and pod name. */
  pods: PodView[];
}

const RANK: Record<UiStatus, number> = { error: 0, warning: 1, '': 2, success: 3 };

/** Pools, and the nodes of the selected pool (the default pool when poolId is absent or unknown). */
export function buildView(nodes: NodeJson[], pods: PodJson[] | null, poolId?: string) {
  const pools = listPools(nodes);
  const defaultPoolId = defaultPool(pools)?.id;
  const selectedPoolId = pools.some(p => p.id === poolId) ? poolId : defaultPoolId;
  const byNode = new Map<string, PodView[]>();
  for (const p of pods ?? []) {
    const n = p.spec?.nodeName;
    if (n) byNode.set(n, [...(byNode.get(n) ?? []), toPodView(p)]);
  }
  const shown: NodeView[] = nodes
    .filter(n => poolOf(n).id === selectedPoolId)
    .sort((a, b) => a.metadata.name.localeCompare(b.metadata.name))
    .map(n => {
      const ps = (byNode.get(n.metadata.name) ?? []).sort(
        (a, b) =>
          RANK[a.status] - RANK[b.status] ||
          a.workload.localeCompare(b.workload) ||
          a.name.localeCompare(b.name)
      );
      return {
        name: n.metadata.name,
        pool: poolOf(n).name,
        mode: modeOf(n),
        ready: (n.status?.conditions ?? []).some(c => c.type === 'Ready' && c.status === 'True'),
        cordoned: !!n.spec?.unschedulable,
        allocatable: cpuMem(n.status?.allocatable),
        requested: pods ? sumRequests(ps.filter(p => p.counts)) : null,
        pods: ps,
      };
    });
  return { pools, defaultPoolId, selectedPoolId, nodes: shown };
}

/** Identity colors, away from status green, orange and red. */
const WORKLOAD_COLORS = ['#2f6fde', '#0e7f8c', '#c2418c', '#6a3fbf', '#37474f', '#1f8fc4'];

/** A color per non-agent workload that runs on more than one node of the shown pool. */
export function workloadColors(nodes: NodeView[]): Map<string, string> {
  const seen = new Map<string, Set<string>>();
  for (const n of nodes) {
    for (const p of n.pods.filter(p => p.group !== 'agent')) {
      const k = `${p.namespace}/${p.workload}`;
      seen.set(k, (seen.get(k) ?? new Set()).add(n.name));
    }
  }
  const multi = [...seen]
    .filter(([, s]) => s.size > 1)
    .map(([k]) => k)
    .sort();
  return new Map(multi.map((k, i) => [k, WORKLOAD_COLORS[i % WORKLOAD_COLORS.length]]));
}

const trim = (n: number) => Number(n.toFixed(Math.abs(n) < 1 ? 2 : 1)).toString();
export const cores = (millicores: number) => trim(millicores / 1000);
export const gib = (bytes: number) => trim(bytes / 2 ** 30);

/** Manifest style: "250m · 128Mi", "2 · 1.5Gi", or "none". */
export function podRequestsText(r: CpuMem): string {
  if (r.cpu <= 0 && r.mem <= 0) return 'none';
  const cpu = r.cpu % 1000 === 0 ? String(r.cpu / 1000) : `${Math.round(r.cpu)}m`;
  const mem = r.mem < 2 ** 30 ? `${Math.round(r.mem / 2 ** 20)}Mi` : `${trim(r.mem / 2 ** 30)}Gi`;
  return `${cpu} · ${mem}`;
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
