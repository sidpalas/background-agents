import type { CorrelationContext } from "../logger";

export interface OpenComputerClientConfig {
  apiUrl: string;
  apiKey: string;
}

export interface OpenComputerSandboxResponse {
  sandboxID: string;
  status: string;
  region?: string;
  workerID?: string;
}

export interface OpenComputerCheckpointResponse {
  id: string;
  sandboxID: string;
  name: string;
  status: string;
  sizeBytes: number;
  createdAt: string;
}

export interface OpenComputerExecSessionResponse {
  sessionID: string;
  sandboxID: string;
  command: string;
  args?: string[];
  running: boolean;
  exitCode: number | null;
  startedAt: string;
  attachedClients: number;
}

export interface OpenComputerCreateSandboxParams {
  templateID?: string;
  snapshot?: string;
  timeout?: number;
  cpuCount?: number;
  memoryMB?: number;
  envs?: Record<string, string>;
  metadata?: Record<string, string>;
}

export interface OpenComputerForkFromCheckpointParams {
  timeout?: number;
  envs?: Record<string, string>;
}

export interface OpenComputerStartExecParams {
  cmd: string;
  args?: string[];
  envs?: Record<string, string>;
  cwd?: string;
  timeout?: number;
  maxRunAfterDisconnect?: number;
}

interface OpenComputerErrorBody {
  error?: string;
}

export class OpenComputerApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "OpenComputerApiError";
  }
}

export interface OpenComputerClient {
  readonly config: OpenComputerClientConfig;
  createSandbox(
    params: OpenComputerCreateSandboxParams,
    correlation?: CorrelationContext
  ): Promise<OpenComputerSandboxResponse>;
  getSandbox(id: string, correlation?: CorrelationContext): Promise<OpenComputerSandboxResponse>;
  hibernateSandbox(
    id: string,
    correlation?: CorrelationContext
  ): Promise<OpenComputerSandboxResponse>;
  wakeSandbox(
    id: string,
    timeout: number | undefined,
    correlation?: CorrelationContext
  ): Promise<OpenComputerSandboxResponse>;
  setSandboxTimeout(id: string, timeout: number, correlation?: CorrelationContext): Promise<void>;
  createCheckpoint(
    sandboxId: string,
    name: string,
    correlation?: CorrelationContext
  ): Promise<OpenComputerCheckpointResponse>;
  forkFromCheckpoint(
    checkpointId: string,
    params: OpenComputerForkFromCheckpointParams,
    correlation?: CorrelationContext
  ): Promise<OpenComputerSandboxResponse>;
  startExecSession(
    sandboxId: string,
    params: OpenComputerStartExecParams,
    correlation?: CorrelationContext
  ): Promise<OpenComputerExecSessionResponse>;
}

class OpenComputerRestClient implements OpenComputerClient {
  constructor(readonly config: OpenComputerClientConfig) {}

  async createSandbox(
    params: OpenComputerCreateSandboxParams,
    correlation?: CorrelationContext
  ): Promise<OpenComputerSandboxResponse> {
    return this.request<OpenComputerSandboxResponse>("/sandboxes", {
      method: "POST",
      body: JSON.stringify(params),
      correlation,
      expectedStatuses: [201],
    });
  }

  async getSandbox(
    id: string,
    correlation?: CorrelationContext
  ): Promise<OpenComputerSandboxResponse> {
    return this.request<OpenComputerSandboxResponse>(`/sandboxes/${encodeURIComponent(id)}`, {
      method: "GET",
      correlation,
      expectedStatuses: [200],
    });
  }

  async hibernateSandbox(
    id: string,
    correlation?: CorrelationContext
  ): Promise<OpenComputerSandboxResponse> {
    return this.request<OpenComputerSandboxResponse>(
      `/sandboxes/${encodeURIComponent(id)}/hibernate`,
      {
        method: "POST",
        correlation,
        expectedStatuses: [200],
      }
    );
  }

  async wakeSandbox(
    id: string,
    timeout: number | undefined,
    correlation?: CorrelationContext
  ): Promise<OpenComputerSandboxResponse> {
    return this.request<OpenComputerSandboxResponse>(`/sandboxes/${encodeURIComponent(id)}/wake`, {
      method: "POST",
      body: JSON.stringify(timeout === undefined ? {} : { timeout }),
      correlation,
      expectedStatuses: [200],
    });
  }

  async setSandboxTimeout(
    id: string,
    timeout: number,
    correlation?: CorrelationContext
  ): Promise<void> {
    await this.request<void>(`/sandboxes/${encodeURIComponent(id)}/timeout`, {
      method: "POST",
      body: JSON.stringify({ timeout }),
      correlation,
      expectedStatuses: [204],
    });
  }

  async createCheckpoint(
    sandboxId: string,
    name: string,
    correlation?: CorrelationContext
  ): Promise<OpenComputerCheckpointResponse> {
    return this.request<OpenComputerCheckpointResponse>(
      `/sandboxes/${encodeURIComponent(sandboxId)}/checkpoints`,
      {
        method: "POST",
        body: JSON.stringify({ name }),
        correlation,
        expectedStatuses: [201],
      }
    );
  }

  async forkFromCheckpoint(
    checkpointId: string,
    params: OpenComputerForkFromCheckpointParams,
    correlation?: CorrelationContext
  ): Promise<OpenComputerSandboxResponse> {
    return this.request<OpenComputerSandboxResponse>(
      `/sandboxes/from-checkpoint/${encodeURIComponent(checkpointId)}`,
      {
        method: "POST",
        body: JSON.stringify(params),
        correlation,
        expectedStatuses: [201],
      }
    );
  }

  async startExecSession(
    sandboxId: string,
    params: OpenComputerStartExecParams,
    correlation?: CorrelationContext
  ): Promise<OpenComputerExecSessionResponse> {
    return this.request<OpenComputerExecSessionResponse>(
      `/sandboxes/${encodeURIComponent(sandboxId)}/exec`,
      {
        method: "POST",
        body: JSON.stringify(params),
        correlation,
        expectedStatuses: [201],
      }
    );
  }

  private async request<T>(
    path: string,
    options: {
      method: string;
      body?: string;
      correlation?: CorrelationContext;
      expectedStatuses: number[];
    }
  ): Promise<T> {
    const response = await fetch(`${this.config.apiUrl}${path}`, {
      method: options.method,
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": this.config.apiKey,
        ...(options.correlation?.trace_id ? { "X-Trace-ID": options.correlation.trace_id } : {}),
        ...(options.correlation?.request_id
          ? { "X-Request-ID": options.correlation.request_id }
          : {}),
      },
      body: options.body,
    });

    if (!options.expectedStatuses.includes(response.status)) {
      let message = `OpenComputer API request failed with HTTP ${response.status}`;
      try {
        const body = (await response.json()) as OpenComputerErrorBody;
        if (body.error) {
          message = body.error;
        }
      } catch {
        // Ignore parse failures and keep the generic message.
      }
      throw new OpenComputerApiError(message, response.status);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }
}

export function createOpenComputerClient(config: OpenComputerClientConfig): OpenComputerClient {
  return new OpenComputerRestClient({
    apiUrl: config.apiUrl.replace(/\/$/, ""),
    apiKey: config.apiKey,
  });
}
