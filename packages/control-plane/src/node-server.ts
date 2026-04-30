import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import pg from "pg";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import {
  listInstallationRepositories,
  listRepositoryBranches,
  getGitHubAppConfig,
} from "./auth/github-app";
import {
  DEFAULT_ENABLED_MODELS,
  verifyInternalToken,
  type SandboxEvent,
  type SandboxStatus,
  type SessionStatus,
  type SessionState,
} from "@open-inspect/shared";
import { ModalClient } from "./sandbox/client";

const DEFAULT_PORT = 3000;
const PROCESSING_PROMPT_RECOVERY_DELAY_MS = 15_000;
const CONTROL_PLANE_STARTED_AT_MS = Date.now();
const { Pool } = pg;

interface SessionRow {
  id: string;
  title: string | null;
  repo_owner: string;
  repo_name: string;
  model: string;
  reasoning_effort: string | null;
  base_branch: string;
  status: SessionStatus;
  scm_login: string | null;
  sandbox_id: string | null;
  sandbox_auth_token: string | null;
  modal_object_id: string | null;
  sandbox_status: string | null;
  sandbox_error: string | null;
  created_at: number;
  updated_at: number;
}

interface PendingPrompt {
  messageId: string;
  content: string;
  model?: string;
  reasoningEffort?: string;
}

interface MessageRow {
  id: string;
  session_id: string;
  author_id: string;
  content: string;
  source: string;
  model: string | null;
  reasoning_effort: string | null;
  attachments: string | null;
  status: "pending" | "processing" | "completed" | "failed";
  error_message: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
}

interface EventRow {
  id: string;
  session_id: string;
  type: string;
  data: string;
  message_id: string | null;
  created_at: number;
}

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL })
  : null;

const webClients = new Map<string, Set<WebSocket>>();
const sandboxSockets = new Map<string, WebSocket>();
const sandboxReadySessions = new Set<string>();
const MAX_REPLAY_EVENTS = 500;

let schemaReady: Promise<void> | null = null;

function getPort(): number {
  const value = process.env.PORT;
  if (!value) return DEFAULT_PORT;

  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port <= 0) return DEFAULT_PORT;
  return port;
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Access-Control-Allow-Origin": "*",
  });
  res.end(payload);
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return (raw ? JSON.parse(raw) : {}) as T;
}

function getPool(): pg.Pool {
  if (!pool) {
    throw new Error("DATABASE_URL is not configured");
  }
  return pool;
}

async function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = getPool()
      .query(
        `
      CREATE TABLE IF NOT EXISTS railway_sessions (
        id TEXT PRIMARY KEY,
        title TEXT,
        repo_owner TEXT NOT NULL,
        repo_name TEXT NOT NULL,
        model TEXT NOT NULL,
        reasoning_effort TEXT,
        base_branch TEXT NOT NULL,
        status TEXT NOT NULL,
        scm_login TEXT,
        sandbox_id TEXT,
        sandbox_auth_token TEXT,
        modal_object_id TEXT,
        sandbox_status TEXT,
        sandbox_error TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );

      ALTER TABLE railway_sessions ADD COLUMN IF NOT EXISTS sandbox_id TEXT;
      ALTER TABLE railway_sessions ADD COLUMN IF NOT EXISTS sandbox_auth_token TEXT;
      ALTER TABLE railway_sessions ADD COLUMN IF NOT EXISTS modal_object_id TEXT;
      ALTER TABLE railway_sessions ADD COLUMN IF NOT EXISTS sandbox_status TEXT;
      ALTER TABLE railway_sessions ADD COLUMN IF NOT EXISTS sandbox_error TEXT;

      CREATE INDEX IF NOT EXISTS railway_sessions_updated_at_idx
        ON railway_sessions (updated_at DESC);

      CREATE TABLE IF NOT EXISTS railway_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES railway_sessions(id) ON DELETE CASCADE,
        author_id TEXT NOT NULL,
        content TEXT NOT NULL,
        source TEXT NOT NULL,
        model TEXT,
        reasoning_effort TEXT,
        attachments TEXT,
        status TEXT NOT NULL,
        error_message TEXT,
        created_at BIGINT NOT NULL,
        started_at BIGINT,
        completed_at BIGINT
      );

      CREATE INDEX IF NOT EXISTS railway_messages_session_status_idx
        ON railway_messages (session_id, status, created_at ASC);
      CREATE INDEX IF NOT EXISTS railway_messages_session_created_idx
        ON railway_messages (session_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS railway_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES railway_sessions(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        data TEXT NOT NULL,
        message_id TEXT,
        created_at BIGINT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS railway_events_session_created_idx
        ON railway_events (session_id, created_at ASC, id ASC);
      CREATE INDEX IF NOT EXISTS railway_events_session_message_idx
        ON railway_events (session_id, message_id);
    `
      )
      .then(() => undefined);
  }
  await schemaReady;
}

function toSessionResponse(row: SessionRow) {
  return {
    id: row.id,
    title: row.title,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    baseBranch: row.base_branch,
    branchName: null,
    baseSha: null,
    currentSha: null,
    opencodeSessionId: null,
    status: row.status,
    sandbox: row.sandbox_id
      ? {
          id: row.sandbox_id,
          providerObjectId: row.modal_object_id,
          status: row.sandbox_status,
          error: row.sandbox_error,
        }
      : null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toSessionState(row: SessionRow): SessionState {
  return {
    id: row.id,
    title: row.title,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    baseBranch: row.base_branch,
    branchName: null,
    status: row.status,
    sandboxStatus: (row.sandbox_status ?? "pending") as SandboxStatus,
    messageCount: 0,
    createdAt: Number(row.created_at),
    model: row.model,
    reasoningEffort: row.reasoning_effort ?? undefined,
    isProcessing: false,
    totalCost: 0,
  };
}

async function getSessionRow(sessionId: string): Promise<SessionRow | null> {
  await ensureSchema();
  const result = await getPool().query<SessionRow>(`SELECT * FROM railway_sessions WHERE id = $1`, [
    sessionId,
  ]);
  return result.rows[0] ?? null;
}

function sendWs(ws: WebSocket, message: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function broadcast(sessionId: string, message: unknown): void {
  const clients = webClients.get(sessionId);
  if (!clients) return;

  for (const client of clients) {
    sendWs(client, message);
  }
}

function parseWsJson(data: RawData): unknown {
  const raw = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
  return JSON.parse(raw.toString("utf8"));
}

function getBearerToken(req: IncomingMessage): string | null {
  const authHeader = Array.isArray(req.headers.authorization)
    ? req.headers.authorization[0]
    : req.headers.authorization;
  const match = authHeader?.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

function toEvent(row: EventRow): SandboxEvent | null {
  try {
    return JSON.parse(row.data) as SandboxEvent;
  } catch {
    return null;
  }
}

function getEventMessageId(event: SandboxEvent): string | null {
  return "messageId" in event && typeof event.messageId === "string" ? event.messageId : null;
}

async function createEvent(
  sessionId: string,
  event: SandboxEvent,
  createdAt = Date.now()
): Promise<void> {
  const messageId = getEventMessageId(event);
  const upsertByMessage =
    messageId &&
    (event.type === "token" ||
      event.type === "execution_complete" ||
      event.type === "user_message");
  const eventId = upsertByMessage
    ? `${event.type}:${messageId}`
    : `${event.type}:${crypto.randomUUID()}`;
  await getPool().query(
    `INSERT INTO railway_events (id, session_id, type, data, message_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT(id) DO UPDATE SET data = EXCLUDED.data, message_id = EXCLUDED.message_id, created_at = EXCLUDED.created_at`,
    [eventId, sessionId, event.type, JSON.stringify(event), messageId, createdAt]
  );
}

async function getReplayEvents(sessionId: string): Promise<SandboxEvent[]> {
  const result = await getPool().query<EventRow>(
    `SELECT * FROM railway_events
     WHERE session_id = $1 AND type != 'heartbeat'
     ORDER BY created_at DESC, id DESC
     LIMIT $2`,
    [sessionId, MAX_REPLAY_EVENTS]
  );
  return result.rows
    .reverse()
    .map(toEvent)
    .filter((event): event is SandboxEvent => event !== null);
}

async function sendPromptToSandbox(sessionId: string, prompt: PendingPrompt): Promise<boolean> {
  const sandbox = sandboxSockets.get(sessionId);
  if (!sandbox || sandbox.readyState !== WebSocket.OPEN || !sandboxReadySessions.has(sessionId)) {
    return false;
  }

  sendWs(sandbox, {
    type: "prompt",
    messageId: prompt.messageId,
    content: prompt.content,
    model: prompt.model,
    reasoningEffort: prompt.reasoningEffort,
    author: {},
  });
  await getPool().query(
    `UPDATE railway_messages SET status = 'processing', started_at = $2 WHERE id = $1 AND status = 'pending'`,
    [prompt.messageId, Date.now()]
  );
  broadcast(sessionId, { type: "prompt_queued", messageId: prompt.messageId, position: 1 });
  return true;
}

async function recoverInterruptedProcessingPrompts(sessionId: string): Promise<void> {
  const cutoff = CONTROL_PLANE_STARTED_AT_MS - PROCESSING_PROMPT_RECOVERY_DELAY_MS;
  const result = await getPool().query(
    `UPDATE railway_messages m
     SET status = 'pending', started_at = NULL
     WHERE m.session_id = $1
       AND m.status = 'processing'
       AND COALESCE(m.started_at, 0) < $2
       AND NOT EXISTS (
         SELECT 1 FROM railway_events e
         WHERE e.session_id = m.session_id
           AND e.message_id = m.id
           AND e.type = 'execution_complete'
       )`,
    [sessionId, cutoff]
  );
  if ((result.rowCount ?? 0) > 0) {
    console.log(
      JSON.stringify({
        event: "prompt.recovered_processing",
        session_id: sessionId,
        count: result.rowCount,
      })
    );
  }
}

async function processNextPendingPrompt(sessionId: string): Promise<void> {
  const processing = await getPool().query(
    `SELECT id FROM railway_messages WHERE session_id = $1 AND status = 'processing' LIMIT 1`,
    [sessionId]
  );
  if ((processing.rowCount ?? 0) > 0) return;

  const result = await getPool().query<MessageRow>(
    `SELECT * FROM railway_messages WHERE session_id = $1 AND status = 'pending' ORDER BY created_at ASC LIMIT 1`,
    [sessionId]
  );
  const message = result.rows[0];
  if (!message) return;

  await sendPromptToSandbox(sessionId, {
    messageId: message.id,
    content: message.content,
    model: message.model ?? undefined,
    reasoningEffort: message.reasoning_effort ?? undefined,
  });
}

function createModalClient(): ModalClient | null {
  const secret = process.env.MODAL_API_SECRET;
  const workspace = process.env.MODAL_WORKSPACE;
  if (!secret || !workspace) return null;
  return new ModalClient(secret, workspace);
}

async function spawnModalSandbox(input: {
  sessionId: string;
  sandboxId: string;
  repoOwner: string;
  repoName: string;
  branch: string;
  model: string;
}): Promise<void> {
  const client = createModalClient();
  if (!client) {
    await getPool().query(
      `UPDATE railway_sessions SET sandbox_status = 'failed', sandbox_error = $2, updated_at = $3 WHERE id = $1`,
      [input.sessionId, "Modal credentials are not configured", Date.now()]
    );
    return;
  }

  const controlPlaneUrl = process.env.WORKER_URL || process.env.CONTROL_PLANE_URL;
  if (!controlPlaneUrl) {
    await getPool().query(
      `UPDATE railway_sessions SET sandbox_status = 'failed', sandbox_error = $2, updated_at = $3 WHERE id = $1`,
      [input.sessionId, "Control plane URL is not configured", Date.now()]
    );
    return;
  }

  try {
    const sandboxAuthToken = crypto.randomUUID();
    await getPool().query(
      `UPDATE railway_sessions
       SET sandbox_id = $2, sandbox_auth_token = $3, sandbox_status = 'spawning', sandbox_error = NULL, updated_at = $4
       WHERE id = $1`,
      [input.sessionId, input.sandboxId, sandboxAuthToken, Date.now()]
    );
    broadcast(input.sessionId, { type: "sandbox_spawning" });

    const result = await client.createSandbox(
      {
        sessionId: input.sessionId,
        sandboxId: input.sandboxId,
        repoOwner: input.repoOwner,
        repoName: input.repoName,
        controlPlaneUrl,
        sandboxAuthToken,
        provider: "anthropic",
        model: input.model,
        branch: input.branch,
      },
      {
        trace_id: crypto.randomUUID(),
        request_id: crypto.randomUUID().slice(0, 8),
        session_id: input.sessionId,
        sandbox_id: input.sandboxId,
      }
    );

    await getPool().query(
      `UPDATE railway_sessions
       SET sandbox_id = $2, modal_object_id = $3, sandbox_status = $4, sandbox_error = NULL, updated_at = $5
       WHERE id = $1`,
      [input.sessionId, result.sandboxId, result.modalObjectId ?? null, result.status, Date.now()]
    );
    broadcast(input.sessionId, { type: "sandbox_status", status: result.status });
    console.log(
      JSON.stringify({
        event: "sandbox.create",
        session_id: input.sessionId,
        sandbox_id: result.sandboxId,
        status: result.status,
      })
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await getPool().query(
      `UPDATE railway_sessions SET sandbox_status = 'failed', sandbox_error = $2, updated_at = $3 WHERE id = $1`,
      [input.sessionId, message, Date.now()]
    );
    console.error(
      JSON.stringify({
        event: "sandbox.create_failed",
        session_id: input.sessionId,
        error: message,
      })
    );
  }
}

async function requireInternalAuth(req: IncomingMessage): Promise<boolean> {
  const secret = process.env.INTERNAL_CALLBACK_SECRET;
  if (!secret) return false;

  const authHeader = Array.isArray(req.headers.authorization)
    ? req.headers.authorization[0]
    : req.headers.authorization;
  return verifyInternalToken(authHeader ?? null, secret);
}

async function handleRepos(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!(await requireInternalAuth(req))) {
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }

  const appConfig = getGitHubAppConfig({
    GITHUB_APP_ID: process.env.GITHUB_APP_ID,
    GITHUB_APP_PRIVATE_KEY: process.env.GITHUB_APP_PRIVATE_KEY,
    GITHUB_APP_INSTALLATION_ID: process.env.GITHUB_APP_INSTALLATION_ID,
  });

  if (!appConfig) {
    sendJson(res, 500, { error: "GitHub App credentials are not configured" });
    return;
  }

  try {
    const { repos, timing } = await listInstallationRepositories(appConfig);
    console.log(
      JSON.stringify({
        event: "repos.list",
        repo_count: repos.length,
        total_pages: timing.totalPages,
      })
    );
    sendJson(res, 200, {
      repos,
      cached: false,
      cachedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "repos.list_failed",
        error: error instanceof Error ? error.message : String(error),
      })
    );
    sendJson(res, 500, { error: "Failed to fetch repositories" });
  }
}

async function handleBranches(
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repo: string
): Promise<void> {
  if (!(await requireInternalAuth(req))) {
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }

  const appConfig = getGitHubAppConfig({
    GITHUB_APP_ID: process.env.GITHUB_APP_ID,
    GITHUB_APP_PRIVATE_KEY: process.env.GITHUB_APP_PRIVATE_KEY,
    GITHUB_APP_INSTALLATION_ID: process.env.GITHUB_APP_INSTALLATION_ID,
  });

  if (!appConfig) {
    sendJson(res, 500, { error: "GitHub App credentials are not configured" });
    return;
  }

  try {
    const branches = await listRepositoryBranches(appConfig, owner, repo);
    sendJson(res, 200, { branches });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "repos.branches_failed",
        repo: `${owner}/${repo}`,
        error: error instanceof Error ? error.message : String(error),
      })
    );
    sendJson(res, 500, { error: "Failed to list branches" });
  }
}

async function handleModelPreferences(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!(await requireInternalAuth(req))) {
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }

  if (req.method === "GET") {
    sendJson(res, 200, { enabledModels: DEFAULT_ENABLED_MODELS });
    return;
  }

  if (req.method === "PUT") {
    const body = await readJsonBody<{ enabledModels?: string[] }>(req);
    sendJson(res, 200, { enabledModels: body.enabledModels ?? DEFAULT_ENABLED_MODELS });
    return;
  }

  sendJson(res, 405, { error: "Method not allowed" });
}

async function handleListSessions(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!(await requireInternalAuth(req))) {
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }

  await ensureSchema();
  const result = await getPool().query<SessionRow>(
    `SELECT * FROM railway_sessions ORDER BY updated_at DESC LIMIT 50`
  );
  sendJson(res, 200, {
    sessions: result.rows.map(toSessionResponse),
    total: result.rowCount ?? 0,
    hasMore: false,
  });
}

async function handleCreateSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!(await requireInternalAuth(req))) {
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }

  const body = await readJsonBody<{
    repoOwner?: string;
    repoName?: string;
    model?: string;
    reasoningEffort?: string | null;
    branch?: string | null;
    title?: string | null;
    scmLogin?: string | null;
  }>(req);

  if (!body.repoOwner || !body.repoName) {
    sendJson(res, 400, { error: "repoOwner and repoName are required" });
    return;
  }
  if (body.branch && !/^[\w.\-/]+$/.test(body.branch)) {
    sendJson(res, 400, { error: "Invalid branch name" });
    return;
  }

  await ensureSchema();
  const now = Date.now();
  const sessionId = crypto.randomUUID();
  const repoOwner = body.repoOwner.toLowerCase();
  const repoName = body.repoName.toLowerCase();
  const model = body.model || "openai/gpt-5.1-codex-max";
  const baseBranch = body.branch || "main";

  await getPool().query(
    `INSERT INTO railway_sessions
      (id, title, repo_owner, repo_name, model, reasoning_effort, base_branch, status, scm_login, sandbox_status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'created', $8, 'pending', $9, $10)`,
    [
      sessionId,
      body.title ?? null,
      repoOwner,
      repoName,
      model,
      body.reasoningEffort ?? null,
      baseBranch,
      body.scmLogin ?? null,
      now,
      now,
    ]
  );

  console.log(
    JSON.stringify({
      event: "sessions.create",
      session_id: sessionId,
      repo: `${repoOwner}/${repoName}`,
    })
  );
  void spawnModalSandbox({
    sessionId,
    sandboxId: crypto.randomUUID(),
    repoOwner,
    repoName,
    branch: baseBranch,
    model,
  });
  sendJson(res, 201, { sessionId, status: "created" });
}

async function handleGetSession(
  req: IncomingMessage,
  res: ServerResponse,
  sessionId: string
): Promise<void> {
  if (!(await requireInternalAuth(req))) {
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }

  await ensureSchema();
  const result = await getPool().query<SessionRow>(`SELECT * FROM railway_sessions WHERE id = $1`, [
    sessionId,
  ]);
  const row = result.rows[0];
  if (!row) {
    sendJson(res, 404, { error: "Session not found" });
    return;
  }
  sendJson(res, 200, toSessionResponse(row));
}

async function handleUpdateTitle(
  req: IncomingMessage,
  res: ServerResponse,
  sessionId: string
): Promise<void> {
  if (!(await requireInternalAuth(req))) {
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }

  const body = await readJsonBody<{ title?: string }>(req);
  const title = body.title?.trim();
  if (!title) {
    sendJson(res, 400, { error: "title is required" });
    return;
  }

  await ensureSchema();
  const now = Date.now();
  const result = await getPool().query<SessionRow>(
    `UPDATE railway_sessions SET title = $2, updated_at = $3 WHERE id = $1 RETURNING *`,
    [sessionId, title, now]
  );
  const row = result.rows[0];
  if (!row) {
    sendJson(res, 404, { error: "Session not found" });
    return;
  }
  sendJson(res, 200, toSessionResponse(row));
}

async function handleStatusUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  sessionId: string,
  status: SessionStatus
): Promise<void> {
  if (!(await requireInternalAuth(req))) {
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }

  await ensureSchema();
  const now = Date.now();
  const result = await getPool().query<SessionRow>(
    `UPDATE railway_sessions SET status = $2, updated_at = $3 WHERE id = $1 RETURNING *`,
    [sessionId, status, now]
  );
  const row = result.rows[0];
  if (!row) {
    sendJson(res, 404, { error: "Session not found" });
    return;
  }
  sendJson(res, 200, toSessionResponse(row));
}

async function handleEmptySessionCollection(
  req: IncomingMessage,
  res: ServerResponse,
  key: "events" | "artifacts" | "messages" | "participants" | "children"
): Promise<void> {
  if (!(await requireInternalAuth(req))) {
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }

  if (key === "children") {
    sendJson(res, 200, { children: [] });
    return;
  }

  if (key === "events") {
    const sessionId = req.url?.match(/^\/sessions\/([^/]+)\//)?.[1];
    const events = sessionId ? await getReplayEvents(decodeURIComponent(sessionId)) : [];
    sendJson(res, 200, { events, hasMore: false, cursor: null });
    return;
  }

  if (key === "messages") {
    const sessionId = req.url?.match(/^\/sessions\/([^/]+)\//)?.[1];
    const result = sessionId
      ? await getPool().query<MessageRow>(
          `SELECT * FROM railway_messages WHERE session_id = $1 ORDER BY created_at DESC LIMIT 100`,
          [decodeURIComponent(sessionId)]
        )
      : { rows: [] as MessageRow[] };
    sendJson(res, 200, {
      messages: result.rows.map((message) => ({
        id: message.id,
        authorId: message.author_id,
        content: message.content,
        source: message.source,
        status: message.status,
        createdAt: Number(message.created_at),
      })),
      hasMore: false,
      cursor: null,
    });
    return;
  }

  sendJson(res, 200, { [key]: [], hasMore: false, cursor: null });
}

async function handleWsToken(
  req: IncomingMessage,
  res: ServerResponse,
  sessionId: string
): Promise<void> {
  if (!(await requireInternalAuth(req))) {
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }

  sendJson(res, 200, {
    token: `railway-placeholder.${sessionId}.${Date.now()}`,
    expiresAt: Date.now() + 5 * 60 * 1000,
  });
}

async function dispatchPrompt(
  sessionId: string,
  input: { content?: string; model?: string; reasoningEffort?: string | null }
): Promise<{ messageId: string; queued: boolean; error?: string }> {
  if (!input.content?.trim()) {
    return { messageId: crypto.randomUUID(), queued: false, error: "content is required" };
  }

  const row = await getSessionRow(sessionId);
  if (!row) {
    return { messageId: crypto.randomUUID(), queued: false, error: "Session not found" };
  }

  const messageId = crypto.randomUUID();
  const now = Date.now();
  await getPool().query(
    `UPDATE railway_sessions SET status = 'active', updated_at = $2 WHERE id = $1`,
    [sessionId, now]
  );

  const userEvent: SandboxEvent = {
    type: "user_message",
    content: input.content,
    messageId,
    timestamp: now / 1000,
  };
  await getPool().query(
    `INSERT INTO railway_messages
       (id, session_id, author_id, content, source, model, reasoning_effort, attachments, status, created_at)
     VALUES ($1, $2, $3, $4, 'web', $5, $6, NULL, 'pending', $7)`,
    [
      messageId,
      sessionId,
      "railway-user",
      input.content,
      input.model ?? row.model,
      input.reasoningEffort ?? row.reasoning_effort ?? null,
      now,
    ]
  );
  await createEvent(sessionId, userEvent, now);
  broadcast(sessionId, { type: "sandbox_event", event: userEvent });
  broadcast(sessionId, { type: "processing_status", isProcessing: true });

  broadcast(sessionId, { type: "prompt_queued", messageId, position: 1 });
  await processNextPendingPrompt(sessionId);
  return { messageId, queued: true };
}

async function handlePrompt(
  req: IncomingMessage,
  res: ServerResponse,
  sessionId: string
): Promise<void> {
  if (!(await requireInternalAuth(req))) {
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }

  const body = await readJsonBody<{
    content?: string;
    model?: string;
    reasoningEffort?: string | null;
  }>(req);
  const result = await dispatchPrompt(sessionId, body);
  if (result.error === "Session not found") {
    sendJson(res, 404, { error: "Session not found" });
    return;
  }
  if (result.error === "content is required") {
    sendJson(res, 400, { error: result.error });
    return;
  }

  console.log(
    JSON.stringify({ event: "sessions.prompt", session_id: sessionId, queued: result.queued })
  );
  sendJson(res, result.queued ? 202 : 409, {
    messageId: result.messageId,
    status: result.queued ? "queued" : "failed",
    error: result.error,
  });
}

async function handleWebSocketConnection(
  sessionId: string,
  req: IncomingMessage,
  ws: WebSocket
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.searchParams.get("type") === "sandbox") {
    await handleSandboxSocket(sessionId, req, ws);
    return;
  }

  await handleClientSocket(sessionId, ws);
}

async function handleClientSocket(sessionId: string, ws: WebSocket): Promise<void> {
  let subscribed = false;

  ws.on("message", async (data) => {
    try {
      const message = parseWsJson(data) as {
        type?: string;
        content?: string;
        model?: string;
        reasoningEffort?: string | null;
      };
      if (message.type === "ping") {
        sendWs(ws, { type: "pong", timestamp: Date.now() });
        return;
      }

      if (message.type === "subscribe") {
        const row = await getSessionRow(sessionId);
        if (!row) {
          sendWs(ws, { type: "error", code: "SESSION_NOT_FOUND", message: "Session not found" });
          ws.close(1008, "Session not found");
          return;
        }

        subscribed = true;
        const clients = webClients.get(sessionId) ?? new Set<WebSocket>();
        clients.add(ws);
        webClients.set(sessionId, clients);
        const replayEvents = await getReplayEvents(sessionId);
        if (sandboxReadySessions.has(sessionId)) {
          await recoverInterruptedProcessingPrompts(sessionId);
          await processNextPendingPrompt(sessionId);
        }
        sendWs(ws, {
          type: "subscribed",
          sessionId,
          state: toSessionState(row),
          artifacts: [],
          participantId: "railway-user",
          participant: { participantId: "railway-user", name: "You" },
          replay: {
            events: replayEvents,
            hasMore: false,
            cursor: null,
          },
          spawnError: row.sandbox_error,
        });
        return;
      }

      if (!subscribed) {
        sendWs(ws, {
          type: "error",
          code: "NOT_SUBSCRIBED",
          message: "Subscribe before sending commands",
        });
        return;
      }

      if (message.type === "prompt") {
        const result = await dispatchPrompt(sessionId, message);
        if (result.error) {
          sendWs(ws, { type: "error", code: "PROMPT_FAILED", message: result.error });
        }
        return;
      }

      if (message.type === "stop") {
        const sandbox = sandboxSockets.get(sessionId);
        if (sandbox) sendWs(sandbox, { type: "stop" });
      }
    } catch (error) {
      sendWs(ws, {
        type: "error",
        code: "INVALID_MESSAGE",
        message: error instanceof Error ? error.message : "Invalid WebSocket message",
      });
    }
  });

  ws.on("close", () => {
    const clients = webClients.get(sessionId);
    clients?.delete(ws);
    if (clients?.size === 0) webClients.delete(sessionId);
  });
}

async function handleSandboxSocket(
  sessionId: string,
  req: IncomingMessage,
  ws: WebSocket
): Promise<void> {
  const row = await getSessionRow(sessionId);
  const sandboxId = Array.isArray(req.headers["x-sandbox-id"])
    ? req.headers["x-sandbox-id"][0]
    : req.headers["x-sandbox-id"];
  const token = getBearerToken(req);

  if (
    !row ||
    !row.sandbox_auth_token ||
    token !== row.sandbox_auth_token ||
    sandboxId !== row.sandbox_id
  ) {
    ws.close(1008, "Unauthorized");
    return;
  }

  sandboxSockets.set(sessionId, ws);
  await getPool().query(
    `UPDATE railway_sessions SET sandbox_status = 'connecting', sandbox_error = NULL, updated_at = $2 WHERE id = $1`,
    [sessionId, Date.now()]
  );
  broadcast(sessionId, { type: "sandbox_status", status: "connecting" });
  console.log(
    JSON.stringify({ event: "sandbox.ws_connected", session_id: sessionId, sandbox_id: sandboxId })
  );

  ws.on("message", async (data) => {
    try {
      const event = parseWsJson(data) as Record<string, unknown>;
      const eventType = event.type;

      if (typeof event.ackId === "string") {
        sendWs(ws, { type: "ack", ackId: event.ackId });
      }

      if (eventType === "ready") {
        sandboxReadySessions.add(sessionId);
        await getPool().query(
          `UPDATE railway_sessions SET sandbox_status = 'ready', sandbox_error = NULL, updated_at = $2 WHERE id = $1`,
          [sessionId, Date.now()]
        );
        broadcast(sessionId, { type: "sandbox_ready" });
        broadcast(sessionId, { type: "sandbox_status", status: "ready" });
        await recoverInterruptedProcessingPrompts(sessionId);
        await processNextPendingPrompt(sessionId);
        return;
      }

      if (eventType === "heartbeat") {
        await getPool().query(`UPDATE railway_sessions SET updated_at = $2 WHERE id = $1`, [
          sessionId,
          Date.now(),
        ]);
      }

      if (eventType === "execution_complete") {
        if (typeof event.messageId === "string") {
          await getPool().query(
            `UPDATE railway_messages
             SET status = $2, error_message = $3, completed_at = $4
             WHERE id = $1`,
            [
              event.messageId,
              event.success === false ? "failed" : "completed",
              typeof event.error === "string" ? event.error : null,
              Date.now(),
            ]
          );
        }
        broadcast(sessionId, { type: "processing_status", isProcessing: false });
      }

      const sandboxEvent = event as SandboxEvent;
      await createEvent(sessionId, sandboxEvent);
      broadcast(sessionId, { type: "sandbox_event", event: sandboxEvent });
      if (eventType === "execution_complete") {
        await processNextPendingPrompt(sessionId);
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "sandbox.ws_message_failed",
          session_id: sessionId,
          error: error instanceof Error ? error.message : String(error),
        })
      );
    }
  });

  ws.on("close", () => {
    if (sandboxSockets.get(sessionId) === ws) {
      sandboxSockets.delete(sessionId);
    }
    sandboxReadySessions.delete(sessionId);
    broadcast(sessionId, { type: "sandbox_status", status: "stale" });
    console.log(
      JSON.stringify({ event: "sandbox.ws_closed", session_id: sessionId, sandbox_id: sandboxId })
    );
  });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const sessionMatch = url.pathname.match(/^\/sessions\/([^/]+)$/);
  const sessionCollectionMatch = url.pathname.match(
    /^\/sessions\/([^/]+)\/(events|artifacts|messages|participants|children)$/
  );
  const promptMatch = url.pathname.match(/^\/sessions\/([^/]+)\/prompt$/);
  const titleMatch = url.pathname.match(/^\/sessions\/([^/]+)\/title$/);
  const archiveMatch = url.pathname.match(/^\/sessions\/([^/]+)\/archive$/);
  const unarchiveMatch = url.pathname.match(/^\/sessions\/([^/]+)\/unarchive$/);
  const wsTokenMatch = url.pathname.match(/^\/sessions\/([^/]+)\/ws-token$/);
  const branchesMatch = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/branches$/);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, {
      status: "healthy",
      service: "open-inspect-control-plane",
      runtime: "node",
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/repos") {
    await handleRepos(req, res);
    return;
  }

  if (req.method === "GET" && branchesMatch) {
    await handleBranches(
      req,
      res,
      decodeURIComponent(branchesMatch[1]),
      decodeURIComponent(branchesMatch[2])
    );
    return;
  }

  if ((req.method === "GET" || req.method === "PUT") && url.pathname === "/model-preferences") {
    await handleModelPreferences(req, res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/sessions") {
    await handleListSessions(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/sessions") {
    await handleCreateSession(req, res);
    return;
  }

  if (req.method === "GET" && sessionMatch) {
    await handleGetSession(req, res, sessionMatch[1]);
    return;
  }

  if (req.method === "GET" && sessionCollectionMatch) {
    await handleEmptySessionCollection(req, res, sessionCollectionMatch[2] as never);
    return;
  }

  if (req.method === "POST" && promptMatch) {
    await handlePrompt(req, res, promptMatch[1]);
    return;
  }

  if (req.method === "POST" && wsTokenMatch) {
    await handleWsToken(req, res, wsTokenMatch[1]);
    return;
  }

  if (req.method === "PATCH" && titleMatch) {
    await handleUpdateTitle(req, res, titleMatch[1]);
    return;
  }

  if (req.method === "POST" && archiveMatch) {
    await handleStatusUpdate(req, res, archiveMatch[1], "archived");
    return;
  }

  if (req.method === "POST" && unarchiveMatch) {
    await handleStatusUpdate(req, res, unarchiveMatch[1], "active");
    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    sendJson(res, 200, {
      service: "open-inspect-control-plane",
      runtime: "node",
      status: "bootstrapped",
    });
    return;
  }

  sendJson(res, 501, {
    error:
      "Railway control plane is bootstrapped; Cloudflare Durable Object routes are not ported yet.",
  });
}

const port = getPort();
const server = createServer(handleRequest);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const wsMatch = url.pathname.match(/^\/sessions\/([^/]+)\/ws$/);
  if (!wsMatch) {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    void handleWebSocketConnection(wsMatch[1], req, ws).catch((error) => {
      console.error(
        JSON.stringify({
          event: "ws.connection_failed",
          session_id: wsMatch[1],
          error: error instanceof Error ? error.message : String(error),
        })
      );
      ws.close(1011, "WebSocket setup failed");
    });
  });
});

server.listen(port, () => {
  console.log(JSON.stringify({ event: "server.listen", service: "control-plane", port }));
});
