# Open-Inspect Setup Guide

This is the primary setup guide for users and contributors.

It is organized by goal so you can pick the fastest path:

| Path   | Best For                                                 | Time       |
| ------ | -------------------------------------------------------- | ---------- |
| Path A | Run the web app locally against an existing backend      | ~10-20 min |
| Path B | Contribute code locally (lint/typecheck/tests)           | ~15-30 min |
| Path C | Deploy your own full stack (Cloudflare + Modal + Vercel) | ~1-3 hours |
| Path D | Run a local Docker Compose stack (web + control plane)   | ~20-40 min |

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

## Path C: Full Self-Hosted Deployment

For full infrastructure setup, use:

- [docs/GETTING_STARTED.md](./GETTING_STARTED.md)

Critical notes before deploy:

- Build workers before running Terraform apply.
- Build `@open-inspect/shared` first.
- Use two-phase Terraform deploy for DO/service bindings.
- Deploy Modal with `modal deploy deploy.py` (not `src/app.py`).

## Path D: Local Docker Compose Stack

Use this when you want a single local command for the web UI, control plane, and a minimal
Docker-backed sandbox runtime.

What this path includes:

- `web` in Docker on `http://localhost:3000`
- `control-plane` in Docker via `wrangler dev` on `http://localhost:8787`
- local per-session sandbox containers managed by `docker-sandbox-api`

Current scope:

- web UI only
- no Slack/GitHub/Linear bot containers
- no snapshot/restore support for local sandboxes
- code-server and ttyd are not included in the local sandbox image

### 1. Create local env files

```bash
cp .env.compose.example .env
cp packages/control-plane/.dev.vars.example packages/control-plane/.dev.vars
cp packages/web/.env.example packages/web/.env.local
```

### 2. Fill required secrets

At minimum you must set these values in `.env`, `packages/control-plane/.dev.vars`, and
`packages/web/.env.local` as appropriate:

- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `NEXTAUTH_SECRET`
- `INTERNAL_CALLBACK_SECRET`
- `TOKEN_ENCRYPTION_KEY`
- `REPO_SECRETS_ENCRYPTION_KEY`
- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY`
- `GITHUB_APP_INSTALLATION_ID`

Optional model-provider credentials for local sandboxes:

- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `OPENCODE_API_KEY`

Use the same values for shared settings across files. In particular:

- `packages/control-plane/.dev.vars` and `packages/web/.env.local` must share `GITHUB_CLIENT_ID`,
  `GITHUB_CLIENT_SECRET`, and `INTERNAL_CALLBACK_SECRET`
- `packages/control-plane/.dev.vars` should keep: `SANDBOX_PROVIDER=docker` and
  `DOCKER_SANDBOX_API_URL=http://docker-sandbox-api:8788`
- `packages/web/.env.local` should use: `CONTROL_PLANE_URL=http://control-plane:8787` and
  `NEXT_PUBLIC_WS_URL=ws://localhost:8787`
- The root `.env` is also where local sandbox provider API keys should live. The Compose stack
  passes `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `OPENCODE_API_KEY` into `docker-sandbox-api`,
  which injects them into newly created sandbox containers when present.

### 3. Configure GitHub callback URL

In your GitHub App settings include:

`http://localhost:3000/api/auth/callback/github`

### 4. Start the stack

```bash
docker compose up --build
```

### 5. Verify it works

1. Open `http://localhost:3000`
2. Sign in with GitHub
3. Create a session
4. Send a prompt
5. Confirm a sandbox container is created and connects back to the control plane

Useful commands:

```bash
docker compose logs -f web control-plane docker-sandbox-api
docker ps --format '{{.Names}}'
```

### Compose Notes

- The control plane uses the checked-in test Wrangler config for local D1/KV/R2/DO emulation
- Sandbox containers are managed through `/var/run/docker.sock`
- The local sandbox image is built from `packages/sandbox-runtime/Dockerfile.local`
- `docker-sandbox-api` reaps expired local sandbox containers automatically based on sandbox TTL
- If you change dependency manifests or Dockerfiles, rerun `docker compose up --build`

### Manual Docker Cleanup

Local sandbox artifacts are labeled for targeted cleanup:

- containers: `openinspect_framework=open-inspect`, `openinspect_kind=sandbox`,
  `openinspect_env=local`
- images: `openinspect_framework=open-inspect`, `openinspect_kind=sandbox-image`,
  `openinspect_env=local`

Remove local sandbox containers:

```bash
bash scripts/docker-clean-local-sandboxes.sh
```

Remove local sandbox containers and images:

```bash
bash scripts/docker-clean-local-sandboxes.sh --images
```

### Reset The Local Stack

To nuke Compose state and start fresh:

```bash
bash scripts/docker-reset-local-stack.sh
```

That command:

- runs `docker compose down -v --remove-orphans`
- removes local Wrangler/D1 state in `packages/control-plane/.wrangler/state`
- removes local sandbox containers

If you also want to remove local sandbox images:

```bash
bash scripts/docker-reset-local-stack.sh --images
```

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
