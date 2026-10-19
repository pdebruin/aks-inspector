# aks-inspector requirements

## Goal

A stand-alone node view for AKS: which pods run on which node, one node pool at a time, and how full each node is. Started with `npx`, uses the local kubeconfig, opens in the browser.

## Basis

- Reuses the view logic of aks-viz, `../aks-viz/plugin/src/model.ts`: requests counted the way the scheduler does, NAP and agent pool detection, pod status, workload names. That file has no Headlamp imports.
- Features follow aks-viz: README section "What it does" and docs/requirements.md.

## Shape

- `npx aks-inspector` starts `kubectl proxy` on a random port on 127.0.0.1, serves the built page as static files through it (`--www`), and opens the browser.
- The browser calls the Kubernetes API through the proxy. No own backend.
- Read-only: the proxy rejects write methods with `--reject-methods`. By default it only accepts localhost host names (kubectl proxy reference, Options).
- The current kubeconfig context is used as is. kubectl handles authentication, including Entra through kubelogin. unsourced reasoning: not tested.
- Needs kubectl on the PATH, and kubelogin for Entra-enabled clusters.

## Live updates

List then watch, one watch for nodes and one for pods in all namespaces (Kubernetes API concepts, section "Efficient detection of changes"):

1. List, for example `GET /api/v1/pods`, and keep the returned `resourceVersion`.
2. Watch from that version with `?watch=1&resourceVersion=<rv>&allowWatchBookmarks=true`. One long-lived HTTP response streams ADDED, MODIFIED, DELETED and BOOKMARK events.
3. On disconnect, watch again from the last seen `resourceVersion`. On `410 Gone`, list again.

Scheduling shows up as a pod MODIFIED event with `spec.nodeName` set. unsourced reasoning: not checked against the scheduler docs.

## Open

- Does a browser `fetch` stream a watch response through kubectl proxy? First spike.
- How to share `model.ts` with aks-viz.
- Pod details: a view of its own, or none.
