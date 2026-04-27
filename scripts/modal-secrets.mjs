#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const sourcePath = resolve(root, ".env.local");

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

function requireEnv(env, keys) {
  const missing = keys.filter((key) => !env[key]);
  if (missing.length > 0) {
    console.error(`Missing required values in .env.local: ${missing.join(", ")}`);
    process.exit(1);
  }
}

function shellWords(command) {
  return command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) => {
    if (
      (part.startsWith('"') && part.endsWith('"')) ||
      (part.startsWith("'") && part.endsWith("'"))
    ) {
      return part.slice(1, -1);
    }
    return part;
  }) ?? [command];
}

function createSecret(modalCommand, secretName, values) {
  const [command, ...baseArgs] = modalCommand;
  const args = [
    ...baseArgs,
    "secret",
    "create",
    secretName,
    ...Object.entries(values).map(([key, value]) => `${key}=${value}`),
    "--force",
  ];

  console.log(`creating/updating Modal secret: ${secretName}`);
  const result = spawnSync(command, args, {
    stdio: "inherit",
    cwd: root,
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

let source;
try {
  source = readFileSync(sourcePath, "utf8");
} catch {
  console.error("Missing .env.local. Copy .env.example to .env.local and fill in real values.");
  process.exit(1);
}

const env = parseEnv(source);
requireEnv(env, [
  "ANTHROPIC_API_KEY",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_INSTALLATION_ID",
  "MODAL_API_SECRET",
  "INTERNAL_CALLBACK_SECRET",
  "CONTROL_PLANE_URL",
]);

const controlPlaneUrl = new URL(env.CONTROL_PLANE_URL);
const allowedHosts = env.ALLOWED_CONTROL_PLANE_HOSTS || controlPlaneUrl.host;
const modalCommand = shellWords(process.env.MODAL_CLI || "modal");

createSecret(modalCommand, "llm-api-keys", {
  ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
});

createSecret(modalCommand, "github-app", {
  GITHUB_APP_ID: env.GITHUB_APP_ID,
  GITHUB_APP_PRIVATE_KEY: env.GITHUB_APP_PRIVATE_KEY,
  GITHUB_APP_INSTALLATION_ID: env.GITHUB_APP_INSTALLATION_ID,
});

createSecret(modalCommand, "internal-api", {
  MODAL_API_SECRET: env.MODAL_API_SECRET,
  INTERNAL_CALLBACK_SECRET: env.INTERNAL_CALLBACK_SECRET,
  ALLOWED_CONTROL_PLANE_HOSTS: allowedHosts,
  CONTROL_PLANE_URL: env.CONTROL_PLANE_URL,
});

console.log("Modal secrets are up to date.");
