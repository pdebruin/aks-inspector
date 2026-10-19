import { describe, expect, it } from 'vitest';
import {
  buildView,
  defaultPool,
  listPools,
  NodeJson,
  parseQuantity,
  PodJson,
  podRequests,
  podStatus,
  poolOf,
  toPodView,
} from './model';

const MI = 2 ** 20;
const ctr = (name: string, cpu?: string, memory?: string, restartPolicy?: string) => ({
  name,
  restartPolicy,
  resources: { requests: { cpu, memory } },
});
const pod = (spec: PodJson['spec'] = {}, extra: Partial<PodJson> = {}): PodJson => ({
  metadata: { name: 'p', namespace: 'x' },
  spec: { containers: [ctr('main', '100m', '128Mi')], ...spec },
  status: { phase: 'Running' },
  ...extra,
});
const node = (name: string, labels: Record<string, string>): NodeJson => ({
  metadata: { name, labels },
  status: { allocatable: { cpu: '4', memory: '8Gi' } },
});
const NAP = (pool: string, mode: string) => ({
  'karpenter.sh/nodepool': pool,
  'kubernetes.azure.com/agentpool': '',
  'kubernetes.azure.com/mode': mode,
});
const AP = (pool: string, mode = 'User') => ({
  'kubernetes.azure.com/agentpool': pool,
  'kubernetes.azure.com/mode': mode,
});

describe('parseQuantity', () => {
  it.each([
    ['250m', 0.25],
    ['2', 2],
    ['128Mi', 128 * MI],
    ['1G', 1e9],
    ['1e3', 1000],
    ['5935076Ki', 5935076 * 1024],
    ['bogus', 0],
    [undefined, 0],
  ])('%s', (q, v) => expect(parseQuantity(q)).toBe(v));
});

describe('podRequests (matches kubectl describe node)', () => {
  it('sums app containers; missing requests count as zero', () => {
    const p = pod({ containers: [ctr('a', '100m', '64Mi'), ctr('b', undefined, '32Mi')] });
    expect(podRequests(p)).toEqual({ cpu: 100, mem: 96 * MI });
  });

  it('takes the max of the largest init container and the app sum, per resource', () => {
    const p = pod({
      containers: [ctr('a', '100m', '64Mi'), ctr('b', '100m', '64Mi')],
      initContainers: [ctr('i1', '500m', '16Mi'), ctr('i2', '50m', '32Mi')],
    });
    expect(podRequests(p)).toEqual({ cpu: 500, mem: 128 * MI });
  });

  it('adds sidecars to the app sum and to later init containers', () => {
    const p = pod({
      containers: [ctr('app', '100m', '100Mi')],
      initContainers: [
        ctr('before', '300m', '10Mi'),
        ctr('sidecar', '50m', '50Mi', 'Always'),
        ctr('after', '300m', '10Mi'),
      ],
    });
    // app path: 100m + 50m sidecar = 150m; init path: max(300m, 300m + 50m) = 350m
    expect(podRequests(p)).toEqual({ cpu: 350, mem: 150 * MI });
  });

  it('adds overhead and honours pod-level requests', () => {
    const p = pod({
      containers: [ctr('a', '100m', '64Mi')],
      overhead: { cpu: '10m', memory: '1Mi' },
      resources: { requests: { cpu: '1' } },
    });
    expect(podRequests(p)).toEqual({ cpu: 1010, mem: 65 * MI });
  });
});

describe('node pools', () => {
  it('prefers karpenter.sh/nodepool over an empty agentpool label', () => {
    expect(poolOf(node('a', NAP('default', 'user'))).id).toBe('nap/default');
    expect(poolOf(node('a', AP('hostedpool'))).id).toBe('agentpool/hostedpool');
    expect(poolOf(node('a', {})).source).toBe('unknown');
  });

  it('lists pools by name with case-insensitive mode', () => {
    const pools = listPools([
      node('h1', AP('hostedpool', 'system')),
      node('h2', AP('hostedpool', 'System')),
      node('d', NAP('default', 'user')),
    ]);
    expect(pools.map(p => [p.id, p.mode, p.nodes])).toEqual([
      ['nap/default', 'User', 1],
      ['agentpool/hostedpool', 'System', 2],
    ]);
  });

  it('defaults to NAP "default", else the first System agent pool, else the first pool', () => {
    const def = (nodes: NodeJson[]) => defaultPool(listPools(nodes))?.id;
    expect(def([node('h', AP('hostedpool', 'System')), node('d', NAP('default', 'user'))])).toBe(
      'nap/default'
    );
    // An agent pool named "default" is not the NAP default.
    expect(def([node('a', AP('default')), node('s', AP('zsys', 'System'))])).toBe('agentpool/zsys');
    expect(def([node('b', AP('b')), node('a', AP('a'))])).toBe('agentpool/a');
    expect(def([])).toBeUndefined();
  });
});

describe('podStatus', () => {
  const waiting = (reason: string, phase = 'Running'): PodJson =>
    pod({}, { status: { phase, containerStatuses: [{ state: { waiting: { reason } } }] } });
  it.each([
    ['CrashLoopBackOff', waiting('CrashLoopBackOff'), 'error'],
    ['ImagePullBackOff', waiting('ImagePullBackOff', 'Pending'), 'error'],
    [
      'Error',
      pod(
        {},
        {
          status: {
            phase: 'Running',
            containerStatuses: [{ state: { terminated: { reason: 'Error', exitCode: 1 } } }],
          },
        }
      ),
      'error',
    ],
    ['ContainerCreating', waiting('ContainerCreating', 'Pending'), ''],
    ['Pending', pod({}, { status: { phase: 'Pending' } }), ''],
    [
      'Running',
      pod({}, { status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } }),
      'success',
    ],
    ['Running', pod({}, { status: { phase: 'Running' } }), 'warning'],
    ['Failed', pod({}, { status: { phase: 'Failed' } }), 'error'],
  ])('%s', (reason, p, status) => expect(podStatus(p)).toEqual({ reason, status }));
});

describe('toPodView', () => {
  it('names the workload: ReplicaSet without hash, and groups DaemonSet pods as agents', () => {
    const owner = (kind: string, name: string) => ({
      ownerReferences: [{ kind, name, controller: true }],
    });
    const rs = toPodView(
      pod(
        {},
        {
          metadata: {
            name: 'api-754ccbf9b5-2ch9b',
            namespace: 'shop',
            ...owner('ReplicaSet', 'api-754ccbf9b5'),
          },
        }
      )
    );
    expect([rs.workload, rs.instance, rs.group]).toEqual(['api', '2ch9b', 'user']);
    const ds = toPodView(
      pod(
        {},
        {
          metadata: {
            name: 'kube-proxy-x',
            namespace: 'kube-system',
            ...owner('DaemonSet', 'kube-proxy'),
          },
        }
      )
    );
    expect([ds.workload, ds.group]).toEqual(['kube-proxy', 'agent']);
  });
});

describe('buildView', () => {
  const nodes = [node('n1', AP('sys', 'System')), node('n2', AP('apps'))];
  const on = (n: string, phase: string) => pod({ nodeName: n }, { status: { phase } });

  it('sums requests of non-terminal pods and falls back to the default pool', () => {
    const v = buildView(
      nodes,
      [
        on('n1', 'Running'),
        on('n1', 'Pending'),
        on('n1', 'Succeeded'),
        on('n1', 'Failed'),
        on('n2', 'Running'),
      ],
      'nope'
    );
    expect(v.selectedPoolId).toBe('agentpool/sys');
    expect(v.nodes.map(n => [n.name, n.pods.length, n.requested])).toEqual([
      ['n1', 4, { cpu: 200, mem: 256 * MI }],
    ]);
  });

  it('reports requests as unknown, not zero, when the pod list failed', () => {
    expect(buildView(nodes, null, 'agentpool/apps').nodes[0].requested).toBeNull();
  });
});
