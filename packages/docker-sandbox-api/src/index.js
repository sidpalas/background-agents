import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.PORT || "8788");
const API_TOKEN = process.env.DOCKER_SANDBOX_API_TOKEN || "";
const SANDBOX_IMAGE = process.env.DOCKER_SANDBOX_IMAGE || "open-inspect-sandbox-runtime:local";
const SANDBOX_NETWORK = process.env.DOCKER_SANDBOX_NETWORK || "";
const BUILD_CONTEXT = process.env.DOCKER_SANDBOX_BUILD_CONTEXT || "/workspace";
const DOCKERFILE_PATH =
  process.env.DOCKER_SANDBOX_DOCKERFILE || "packages/sandbox-runtime/Dockerfile.local";
const BUILD_ON_STARTUP = process.env.DOCKER_SANDBOX_BUILD_ON_STARTUP !== "false";
const PASSTHROUGH_ENV_VARS = (process.env.DOCKER_SANDBOX_PASSTHROUGH_ENV_VARS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const REAP_INTERVAL_MS = Number(process.env.DOCKER_SANDBOX_REAP_INTERVAL_MS || "60000");
const FALLBACK_MAX_AGE_SECONDS = Number(process.env.DOCKER_SANDBOX_MAX_AGE_SECONDS || "7200");

let imageReadyPromise = null;

function json(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function sanitizeContainerName(value) {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-");
  const maxValueLength = 63;
  if (normalized.length <= maxValueLength) {
    return `open-inspect-${normalized}`;
  }

  const tailLength = 16;
  const headLength = maxValueLength - tailLength - 1;
  return `open-inspect-${normalized.slice(0, headLength)}-${normalized.slice(-tailLength)}`;
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function isAuthorized(req) {
  if (!API_TOKEN) return true;
  return req.headers.authorization === `Bearer ${API_TOKEN}`;
}

async function ensureSandboxImage() {
  if (imageReadyPromise) {
    return imageReadyPromise;
  }

  imageReadyPromise = (async () => {
    try {
      await execFileAsync("docker", ["image", "inspect", SANDBOX_IMAGE]);
      return;
    } catch {
      await execFileAsync("docker", [
        "build",
        "-t",
        SANDBOX_IMAGE,
        "-f",
        DOCKERFILE_PATH,
        BUILD_CONTEXT,
      ]);
    }
  })();

  try {
    await imageReadyPromise;
  } catch (error) {
    imageReadyPromise = null;
    throw error;
  }
}

function getExpiryTimestampMs(timeoutSeconds) {
  const safeTimeoutSeconds =
    typeof timeoutSeconds === "number" && Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
      ? timeoutSeconds
      : FALLBACK_MAX_AGE_SECONDS;
  return Date.now() + safeTimeoutSeconds * 1000;
}

async function listManagedContainers() {
  const { stdout } = await execFileAsync("docker", [
    "ps",
    "-aq",
    "--filter",
    "label=openinspect_framework=open-inspect",
    "--filter",
    "label=openinspect_kind=sandbox",
  ]);

  return stdout
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
}

async function inspectContainer(containerId) {
  const { stdout } = await execFileAsync("docker", ["inspect", containerId]);
  const [details] = JSON.parse(stdout);
  return details;
}

async function reapExpiredContainers() {
  try {
    const containerIds = await listManagedContainers();
    const now = Date.now();

    for (const containerId of containerIds) {
      const details = await inspectContainer(containerId);
      const expiresAtRaw = details?.Config?.Labels?.openinspect_expires_at;
      const expiresAtMs = Number(expiresAtRaw);
      if (!Number.isFinite(expiresAtMs) || expiresAtMs > now) {
        continue;
      }

      await execFileAsync("docker", ["rm", "-f", containerId]);
      console.log("Reaped expired sandbox container", {
        containerId,
        expiresAt: expiresAtMs,
      });
    }
  } catch (error) {
    console.error("Failed to reap expired sandbox containers", error);
  }
}

async function handleCreateSandbox(req, res) {
  const body = await readJson(req);
  if (!body?.sandboxId || !body?.sessionId || !body?.envVars) {
    json(res, 400, { success: false, error: "sandboxId, sessionId, and envVars are required" });
    return;
  }

  await ensureSandboxImage();

  const containerName = sanitizeContainerName(body.sandboxId);
  const args = ["run", "-d", "--rm", "--name", containerName];

  args.push("--label", "openinspect_framework=open-inspect");
  args.push("--label", "openinspect_kind=sandbox");
  args.push("--label", "openinspect_env=local");

  if (SANDBOX_NETWORK) {
    args.push("--network", SANDBOX_NETWORK);
  }

  for (const [key, value] of Object.entries(body.labels || {})) {
    args.push("--label", `${key}=${value}`);
  }

  args.push("--label", `openinspect_expires_at=${getExpiryTimestampMs(body.timeoutSeconds)}`);

  for (const [key, value] of Object.entries(body.envVars)) {
    args.push("-e", `${key}=${value}`);
  }

  for (const key of PASSTHROUGH_ENV_VARS) {
    const value = process.env[key];
    if (typeof value === "string" && value.length > 0 && !(key in body.envVars)) {
      args.push("-e", `${key}=${value}`);
    }
  }

  args.push(SANDBOX_IMAGE);

  const { stdout } = await execFileAsync("docker", args);
  const providerObjectId = stdout.trim();

  json(res, 200, {
    success: true,
    data: {
      sandboxId: body.sandboxId,
      providerObjectId,
      status: "running",
      createdAt: Date.now(),
    },
  });
}

async function handleStopSandbox(req, res, providerObjectId) {
  try {
    await execFileAsync("docker", ["rm", "-f", providerObjectId]);
  } catch (error) {
    const stderr = error?.stderr || error?.message || String(error);
    if (!String(stderr).includes("No such container")) {
      throw error;
    }
  }

  json(res, 200, { success: true, data: { success: true } });
}

const server = createServer(async (req, res) => {
  try {
    if (!isAuthorized(req)) {
      json(res, 401, { success: false, error: "Unauthorized" });
      return;
    }

    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && url.pathname === "/health") {
      json(res, 200, { success: true, data: { status: "ok" } });
      return;
    }

    if (req.method === "POST" && url.pathname === "/sandboxes") {
      await handleCreateSandbox(req, res);
      return;
    }

    const stopMatch = url.pathname.match(/^\/sandboxes\/([^/]+)\/stop$/);
    if (req.method === "POST" && stopMatch) {
      await handleStopSandbox(req, res, decodeURIComponent(stopMatch[1]));
      return;
    }

    json(res, 404, { success: false, error: "Not found" });
  } catch (error) {
    console.error("docker-sandbox-api request failed", {
      method: req.method,
      url: req.url,
      error: error instanceof Error ? error.stack || error.message : String(error),
    });
    json(res, 500, {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(PORT, "0.0.0.0", async () => {
  if (BUILD_ON_STARTUP) {
    try {
      await ensureSandboxImage();
    } catch (error) {
      console.error("Failed to build sandbox image on startup:", error);
    }
  }
  setInterval(() => {
    void reapExpiredContainers();
  }, REAP_INTERVAL_MS);
  void reapExpiredContainers();
  console.log(`docker-sandbox-api listening on ${PORT}`);
});
