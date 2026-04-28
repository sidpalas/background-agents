# Open-Inspect Docker Sandbox API

Local development service that creates and stops Open-Inspect sandbox containers through Docker.

The control plane communicates with this service over HTTP instead of talking to the Docker daemon
directly. This keeps Docker daemon access in one host-side process, avoids exposing a Docker socket
to Worker code, and leaves room for a future remote Docker host without changing the control-plane
provider boundary.

```text
┌────────────────────┐      HTTP       ┌────────────────────────┐      Docker CLI     ┌────────────────────┐
│   Control Plane    │ ──────────────▶ │   Docker Sandbox API   │ ──────────────────▶ │ Sandbox Container  │
│  SandboxProvider   │                 │  packages/docker-...   │                     │ sandbox-runtime    │
└────────────────────┘                 └────────────────────────┘                     └────────────────────┘
```

## Scope

- `src/index.ts` exposes `/health`, `POST /sandboxes`, and `POST /sandboxes/:id/stop`.
- `scripts/docker-sandbox-api.mjs` loads `.env.local` and starts this package with local defaults.
- `packages/sandbox-runtime/Dockerfile.sandbox` defines the sandbox image.
- Cleanup scripts list/remove containers by Open-Inspect labels.

This first version intentionally keeps lifecycle simple: create a fresh container, then destroy it
on stop. Containers are created with `--rm`; there is no persistent resume. Adding resume later
would require keeping stopped containers, adding inspect/start/resume endpoints, implementing
`resumeSandbox`, and changing cleanup semantics.

It also does not expose code-server, ttyd, or arbitrary tunnel ports yet. Supporting those would
require installing the sidecar binaries in the sandbox image, publishing container ports, and
returning host URLs from the Docker provider.

The API currently shells out to `docker` with `execFile`. That avoids shell interpolation and maps
directly to Docker CLI commands. If this becomes production-facing, revisit Dockerode or a small Go
service using Docker's official Go SDK. That would add typed Docker API models, structured daemon
errors, and better support for remote Docker hosts.

## Usage

From the repository root:

```bash
npm run dev:docker-sandbox-api
```

The launcher optionally reads root `.env.local`. Use that file, or shell env vars, for values needed
by the Docker API process and by sandbox containers:

```env
DOCKER_SANDBOX_API_TOKEN=local-docker-sandbox-token
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
```

Configure the local control plane with:

```env
SANDBOX_PROVIDER=docker
DOCKER_SANDBOX_API_URL=http://127.0.0.1:8788
DOCKER_SANDBOX_API_TOKEN=local-docker-sandbox-token
```

If `DOCKER_SANDBOX_API_TOKEN` is set for this API, the control-plane value must match.

Docker sandboxes call back to the host control plane via `host.docker.internal`:

```env
CONTROL_PLANE_URL=http://host.docker.internal:8787
WORKER_URL=http://host.docker.internal:8787
NEXT_PUBLIC_WS_URL=ws://localhost:8787
```

Docker Desktop provides `host.docker.internal`. On Linux, the API adds Docker's `host-gateway`
mapping, which is expected to require Docker Engine 20.10 or newer.

## Environment

- `PORT` - API port, defaults to `8788`
- `DOCKER_SANDBOX_API_TOKEN` - optional bearer token for API requests
- `DOCKER_SANDBOX_IMAGE` - sandbox image, defaults to `open-inspect-sandbox-runtime:local`
- `DOCKER_SANDBOX_BUILD_ON_STARTUP` - set `false` to skip startup image build
- `DOCKER_SANDBOX_DOCKERFILE` - sandbox Dockerfile path
- `DOCKER_SANDBOX_NETWORK` - optional `docker run --network` value
- `DOCKER_SANDBOX_PASSTHROUGH_ENV_VARS` - comma-separated host env vars copied into containers
- `DOCKER_SANDBOX_REAP_INTERVAL_MS` - expiry cleanup interval, defaults to `60000`
- `DOCKER_SANDBOX_MAX_AGE_SECONDS` - fallback max sandbox age, defaults to `7200`

## Development

```bash
npm run typecheck -w @open-inspect/docker-sandbox-api
npx eslint packages/docker-sandbox-api/src/index.ts scripts/docker-sandbox-api.mjs
npm test -w @open-inspect/control-plane -- \
  src/sandbox/docker-client.test.ts \
  src/sandbox/provider-name.test.ts \
  src/sandbox/providers/docker-provider.test.ts
```
