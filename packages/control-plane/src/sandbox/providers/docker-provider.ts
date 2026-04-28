import type { SourceControlProviderName } from "../../source-control";
import type { DockerSandboxClient } from "../docker-client";
import {
  DEFAULT_SANDBOX_TIMEOUT_SECONDS,
  SandboxProviderError,
  type CreateSandboxConfig,
  type CreateSandboxResult,
  type SandboxProvider,
  type SandboxProviderCapabilities,
  type StopConfig,
  type StopResult,
} from "../provider";

export interface DockerProviderConfig {
  scmProvider: SourceControlProviderName;
  gitlabAccessToken?: string;
}

export class DockerSandboxProvider implements SandboxProvider {
  readonly name = "docker";

  readonly capabilities: SandboxProviderCapabilities = {
    supportsSnapshots: false,
    supportsRestore: false,
    supportsWarm: false,
    supportsPersistentResume: false,
    supportsExplicitStop: true,
  };

  constructor(
    private readonly client: DockerSandboxClient,
    private readonly providerConfig: DockerProviderConfig,
    private readonly getCloneToken: () => Promise<string | null>
  ) {}

  async createSandbox(config: CreateSandboxConfig): Promise<CreateSandboxResult> {
    try {
      const result = await this.client.createSandbox(
        {
          sandboxId: config.sandboxId,
          sessionId: config.sessionId,
          envVars: await this.buildEnvVars(config),
          labels: this.buildLabels(config),
          timeoutSeconds: config.timeoutSeconds ?? DEFAULT_SANDBOX_TIMEOUT_SECONDS,
        },
        config.correlation
      );

      return {
        sandboxId: result.sandboxId,
        providerObjectId: result.providerObjectId,
        status: result.status,
        createdAt: result.createdAt,
      };
    } catch (error) {
      throw this.classifyError("Failed to create Docker sandbox", error);
    }
  }

  async stopSandbox(config: StopConfig): Promise<StopResult> {
    try {
      const result = await this.client.stopSandbox(config.providerObjectId, config.correlation);
      return result.success ? { success: true } : { success: false, error: result.error };
    } catch (error) {
      throw this.classifyError("Failed to stop Docker sandbox", error);
    }
  }

  private async buildEnvVars(config: CreateSandboxConfig): Promise<Record<string, string>> {
    const cloneToken = await this.getCloneToken();
    const envVars: Record<string, string> = { ...(config.userEnvVars ?? {}) };

    const sessionConfig: Record<string, string> = {
      session_id: config.sessionId,
      repo_owner: config.repoOwner,
      repo_name: config.repoName,
      provider: config.provider,
      model: config.model,
    };
    if (config.branch) {
      sessionConfig.branch = config.branch;
    }

    Object.assign(envVars, {
      PYTHONUNBUFFERED: "1",
      SANDBOX_ID: config.sandboxId,
      CONTROL_PLANE_URL: config.controlPlaneUrl,
      SANDBOX_AUTH_TOKEN: config.sandboxAuthToken,
      REPO_OWNER: config.repoOwner,
      REPO_NAME: config.repoName,
      SESSION_CONFIG: JSON.stringify(sessionConfig),
      VCS_HOST: this.providerConfig.scmProvider === "gitlab" ? "gitlab.com" : "github.com",
      VCS_CLONE_USERNAME:
        this.providerConfig.scmProvider === "gitlab" ? "oauth2" : "x-access-token",
    });

    if (cloneToken) {
      envVars.VCS_CLONE_TOKEN = cloneToken;
      if (this.providerConfig.scmProvider === "github") {
        envVars.GITHUB_APP_TOKEN = cloneToken;
        envVars.GITHUB_TOKEN = cloneToken;
      }
    }

    if (this.providerConfig.scmProvider === "gitlab" && this.providerConfig.gitlabAccessToken) {
      envVars.GITLAB_ACCESS_TOKEN = this.providerConfig.gitlabAccessToken;
    }

    return envVars;
  }

  private buildLabels(config: CreateSandboxConfig): Record<string, string> {
    return {
      openinspect_framework: "open-inspect",
      openinspect_session_id: config.sessionId,
      openinspect_repo: `${config.repoOwner}/${config.repoName}`,
      openinspect_expected_sandbox_id: config.sandboxId,
    };
  }

  private classifyError(message: string, error: unknown): SandboxProviderError {
    if (error instanceof Error) {
      const errorMessage = error.message.toLowerCase();
      if (
        errorMessage.includes("fetch failed") ||
        errorMessage.includes("etimedout") ||
        errorMessage.includes("econnreset") ||
        errorMessage.includes("econnrefused") ||
        errorMessage.includes("network") ||
        errorMessage.includes("timeout") ||
        errorMessage.includes("502") ||
        errorMessage.includes("503") ||
        errorMessage.includes("504")
      ) {
        return new SandboxProviderError(`${message}: ${error.message}`, "transient", error);
      }
    }

    return new SandboxProviderError(
      `${message}: ${error instanceof Error ? error.message : String(error)}`,
      "permanent",
      error instanceof Error ? error : undefined
    );
  }
}

export function createDockerProvider(
  client: DockerSandboxClient,
  providerConfig: DockerProviderConfig,
  getCloneToken: () => Promise<string | null>
): DockerSandboxProvider {
  return new DockerSandboxProvider(client, providerConfig, getCloneToken);
}
