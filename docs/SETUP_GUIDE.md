# Open-Inspect Setup Guide

This is the primary setup guide for users and contributors.

It is organized by goal so you can pick the fastest path:

| Path   | Best For                                                 | Time       |
| ------ | -------------------------------------------------------- | ---------- |
| Path A | Run the web app locally against an existing backend      | ~10-20 min |
| Path B | Contribute code locally (lint/typecheck/tests)           | ~15-30 min |
| Path C | Deploy your own full stack (Cloudflare + Modal + Vercel) | ~1-3 hours |

## Important Context

Open-Inspect is designed for **single-tenant** use. Everyone in your deployment shares the same
GitHub App installation scope. Read the security model in [README.md](../README.md) before
production use.

## Prerequisites

Required:

- Node.js `22+` (minimum supported: `20+`)
- npm
- Git

Optional (needed for `modal-infra` development):

- Python `3.12+`
- `uv` (recommended) or `pip`
- Modal CLI (`modal`)

Optional (needed for local Docker sandboxes):

- Docker Desktop, or Docker Engine `20.10+` on Linux for `host-gateway` networking

Optional (needed for full deployment):

- Terraform `1.6+`
- Wrangler CLI

Quick check:

```bash
node -v
npm -v
git --version
```

## Step 0: Bootstrap the Repo

From repository root:

```bash
bash .openinspect/setup.sh
```

What this does:

- installs JS dependencies
- builds `@open-inspect/shared`
- installs git hooks
- sets up Python env for `packages/modal-infra` when possible

## Path A: Run the Web App Locally (Recommended Quick Start)

Use this when you already have a deployed control plane and Modal backend, and only need local UI
development.

### 1. Create local env file

```bash
cp packages/web/.env.example packages/web/.env.local
```

### 2. Fill required variables

Edit `packages/web/.env.local`:

```bash
# GitHub App OAuth
GITHUB_CLIENT_ID=your_github_app_client_id
GITHUB_CLIENT_SECRET=your_github_app_client_secret

# NextAuth
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=your_generated_secret

# Backend endpoints (deployed)
CONTROL_PLANE_URL=https://open-inspect-control-plane-<name>.<subdomain>.workers.dev
NEXT_PUBLIC_WS_URL=wss://open-inspect-control-plane-<name>.<subdomain>.workers.dev

# Must match control-plane INTERNAL_CALLBACK_SECRET
INTERNAL_CALLBACK_SECRET=your_shared_secret

# Optional access control
ALLOWED_USERS=
ALLOWED_EMAIL_DOMAINS=
```

Do not commit `packages/web/.env.local`.

Generate a secret value:

```bash
openssl rand -base64 32
```

If you are using someone else's deployed backend, do not generate your own
`INTERNAL_CALLBACK_SECRET`. Use the value configured in that backend deployment.

### 3. Configure GitHub callback URL

In GitHub App settings, include:

`http://localhost:3000/api/auth/callback/github`

If this does not match exactly, sign-in will fail.

### 4. Run the app

```bash
npm run dev -w @open-inspect/web
```

Open `http://localhost:3000`.

### 5. Verify it works

1. Sign in with GitHub.
2. Open or create a session.
3. Send a prompt.
4. Confirm live events stream in the session page.

If session actions fail, validate:

- `CONTROL_PLANE_URL`
- `NEXT_PUBLIC_WS_URL`
- `INTERNAL_CALLBACK_SECRET`

These must align with your deployed backend.

## Path B: Contributor Local Workflow

Use this for day-to-day engineering work in the monorepo.

### JavaScript/TypeScript workflow

```bash
# Build shared first if it changed
npm run build -w @open-inspect/shared

# Monorepo checks
npm run lint
npm run typecheck
npm test
```

### Targeted test commands

```bash
# Control plane
npm test -w @open-inspect/control-plane
npm run test:integration -w @open-inspect/control-plane

# Web
npm test -w @open-inspect/web

# Bots
npm test -w @open-inspect/github-bot
npm test -w @open-inspect/slack-bot
npm test -w @open-inspect/linear-bot
```

### Python (`modal-infra`) workflow

```bash
cd packages/modal-infra

# preferred (sandbox-runtime resolved automatically via uv.lock)
uv sync --frozen --extra dev

# alternative (install sandbox-runtime sibling package first)
pip install -e ../sandbox-runtime
pip install -e ".[dev]"

pytest tests/ -v
```

### Local Docker sandbox service

Use this when you want the local control plane to spawn sandboxes through Docker instead of Modal or
Daytona.

Prerequisites:

- Docker Engine or Docker Desktop
- A locally running control plane
- API keys for the agent model provider you want to use, such as `ANTHROPIC_API_KEY` or
  `OPENAI_API_KEY`

Run the Docker sandbox API on the host from the repository root:

```bash
npm run dev:docker-sandbox-api
```

The script optionally loads root `.env.local`, forwards model API keys listed in
`DOCKER_SANDBOX_PASSTHROUGH_ENV_VARS`, uses the host Docker CLI, and builds
`open-inspect-sandbox-runtime:local` on startup if it does not already exist. If you want the Docker
API process to load local API keys, create root `.env.local` with values like:

```bash
DOCKER_SANDBOX_API_TOKEN=local-docker-sandbox-token
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
```

You can also provide these through the shell environment. To disable startup builds, set
`DOCKER_SANDBOX_BUILD_ON_STARTUP=false`.

Configure the local control plane with Docker as its sandbox provider:

```bash
SANDBOX_PROVIDER=docker
DOCKER_SANDBOX_API_URL=http://127.0.0.1:8788
DOCKER_SANDBOX_API_TOKEN=local-docker-sandbox-token
CONTROL_PLANE_URL=http://host.docker.internal:8787
WORKER_URL=http://host.docker.internal:8787
```

If you set `DOCKER_SANDBOX_API_TOKEN` for the Docker API process, the control-plane value must
match.

For sandbox callbacks back to the local control plane, set the control-plane URL given to sandboxes
to `http://host.docker.internal:<control-plane-port>`. Docker Desktop provides this hostname on
macOS and Windows. The sandbox API also adds Docker's `host-gateway` mapping so the same hostname
works on Linux Docker Engine 20.10+.

Useful optional variables:

- `DOCKER_SANDBOX_API_TOKEN`: bearer token required by the Docker sandbox API
- `DOCKER_SANDBOX_MAX_AGE_SECONDS`: fallback max sandbox lifetime, defaults to `7200`
- `DOCKER_SANDBOX_REAP_INTERVAL_MS`: expired container cleanup interval, defaults to `60000`
- `DOCKER_SANDBOX_BUILD_ON_STARTUP`: set to `false` to skip image build on API startup
- `DOCKER_SANDBOX_DOCKERFILE`: override the sandbox runtime Dockerfile path

Useful cleanup commands:

```bash
# List local Docker sandbox containers
npm run docker:sandboxes:list

# Remove stopped sandboxes and expired running sandboxes
npm run docker:sandboxes:clean

# Remove every local sandbox container, including running ones
npm run docker:sandboxes:clean -- --all

# Also remove local sandbox images
npm run docker:sandboxes:clean -- --all --images
```

## Path C: Full Self-Hosted Deployment

For full infrastructure setup, use:

- [docs/GETTING_STARTED.md](./GETTING_STARTED.md)

Critical notes before deploy:

- Build workers before running Terraform apply.
- Build `@open-inspect/shared` first.
- Use two-phase Terraform deploy for DO/service bindings.
- Deploy Modal with `modal deploy deploy.py` (not `src/app.py`).

## Common Issues and Fixes

### OAuth error: `redirect_uri is not associated with this application`

Your GitHub callback URL does not exactly match the running app URL.

### Access denied after sign-in

Check `ALLOWED_USERS` and `ALLOWED_EMAIL_DOMAINS` in `packages/web/.env.local`.

### Web can load, but session APIs return 401

`INTERNAL_CALLBACK_SECRET` in web env does not match the control plane secret.

### WebSocket disconnects immediately

For deployed control plane use `wss://...`, for local control plane use `ws://...`.

### Prompts queue but no sandbox work happens

Control plane cannot reach Modal (or Modal is not properly configured/deployed).

## Related Docs

- Architecture and internals: [docs/HOW_IT_WORKS.md](./HOW_IT_WORKS.md)
- Full production deployment: [docs/GETTING_STARTED.md](./GETTING_STARTED.md)
- Debugging and observability: [docs/DEBUGGING_PLAYBOOK.md](./DEBUGGING_PLAYBOOK.md)
- OpenAI model setup: [docs/OPENAI_MODELS.md](./OPENAI_MODELS.md)
- Contribution workflow: [CONTRIBUTING.md](../CONTRIBUTING.md)
