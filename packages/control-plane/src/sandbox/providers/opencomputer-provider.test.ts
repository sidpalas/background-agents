import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  OpenComputerApiError,
  type OpenComputerCheckpointResponse,
  type OpenComputerClient,
  type OpenComputerExecSessionResponse,
  type OpenComputerSandboxResponse,
} from "../opencomputer-client";
import type { CreateSandboxConfig, ResumeConfig, SnapshotConfig, StopConfig } from "../provider";
import {
  OpenComputerSandboxProvider,
  type OpenComputerProviderConfig,
} from "./opencomputer-provider";

const baseSandboxResponse: OpenComputerSandboxResponse = {
  sandboxID: "sb-123",
  status: "running",
  region: "use2",
  workerID: "w-123",
};

const baseExecResponse: OpenComputerExecSessionResponse = {
  sessionID: "es-123",
  sandboxID: "sb-123",
  command: "python",
  args: ["-m", "sandbox_runtime.entrypoint"],
  running: true,
  exitCode: null,
  startedAt: "2025-01-01T00:00:00Z",
  attachedClients: 0,
};

const baseCheckpointResponse: OpenComputerCheckpointResponse = {
  id: "cp-123",
  sandboxID: "sb-123",
  name: "checkpoint",
  status: "processing",
  sizeBytes: 0,
  createdAt: "2025-01-01T00:00:00Z",
};

function createMockClient(overrides: Partial<OpenComputerClient> = {}): OpenComputerClient {
  return {
    config: {
      apiUrl: "https://app.opencomputer.dev/api",
      apiKey: "oc_test_key",
    },
    createSandbox: vi.fn(async () => baseSandboxResponse),
    getSandbox: vi.fn(async () => baseSandboxResponse),
    hibernateSandbox: vi.fn(async () => ({ ...baseSandboxResponse, status: "hibernated" })),
    wakeSandbox: vi.fn(async () => baseSandboxResponse),
    setSandboxTimeout: vi.fn(async () => {}),
    createCheckpoint: vi.fn(async () => baseCheckpointResponse),
    forkFromCheckpoint: vi.fn(async () => ({ ...baseSandboxResponse, sandboxID: "sb-forked" })),
    startExecSession: vi.fn(async () => baseExecResponse),
    ...overrides,
  };
}

const providerConfig: OpenComputerProviderConfig = {
  scmProvider: "github",
  apiKey: "oc_test_key",
  snapshot: "open-inspect-runtime",
};

const getCloneToken = vi.fn(async () => "ghs_test_clone_token");

const baseCreateConfig: CreateSandboxConfig = {
  sessionId: "session-123",
  sandboxId: "sandbox-456",
  repoOwner: "acme",
  repoName: "widget",
  controlPlaneUrl: "https://control-plane.test",
  sandboxAuthToken: "sandbox-auth-token",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
};

const baseResumeConfig: ResumeConfig = {
  providerObjectId: "sb-123",
  sessionId: "session-123",
  sandboxId: "sandbox-456",
};

const baseSnapshotConfig: SnapshotConfig = {
  providerObjectId: "sb-123",
  sessionId: "session-123",
  reason: "inactivity_timeout",
};

const baseStopConfig: StopConfig = {
  providerObjectId: "sb-123",
  sessionId: "session-123",
  reason: "inactivity_timeout",
};

describe("OpenComputerSandboxProvider", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    getCloneToken.mockResolvedValue("ghs_test_clone_token");
  });

  it("reports capabilities", () => {
    const provider = new OpenComputerSandboxProvider(
      createMockClient(),
      providerConfig,
      getCloneToken
    );

    expect(provider.name).toBe("opencomputer");
    expect(provider.capabilities).toEqual({
      supportsSnapshots: true,
      supportsRestore: true,
      supportsWarm: false,
      supportsPersistentResume: true,
      supportsExplicitStop: true,
    });
  });

  it("creates a sandbox from snapshot and starts the runtime process", async () => {
    const client = createMockClient();
    const provider = new OpenComputerSandboxProvider(client, providerConfig, getCloneToken);

    const result = await provider.createSandbox({
      ...baseCreateConfig,
      codeServerEnabled: true,
      sandboxSettings: { tunnelPorts: [3000, 8080], terminalEnabled: true },
    });

    expect(client.createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshot: "open-inspect-runtime",
        timeout: 7200,
        metadata: expect.objectContaining({
          openinspect_session_id: "session-123",
          openinspect_expected_sandbox_id: "sandbox-456",
        }),
      }),
      undefined
    );

    expect(client.startExecSession).toHaveBeenCalledWith(
      "sb-123",
      expect.objectContaining({
        cmd: "/workspace/.venv/bin/python",
        args: ["-m", "sandbox_runtime.entrypoint"],
        cwd: "/workspace/app",
        envs: expect.objectContaining({
          SANDBOX_ID: "sandbox-456",
          CONTROL_PLANE_URL: "https://control-plane.test",
          REPO_OWNER: "acme",
          REPO_NAME: "widget",
          VCS_HOST: "github.com",
          VCS_CLONE_TOKEN: "ghs_test_clone_token",
          TERMINAL_ENABLED: "1",
          PYTHONPATH: "/workspace/app",
        }),
      }),
      undefined
    );

    expect(result.providerObjectId).toBe("sb-123");
    expect(result.codeServerUrl).toBe("https://sb-123-p8080.workers.opencomputer.dev");
    expect(result.codeServerPassword).toHaveLength(32);
    expect(result.ttydUrl).toBe("https://sb-123-p7680.workers.opencomputer.dev");
    expect(result.tunnelUrls).toEqual({
      "3000": "https://sb-123-p3000.workers.opencomputer.dev",
    });
  });

  it("restores by forking from checkpoint and starting the runtime", async () => {
    const client = createMockClient();
    const provider = new OpenComputerSandboxProvider(client, providerConfig, getCloneToken);

    const result = await provider.restoreFromSnapshot({
      ...baseCreateConfig,
      snapshotImageId: "cp-123",
    });

    expect(client.forkFromCheckpoint).toHaveBeenCalledWith(
      "cp-123",
      expect.objectContaining({ timeout: 7200 }),
      undefined
    );
    expect(client.startExecSession).toHaveBeenCalledWith(
      "sb-forked",
      expect.any(Object),
      undefined
    );
    expect(result).toMatchObject({
      success: true,
      providerObjectId: "sb-forked",
      sandboxId: "sandbox-456",
    });
  });

  it("resumes hibernated sandboxes with wake", async () => {
    const client = createMockClient({
      getSandbox: vi.fn(async () => ({ ...baseSandboxResponse, status: "hibernated" })),
    });
    const provider = new OpenComputerSandboxProvider(client, providerConfig, getCloneToken);

    const result = await provider.resumeSandbox({
      ...baseResumeConfig,
      timeoutSeconds: 600,
      codeServerEnabled: true,
    });

    expect(client.wakeSandbox).toHaveBeenCalledWith("sb-123", 600, undefined);
    expect(result.success).toBe(true);
    expect(result.codeServerUrl).toBe("https://sb-123-p8080.workers.opencomputer.dev");
  });

  it("falls back to fresh spawn when the sandbox no longer exists", async () => {
    const client = createMockClient({
      getSandbox: vi.fn(async () => {
        throw new OpenComputerApiError("not found", 404);
      }),
    });
    const provider = new OpenComputerSandboxProvider(client, providerConfig, getCloneToken);

    const result = await provider.resumeSandbox(baseResumeConfig);

    expect(result).toEqual({
      success: false,
      error: "Sandbox no longer exists in OpenComputer",
      shouldSpawnFresh: true,
    });
  });

  it("creates checkpoints for snapshots", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1234567890);
    const client = createMockClient();
    const provider = new OpenComputerSandboxProvider(client, providerConfig, getCloneToken);

    const result = await provider.takeSnapshot(baseSnapshotConfig);

    expect(client.createCheckpoint).toHaveBeenCalledWith(
      "sb-123",
      "session-123-inactivity_timeout-1234567890",
      undefined
    );
    expect(result).toEqual({ success: true, imageId: "cp-123" });
  });

  it("hibernates sandboxes when stopping", async () => {
    const client = createMockClient();
    const provider = new OpenComputerSandboxProvider(client, providerConfig, getCloneToken);

    const result = await provider.stopSandbox(baseStopConfig);

    expect(client.hibernateSandbox).toHaveBeenCalledWith("sb-123", undefined);
    expect(result).toEqual({ success: true });
  });

  it("classifies API failures as SandboxProviderError", async () => {
    const client = createMockClient({
      createSandbox: vi.fn(async () => {
        throw new OpenComputerApiError("quota exceeded", 429);
      }),
    });
    const provider = new OpenComputerSandboxProvider(client, providerConfig, getCloneToken);

    await expect(provider.createSandbox(baseCreateConfig)).rejects.toMatchObject({
      errorType: "permanent",
    });
  });

  it("fails fast for non-public control plane URLs", async () => {
    const client = createMockClient();
    const provider = new OpenComputerSandboxProvider(client, providerConfig, getCloneToken);

    await expect(
      provider.createSandbox({
        ...baseCreateConfig,
        controlPlaneUrl: "http://control-plane:8787",
      })
    ).rejects.toThrow("OpenComputer sandboxes must reach the control plane over a public URL");

    expect(client.createSandbox).not.toHaveBeenCalled();
  });
});
