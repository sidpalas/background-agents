#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const envPath = resolve(root, ".env.local");

function parseEnv(contents) {
  const env = {};

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const index = line.indexOf("=");
    if (index === -1) continue;

    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    env[key] = value.replace(/\\n/g, "\n");
  }

  return env;
}

let localEnv = {};
try {
  localEnv = parseEnv(readFileSync(envPath, "utf8"));
} catch {
  console.warn(".env.local not found; starting Docker sandbox API with process environment only.");
}

const env = {
  ...process.env,
  ...localEnv,
  PORT: process.env.PORT || localEnv.PORT || "8788",
  DOCKER_SANDBOX_IMAGE:
    process.env.DOCKER_SANDBOX_IMAGE ||
    localEnv.DOCKER_SANDBOX_IMAGE ||
    "open-inspect-sandbox-runtime:local",
  DOCKER_SANDBOX_BUILD_CONTEXT:
    process.env.DOCKER_SANDBOX_BUILD_CONTEXT || localEnv.DOCKER_SANDBOX_BUILD_CONTEXT || root,
  DOCKER_SANDBOX_DOCKERFILE:
    process.env.DOCKER_SANDBOX_DOCKERFILE ||
    localEnv.DOCKER_SANDBOX_DOCKERFILE ||
    "packages/sandbox-runtime/Dockerfile.sandbox",
  DOCKER_SANDBOX_PASSTHROUGH_ENV_VARS:
    process.env.DOCKER_SANDBOX_PASSTHROUGH_ENV_VARS ||
    localEnv.DOCKER_SANDBOX_PASSTHROUGH_ENV_VARS ||
    "ANTHROPIC_API_KEY,OPENAI_API_KEY,OPENCODE_API_KEY",
};

const child = spawn("npm", ["start", "-w", "@open-inspect/docker-sandbox-api"], {
  cwd: root,
  env,
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
