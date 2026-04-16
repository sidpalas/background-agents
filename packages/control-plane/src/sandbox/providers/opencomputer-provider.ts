import { computeHmacHex, MAX_TUNNEL_PORTS } from "@open-inspect/shared";
import type { SourceControlProviderName } from "../../source-control";
import {
  OpenComputerApiError,
  type OpenComputerClient,
  type OpenComputerCreateSandboxParams,
} from "../opencomputer-client";
import {
  DEFAULT_SANDBOX_TIMEOUT_SECONDS,
  SandboxProviderError,
  type CreateSandboxConfig,
  type CreateSandboxResult,
  type RestoreConfig,
  type RestoreResult,
  type ResumeConfig,
  type ResumeResult,
  type SandboxProvider,
  type SandboxProviderCapabilities,
  type SnapshotConfig,
  type SnapshotResult,
  type StopConfig,
  type StopResult,
} from "../provider";

const CODE_SERVER_PORT = 8080;
const TTYD_PROXY_PORT = 7680;
const DEFAULT_PREVIEW_BASE_DOMAIN = "workers.opencomputer.dev";
const DEFAULT_RUNTIME_ROOT = "/workspace/app";
const DEFAULT_RUNTIME_CWD = DEFAULT_RUNTIME_ROOT;
const DEFAULT_RUNTIME_COMMAND = "/workspace/.venv/bin/python";
const DEFAULT_RUNTIME_ARGS = ["-m", "sandbox_runtime.entrypoint"];
const DEFAULT_EXEC_GRACE_SECONDS = 31536000;
const DEFAULT_NODE_PATH = "/workspace/.openinspect-node/lib/node_modules";
const DEFAULT_PATH =
  "/workspace/.venv/bin:/workspace/.openinspect-node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

export interface OpenComputerProviderConfig {
  scmProvider: SourceControlProviderName;
  gitlabAccessToken?: string;
  apiKey: string;
  snapshot?: string;
  templateId?: string;
  previewBaseDomain?: string;
  runtimeCommand?: string;
  runtimeArgs?: string[];
  runtimeCwd?: string;
}

export class OpenComputerSandboxProvider implements SandboxProvider {
  readonly name = "opencomputer";

  readonly capabilities: SandboxProviderCapabilities = {
    supportsSnapshots: true,
    supportsRestore: true,
    supportsWarm: false,
    supportsPersistentResume: true,
    supportsExplicitStop: true,
  };

  constructor(
    private readonly client: OpenComputerClient,
    private readonly providerConfig: OpenComputerProviderConfig,
    private readonly getCloneToken: () => Promise<string | null>
  ) {}

  async createSandbox(config: CreateSandboxConfig): Promise<CreateSandboxResult> {
    try {
      validatePublicControlPlaneUrl(config.controlPlaneUrl);

      const sandbox = await this.client.createSandbox(
        this.buildCreateParams(config),
        config.correlation
      );

      await this.startRuntime(sandbox.sandboxID, config);
      const access = await this.buildAccessUrls(sandbox.sandboxID, config);

      return {
        sandboxId: config.sandboxId,
        providerObjectId: sandbox.sandboxID,
        status: sandbox.status,
        createdAt: Date.now(),
        ...access,
      };
    } catch (error) {
      throw this.classifyError("Failed to create OpenComputer sandbox", error);
    }
  }

  async restoreFromSnapshot(config: RestoreConfig): Promise<RestoreResult> {
    try {
      validatePublicControlPlaneUrl(config.controlPlaneUrl);

      const sandbox = await this.client.forkFromCheckpoint(
        config.snapshotImageId,
        {
          timeout: config.timeoutSeconds ?? DEFAULT_SANDBOX_TIMEOUT_SECONDS,
        },
        config.correlation
      );

      await this.startRuntime(sandbox.sandboxID, config);
      const access = await this.buildAccessUrls(sandbox.sandboxID, config);

      return {
        success: true,
        sandboxId: config.sandboxId,
        providerObjectId: sandbox.sandboxID,
        ...access,
      };
    } catch (error) {
      throw this.classifyError("Failed to restore OpenComputer sandbox", error);
    }
  }

  async resumeSandbox(config: ResumeConfig): Promise<ResumeResult> {
    try {
      let sandbox;
      try {
        sandbox = await this.client.getSandbox(config.providerObjectId, config.correlation);
      } catch (error) {
        if (error instanceof OpenComputerApiError && error.status === 404) {
          return {
            success: false,
            error: "Sandbox no longer exists in OpenComputer",
            shouldSpawnFresh: true,
          };
        }
        throw error;
      }

      if (sandbox.status === "hibernated") {
        sandbox = await this.client.wakeSandbox(
          config.providerObjectId,
          config.timeoutSeconds ?? DEFAULT_SANDBOX_TIMEOUT_SECONDS,
          config.correlation
        );
      } else if (config.timeoutSeconds !== undefined) {
        await this.client.setSandboxTimeout(
          config.providerObjectId,
          config.timeoutSeconds,
          config.correlation
        );
      }

      const access = await this.buildAccessUrls(sandbox.sandboxID, config);

      return {
        success: true,
        providerObjectId: sandbox.sandboxID,
        ...access,
      };
    } catch (error) {
      throw this.classifyError("Failed to resume OpenComputer sandbox", error);
    }
  }

  async takeSnapshot(config: SnapshotConfig): Promise<SnapshotResult> {
    try {
      const checkpointName = this.buildCheckpointName(config);
      const checkpoint = await this.client.createCheckpoint(
        config.providerObjectId,
        checkpointName,
        config.correlation
      );

      return {
        success: true,
        imageId: checkpoint.id,
      };
    } catch (error) {
      throw this.classifyError("Failed to create OpenComputer checkpoint", error);
    }
  }

  async stopSandbox(config: StopConfig): Promise<StopResult> {
    try {
      try {
        await this.client.hibernateSandbox(config.providerObjectId, config.correlation);
      } catch (error) {
        if (error instanceof OpenComputerApiError && error.status === 404) {
          return { success: true };
        }
        throw error;
      }

      return { success: true };
    } catch (error) {
      throw this.classifyError("Failed to stop OpenComputer sandbox", error);
    }
  }

  private buildCreateParams(config: CreateSandboxConfig): OpenComputerCreateSandboxParams {
    if (!this.providerConfig.snapshot && !this.providerConfig.templateId) {
      throw new Error(
        "OpenComputer provider requires OPENCOMPUTER_SNAPSHOT or OPENCOMPUTER_TEMPLATE_ID"
      );
    }

    return {
      ...(this.providerConfig.snapshot
        ? { snapshot: this.providerConfig.snapshot }
        : this.providerConfig.templateId
          ? { templateID: this.providerConfig.templateId }
          : {}),
      timeout: config.timeoutSeconds ?? DEFAULT_SANDBOX_TIMEOUT_SECONDS,
      metadata: this.buildMetadata(config),
    };
  }

  private buildMetadata(config: CreateSandboxConfig): Record<string, string> {
    return {
      openinspect_framework: "open-inspect",
      openinspect_session_id: config.sessionId,
      openinspect_repo: `${config.repoOwner}/${config.repoName}`,
      openinspect_expected_sandbox_id: config.sandboxId,
    };
  }

  private async startRuntime(
    providerSandboxId: string,
    config: Pick<
      CreateSandboxConfig,
      | "sessionId"
      | "sandboxId"
      | "repoOwner"
      | "repoName"
      | "controlPlaneUrl"
      | "sandboxAuthToken"
      | "provider"
      | "model"
      | "userEnvVars"
      | "timeoutSeconds"
      | "branch"
      | "codeServerEnabled"
      | "sandboxSettings"
      | "correlation"
    >
  ): Promise<void> {
    const envs = await this.buildRuntimeEnvVars(config);

    const runtimeCommand = this.providerConfig.runtimeCommand ?? DEFAULT_RUNTIME_COMMAND;
    const runtimeArgs = this.providerConfig.runtimeArgs ?? DEFAULT_RUNTIME_ARGS;

    await this.client.startExecSession(
      providerSandboxId,
      {
        cmd: runtimeCommand,
        args: runtimeArgs,
        envs,
        cwd: this.providerConfig.runtimeCwd ?? DEFAULT_RUNTIME_CWD,
        maxRunAfterDisconnect: DEFAULT_EXEC_GRACE_SECONDS,
      },
      config.correlation
    );
  }

  private async buildRuntimeEnvVars(
    config: Pick<
      CreateSandboxConfig,
      | "sessionId"
      | "sandboxId"
      | "repoOwner"
      | "repoName"
      | "controlPlaneUrl"
      | "sandboxAuthToken"
      | "provider"
      | "model"
      | "userEnvVars"
      | "branch"
      | "codeServerEnabled"
      | "sandboxSettings"
    >
  ): Promise<Record<string, string>> {
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
      HOME: "/workspace",
      NODE_PATH: DEFAULT_NODE_PATH,
      PATH: DEFAULT_PATH,
      PYTHONPATH: DEFAULT_RUNTIME_ROOT,
    });

    if (config.codeServerEnabled) {
      envVars.CODE_SERVER_PASSWORD = await this.deriveCodeServerPassword(config.sandboxId);
    }

    if (config.sandboxSettings?.terminalEnabled) {
      envVars.TERMINAL_ENABLED = "1";
    }

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

  private async buildAccessUrls(
    providerSandboxId: string,
    config:
      | Pick<CreateSandboxConfig, "sandboxSettings" | "codeServerEnabled" | "sandboxId">
      | Pick<ResumeConfig, "sandboxSettings" | "codeServerEnabled" | "sandboxId">
      | Pick<RestoreConfig, "sandboxSettings" | "codeServerEnabled" | "sandboxId">
  ): Promise<{
    codeServerUrl?: string;
    codeServerPassword?: string;
    ttydUrl?: string;
    tunnelUrls?: Record<string, string>;
  }> {
    const tunnelPorts = resolveTunnelPorts(config.sandboxSettings?.tunnelPorts);
    const remainingPorts = config.codeServerEnabled
      ? tunnelPorts.filter((port) => port !== CODE_SERVER_PORT)
      : tunnelPorts;

    const codeServerPassword = config.codeServerEnabled
      ? await this.deriveCodeServerPassword(config.sandboxId)
      : undefined;

    return {
      codeServerUrl: config.codeServerEnabled
        ? this.buildPreviewUrl(providerSandboxId, CODE_SERVER_PORT)
        : undefined,
      codeServerPassword,
      ttydUrl: config.sandboxSettings?.terminalEnabled
        ? this.buildPreviewUrl(providerSandboxId, TTYD_PROXY_PORT)
        : undefined,
      tunnelUrls:
        remainingPorts.length > 0
          ? Object.fromEntries(
              remainingPorts.map((port) => [
                String(port),
                this.buildPreviewUrl(providerSandboxId, port),
              ])
            )
          : undefined,
    };
  }

  private buildPreviewUrl(providerSandboxId: string, port: number): string {
    const baseDomain = this.providerConfig.previewBaseDomain ?? DEFAULT_PREVIEW_BASE_DOMAIN;
    return `https://${providerSandboxId}-p${port}.${baseDomain}`;
  }

  private async deriveCodeServerPassword(sandboxId: string): Promise<string> {
    const digest = await computeHmacHex(`code-server:${sandboxId}`, this.providerConfig.apiKey);
    return digest.slice(0, 32);
  }

  private buildCheckpointName(config: SnapshotConfig): string {
    return `${config.sessionId}-${config.reason}-${Date.now()}`;
  }

  private classifyError(message: string, error: unknown): SandboxProviderError {
    if (error instanceof OpenComputerApiError) {
      return SandboxProviderError.fromFetchError(
        `${message}: ${error.message}`,
        error,
        error.status
      );
    }
    return SandboxProviderError.fromFetchError(
      error instanceof Error ? `${message}: ${error.message}` : message,
      error
    );
  }
}

function resolveTunnelPorts(rawPorts: number[] | undefined): number[] {
  if (!rawPorts) return [];
  const ports: number[] = [];
  for (const value of rawPorts) {
    if (Number.isInteger(value) && value >= 1 && value <= 65535) {
      ports.push(value);
    }
    if (ports.length >= MAX_TUNNEL_PORTS) break;
  }
  return ports;
}

function validatePublicControlPlaneUrl(controlPlaneUrl: string): void {
  let url: URL;
  try {
    url = new URL(controlPlaneUrl);
  } catch {
    throw new Error(
      `OpenComputer requires a valid public WORKER_URL; received invalid CONTROL_PLANE_URL: ${controlPlaneUrl}`
    );
  }

  const hostname = url.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "0.0.0.0" ||
    hostname === "control-plane" ||
    hostname.endsWith(".local") ||
    isPrivateIpv4Host(hostname)
  ) {
    throw new Error(
      `OpenComputer sandboxes must reach the control plane over a public URL; set WORKER_URL to a public tunnel instead of ${controlPlaneUrl}`
    );
  }
}

function isPrivateIpv4Host(hostname: string): boolean {
  const match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;

  const [a, b] = match.slice(1).map((part) => Number(part));
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

export function createOpenComputerProvider(
  client: OpenComputerClient,
  providerConfig: OpenComputerProviderConfig,
  getCloneToken: () => Promise<string | null>
): OpenComputerSandboxProvider {
  return new OpenComputerSandboxProvider(client, providerConfig, getCloneToken);
}
