import { beforeEach, describe, expect, it, vi } from "vitest";
import { DockerSandboxProvider, type DockerProviderConfig } from "./docker-provider";
import { SandboxProviderError, type CreateSandboxConfig, type StopConfig } from "../provider";
import type {
  DockerSandboxClient,
  DockerSandboxCreateRequest,
  DockerSandboxCreateResponse,
  DockerSandboxStopResponse,
} from "../docker-client";
import type { CorrelationContext } from "../../logger";

function createMockClient(
  overrides: Partial<{
    createSandbox: (
      request: DockerSandboxCreateRequest,
      correlation?: CorrelationContext
    ) => Promise<DockerSandboxCreateResponse>;
    stopSandbox: (
      providerObjectId: string,
      correlation?: CorrelationContext
    ) => Promise<DockerSandboxStopResponse>;
  }> = {}
): DockerSandboxClient {
  return {
    createSandbox: vi.fn(async () => ({
      sandboxId: "sandbox-456",
      providerObjectId: "container-123",
      status: "running",
      createdAt: 123,
    })),
    stopSandbox: vi.fn(async () => ({ success: true })),
    ...overrides,
  } as unknown as DockerSandboxClient;
}

const defaultProviderConfig: DockerProviderConfig = {
  scmProvider: "github",
};

const getCloneToken = vi.fn(async () => "ghs_test_clone_token");

const baseCreateConfig: CreateSandboxConfig = {
  sessionId: "session-123",
  sandboxId: "sandbox-456",
  repoOwner: "testowner",
  repoName: "testrepo",
  controlPlaneUrl: "http://host.docker.internal:8787",
  sandboxAuthToken: "auth-token-abc",
  provider: "anthropic",
  model: "anthropic/claude-sonnet-4-6",
};

const baseStopConfig: StopConfig = {
  providerObjectId: "container-123",
  sessionId: "session-123",
  reason: "user_requested",
};

describe("DockerSandboxProvider", () => {
  beforeEach(() => {
    getCloneToken.mockResolvedValue("ghs_test_clone_token");
  });

  it("reports correct capabilities", () => {
    const provider = new DockerSandboxProvider(
      createMockClient(),
      defaultProviderConfig,
      getCloneToken
    );

    expect(provider.name).toBe("docker");
    expect(provider.capabilities).toEqual({
      supportsSnapshots: false,
      supportsRestore: false,
      supportsWarm: false,
      supportsPersistentResume: false,
      supportsExplicitStop: true,
    });
  });

  it("creates sandbox with env vars, labels, and timeout", async () => {
    const client = createMockClient();
    const provider = new DockerSandboxProvider(client, defaultProviderConfig, getCloneToken);

    const result = await provider.createSandbox({ ...baseCreateConfig, timeoutSeconds: 60 });

    expect(result).toEqual({
      sandboxId: "sandbox-456",
      providerObjectId: "container-123",
      status: "running",
      createdAt: 123,
    });

    expect(client.createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxId: "sandbox-456",
        sessionId: "session-123",
        timeoutSeconds: 60,
      }),
      undefined
    );
  });

  it("assembles env vars correctly for GitHub", async () => {
    const client = createMockClient();
    const provider = new DockerSandboxProvider(client, defaultProviderConfig, getCloneToken);

    await provider.createSandbox(baseCreateConfig);

    const request = (client.createSandbox as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const envVars = request.envVars;

    expect(envVars.PYTHONUNBUFFERED).toBe("1");
    expect(envVars.SANDBOX_ID).toBe("sandbox-456");
    expect(envVars.CONTROL_PLANE_URL).toBe("http://host.docker.internal:8787");
    expect(envVars.SANDBOX_AUTH_TOKEN).toBe("auth-token-abc");
    expect(envVars.REPO_OWNER).toBe("testowner");
    expect(envVars.REPO_NAME).toBe("testrepo");
    expect(envVars.VCS_HOST).toBe("github.com");
    expect(envVars.VCS_CLONE_USERNAME).toBe("x-access-token");
    expect(envVars.VCS_CLONE_TOKEN).toBe("ghs_test_clone_token");
    expect(envVars.GITHUB_APP_TOKEN).toBe("ghs_test_clone_token");
    expect(envVars.GITHUB_TOKEN).toBe("ghs_test_clone_token");

    expect(JSON.parse(envVars.SESSION_CONFIG)).toEqual({
      session_id: "session-123",
      repo_owner: "testowner",
      repo_name: "testrepo",
      provider: "anthropic",
      model: "anthropic/claude-sonnet-4-6",
    });
  });

  it("assembles env vars correctly for GitLab", async () => {
    const client = createMockClient();
    const gitlabCloneToken = vi.fn(async () => "glpat-test-token");
    const provider = new DockerSandboxProvider(
      client,
      { scmProvider: "gitlab", gitlabAccessToken: "glpat-test-token" },
      gitlabCloneToken
    );

    await provider.createSandbox(baseCreateConfig);

    const envVars = (client.createSandbox as ReturnType<typeof vi.fn>).mock.calls[0][0].envVars;
    expect(envVars.VCS_HOST).toBe("gitlab.com");
    expect(envVars.VCS_CLONE_USERNAME).toBe("oauth2");
    expect(envVars.VCS_CLONE_TOKEN).toBe("glpat-test-token");
    expect(envVars.GITLAB_ACCESS_TOKEN).toBe("glpat-test-token");
    expect(envVars.GITHUB_APP_TOKEN).toBeUndefined();
    expect(envVars.GITHUB_TOKEN).toBeUndefined();
  });

  it("includes branch in SESSION_CONFIG when provided", async () => {
    const client = createMockClient();
    const provider = new DockerSandboxProvider(client, defaultProviderConfig, getCloneToken);

    await provider.createSandbox({ ...baseCreateConfig, branch: "feature/test" });

    const envVars = (client.createSandbox as ReturnType<typeof vi.fn>).mock.calls[0][0].envVars;
    expect(JSON.parse(envVars.SESSION_CONFIG).branch).toBe("feature/test");
  });

  it("keeps user env vars while system env vars take precedence", async () => {
    const client = createMockClient();
    const provider = new DockerSandboxProvider(client, defaultProviderConfig, getCloneToken);

    await provider.createSandbox({
      ...baseCreateConfig,
      userEnvVars: {
        ANTHROPIC_API_KEY: "sk-test",
        SANDBOX_ID: "should-be-overridden",
      },
    });

    const envVars = (client.createSandbox as ReturnType<typeof vi.fn>).mock.calls[0][0].envVars;
    expect(envVars.ANTHROPIC_API_KEY).toBe("sk-test");
    expect(envVars.SANDBOX_ID).toBe("sandbox-456");
  });

  it("builds labels correctly", async () => {
    const client = createMockClient();
    const provider = new DockerSandboxProvider(client, defaultProviderConfig, getCloneToken);

    await provider.createSandbox(baseCreateConfig);

    const labels = (client.createSandbox as ReturnType<typeof vi.fn>).mock.calls[0][0].labels;
    expect(labels).toEqual({
      openinspect_framework: "open-inspect",
      openinspect_session_id: "session-123",
      openinspect_repo: "testowner/testrepo",
      openinspect_expected_sandbox_id: "sandbox-456",
    });
  });

  it("omits clone token aliases when clone token is unavailable", async () => {
    const client = createMockClient();
    const provider = new DockerSandboxProvider(
      client,
      defaultProviderConfig,
      vi.fn(async () => null)
    );

    await provider.createSandbox(baseCreateConfig);

    const envVars = (client.createSandbox as ReturnType<typeof vi.fn>).mock.calls[0][0].envVars;
    expect(envVars.VCS_CLONE_TOKEN).toBeUndefined();
    expect(envVars.GITHUB_APP_TOKEN).toBeUndefined();
    expect(envVars.GITHUB_TOKEN).toBeUndefined();
  });

  it("stops sandbox successfully", async () => {
    const client = createMockClient();
    const provider = new DockerSandboxProvider(client, defaultProviderConfig, getCloneToken);

    const result = await provider.stopSandbox(baseStopConfig);

    expect(result).toEqual({ success: true });
    expect(client.stopSandbox).toHaveBeenCalledWith("container-123", undefined);
  });

  it("returns stop error when client reports failed stop", async () => {
    const client = createMockClient({
      stopSandbox: vi.fn(async () => ({ success: false, error: "not found" })),
    });
    const provider = new DockerSandboxProvider(client, defaultProviderConfig, getCloneToken);

    await expect(provider.stopSandbox(baseStopConfig)).resolves.toEqual({
      success: false,
      error: "not found",
    });
  });

  it("classifies network failures as transient", async () => {
    const client = createMockClient({
      createSandbox: vi.fn(async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:8788");
      }),
    });
    const provider = new DockerSandboxProvider(client, defaultProviderConfig, getCloneToken);

    try {
      await provider.createSandbox(baseCreateConfig);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SandboxProviderError);
      expect((error as SandboxProviderError).errorType).toBe("transient");
    }
  });
});
