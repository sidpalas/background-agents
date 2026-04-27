#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

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

function serializeEnv(env, keys) {
  return `${keys
    .map((key) => {
      const value = env[key] ?? "";
      const serialized = value.includes("\n") ? JSON.stringify(value) : value;
      return `${key}=${serialized}`;
    })
    .join("\n")}\n`;
}

function writeEnv(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  console.log(`wrote ${path.replace(`${root}/`, "")}`);
}

let source;
try {
  source = readFileSync(sourcePath, "utf8");
} catch {
  console.error("Missing .env.local. Copy .env.example to .env.local and fill in real values.");
  process.exit(1);
}

const env = parseEnv(source);

const webKeys = [
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "NEXTAUTH_URL",
  "NEXTAUTH_SECRET",
  "CONTROL_PLANE_URL",
  "NEXT_PUBLIC_WS_URL",
  "NEXT_PUBLIC_SANDBOX_PROVIDER",
  "NEXT_PUBLIC_SCM_PROVIDER",
  "INTERNAL_CALLBACK_SECRET",
  "ALLOWED_USERS",
  "ALLOWED_EMAIL_DOMAINS",
  "UNSAFE_ALLOW_ALL_USERS",
];

const controlPlaneKeys = [
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "TOKEN_ENCRYPTION_KEY",
  "REPO_SECRETS_ENCRYPTION_KEY",
  "INTERNAL_CALLBACK_SECRET",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_INSTALLATION_ID",
  "MODAL_TOKEN_ID",
  "MODAL_TOKEN_SECRET",
  "MODAL_API_SECRET",
  "MODAL_WORKSPACE",
  "DEPLOYMENT_NAME",
  "SCM_PROVIDER",
  "SANDBOX_PROVIDER",
  "WORKER_URL",
  "WEB_APP_URL",
  "LOG_LEVEL",
];

writeEnv(resolve(root, "packages/web/.env.local"), serializeEnv(env, webKeys));
writeEnv(resolve(root, "packages/control-plane/.dev.vars"), serializeEnv(env, controlPlaneKeys));

console.log("\nNext, sync Modal secrets from .env.local:");
console.log("  npm run dev:modal-secrets");
