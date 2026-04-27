# Local Web And Control Plane

Run the web app and control plane on your machine while using real GitHub App credentials and real
Modal sandboxes.

## Services

- Web: `http://localhost:3000`
- Control plane: `http://localhost:8787`
- Modal: deployed `open-inspect` app in your Modal workspace
- GitHub: real GitHub App OAuth and installation APIs

## Setup

Complete [Step 0 in SETUP_GUIDE.md](./SETUP_GUIDE.md#step-0-bootstrap-the-repo) first.

1. Copy the root env template:

```bash
cp .env.example .env.local
```

2. Fill in `.env.local` with the real GitHub App, Modal, and app secrets.

Use escaped newlines for `GITHUB_APP_PRIVATE_KEY` because `.env.local` is a single-line env file:

```bash
GITHUB_APP_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
```

3. Expose the local control plane to Modal.

Modal sandboxes run remotely, so they cannot connect back to `localhost:8787` on your machine. Start
a tunnel to the local control plane port:

```bash
ngrok http 8787
```

Update `.env.local` with the tunnel URL:

```bash
CONTROL_PLANE_URL=https://<your-ngrok-host>
NEXT_PUBLIC_WS_URL=wss://<your-ngrok-host>
WORKER_URL=https://<your-ngrok-host>
```

Keep `NEXTAUTH_URL=http://localhost:3000`; the web app still runs locally.

4. Generate package env files:

```bash
npm run dev:env
```

This writes:

- `packages/web/.env.local`
- `packages/control-plane/.dev.vars`

5. Configure Modal secrets from `.env.local`:

```bash
npm run dev:modal-secrets
```

At minimum Modal needs:

- `llm-api-keys`: `ANTHROPIC_API_KEY`
- `github-app`: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_INSTALLATION_ID`
- `internal-api`: `MODAL_API_SECRET`, `INTERNAL_CALLBACK_SECRET`, `ALLOWED_CONTROL_PLANE_HOSTS`,
  `CONTROL_PLANE_URL`

For remote Modal callbacks, `ALLOWED_CONTROL_PLANE_HOSTS` must include the tunnel host. The
`dev:modal-secrets` script derives this from `CONTROL_PLANE_URL` unless you set
`ALLOWED_CONTROL_PLANE_HOSTS` explicitly.

6. Deploy Modal:

```bash
cd packages/modal-infra
uv sync --frozen --extra dev
uv run modal deploy deploy.py
```

7. Apply local D1 migrations:

```bash
npm run dev:db:local
```

8. Run the control plane:

```bash
npm run dev:control-plane
```

9. In another terminal, run the web app:

```bash
npm run dev:web
```

10. Open `http://localhost:3000`.

## GitHub App Callback

Your real GitHub App must include this callback URL for local web auth:

```text
http://localhost:3000/api/auth/callback/github
```

## Notes

- The control plane uses local Wrangler storage for D1, KV, R2, and Durable Objects.
- Modal remains remote, so sandboxes must be able to call back through the tunnel. If the ngrok URL
  changes, update `.env.local`, then rerun `npm run dev:env` and `npm run dev:modal-secrets`.
