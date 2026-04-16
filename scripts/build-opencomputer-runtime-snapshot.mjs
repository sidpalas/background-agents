import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

async function loadSdk() {
  try {
    return await import("@opencomputer/sdk/node");
  } catch {
    throw new Error(
      "Missing @opencomputer/sdk. Run this script with: npm exec --yes --package=@opencomputer/sdk node scripts/build-opencomputer-runtime-snapshot.mjs"
    );
  }
}

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(fullPath)));
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

async function main() {
  if (!process.env.OPENCOMPUTER_API_KEY) {
    throw new Error("OPENCOMPUTER_API_KEY is required");
  }

  const { Image, Snapshots } = await loadSdk();

  const repoRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
  const runtimeRoot = path.join(repoRoot, "packages", "sandbox-runtime");
  const srcRoot = path.join(runtimeRoot, "src", "sandbox_runtime");
  const snapshotName = process.argv[2] || `open-inspect-runtime-${Date.now()}`;
  const srcFiles = await walk(srcRoot);

  let image = Image.base().runCommands(
    "mkdir -p /workspace/.openinspect-node /workspace/app /workspace /tmp/opencode /tmp/miniforge",
    "curl -Ls https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-Linux-x86_64.sh -o /tmp/miniforge/miniforge.sh",
    "bash /tmp/miniforge/miniforge.sh -b -p /workspace/.venv",
    "npm install -g --prefix /workspace/.openinspect-node opencode-ai@latest @opencode-ai/plugin@latest zod",
    "/workspace/.venv/bin/pip install --no-cache-dir httpx websockets pydantic 'PyJWT[crypto]'"
  );

  for (const file of srcFiles) {
    const relPath = path.relative(srcRoot, file);
    image = image.addLocalFile(file, `/workspace/app/sandbox_runtime/${relPath}`);
  }

  image = image
    .env({
      HOME: "/workspace",
      NODE_ENV: "development",
      PYTHONPATH: "/workspace/app",
      NODE_PATH: "/workspace/.openinspect-node/lib/node_modules",
      PATH: "/workspace/.venv/bin:/workspace/.openinspect-node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    })
    .workdir("/workspace/app");

  const snapshots = new Snapshots({ apiKey: process.env.OPENCOMPUTER_API_KEY });
  await snapshots.create({
    name: snapshotName,
    image,
    onBuildLogs: (log) => console.log(log),
  });

  console.log(`SNAPSHOT_NAME=${snapshotName}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
