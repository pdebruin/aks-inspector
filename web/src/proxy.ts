/** The page reads nodes and pods, nothing else. kubectl proxy enforces that before any request
 * leaves the machine; the RBAC of the kubeconfig identity is the final limit. */
export const API_PATHS = ['^/api/v1/nodes$', '^/api/v1/pods$'];
export const UI_PREFIX = '/ui/';

export function proxyArgs(www: string, context: string, port = 0): string[] {
  return [
    'proxy',
    `--context=${context}`,
    '--address=127.0.0.1',
    `--port=${port}`,
    `--www=${www}`,
    `--www-prefix=${UI_PREFIX}`,
    '--reject-methods=POST,PUT,PATCH,DELETE',
    `--accept-paths=${[...API_PATHS, `^${UI_PREFIX}`].join(',')}`,
  ];
}

/** kubectl proxy prints "Starting to serve on 127.0.0.1:43215". */
export const SERVE_LINE = /Starting to serve on ([\d.]+:\d+)/;
