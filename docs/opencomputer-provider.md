# OpenComputer Provider

Local OpenComputer development uses a prebuilt snapshot that contains the Open Inspect sandbox
runtime.

## Required control-plane env

Add these to `packages/control-plane/.dev.vars`:

```env
SANDBOX_PROVIDER=opencomputer
OPENCOMPUTER_API_KEY=...
OPENCOMPUTER_SNAPSHOT=open-inspect-runtime-<timestamp>
```

`OPENCOMPUTER_TEMPLATE_ID` is also supported as a fallback, but the recommended path is a named
snapshot with the runtime preinstalled.

`WORKER_URL` must be a public URL when using OpenComputer. Remote sandboxes cannot connect back to
Docker-only hostnames like `http://control-plane:8787` or `http://localhost:8787`.

## Build a runtime snapshot

Run the builder script with the OpenComputer SDK available at execution time:

```bash
OPENCOMPUTER_API_KEY=... \
  npm exec --yes --package=@opencomputer/sdk \
  node scripts/build-opencomputer-runtime-snapshot.mjs
```

Optional snapshot name:

```bash
OPENCOMPUTER_API_KEY=... \
  npm exec --yes --package=@opencomputer/sdk \
  node scripts/build-opencomputer-runtime-snapshot.mjs open-inspect-runtime-my-snapshot
```

The script prints `SNAPSHOT_NAME=...` when the build completes. Copy that value into
`OPENCOMPUTER_SNAPSHOT`.

## Snapshot contents

The generated snapshot:

- installs `opencode-ai`, `@opencode-ai/plugin`, and `zod` into `/workspace/.openinspect-node`
- installs the Python runtime dependencies directly with `pip`
- copies `packages/sandbox-runtime/src/sandbox_runtime` into `/workspace/app/sandbox_runtime`
- sets `PYTHONPATH`, `NODE_PATH`, `PATH`, and `HOME` for the Open Inspect runtime layout

## Runtime start

The control-plane OpenComputer provider launches the runtime with OpenComputer's exec API:

```bash
python -m sandbox_runtime.entrypoint
```

The process runs in `/workspace/app`, and the provider injects the same session env vars used by the
existing Docker and Daytona providers.

## Local Validation Gotcha

OpenComputer runs the sandbox in a remote VM. For end-to-end local development, the control-plane
worker must be reachable from that VM over the public internet. In practice that means setting
`WORKER_URL` to a public tunnel URL from a service like `ngrok` or `cloudflared tunnel`.
