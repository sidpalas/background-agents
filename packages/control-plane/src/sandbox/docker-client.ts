import { createLogger } from "../logger";
import type { CorrelationContext } from "../logger";

const log = createLogger("docker-sandbox-client");

export interface DockerSandboxCreateRequest {
  sandboxId: string;
  sessionId: string;
  envVars: Record<string, string>;
  labels?: Record<string, string>;
  timeoutSeconds?: number;
}

export interface DockerSandboxCreateResponse {
  sandboxId: string;
  providerObjectId: string;
  status: string;
  createdAt: number;
}

export interface DockerSandboxStopResponse {
  success: boolean;
  error?: string;
}

export class DockerSandboxApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "DockerSandboxApiError";
  }
}

interface DockerSandboxApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export class DockerSandboxClient {
  private readonly apiUrl: string;

  constructor(
    apiUrl: string,
    private readonly apiToken?: string
  ) {
    const normalized = apiUrl.trim().replace(/\/+$/, "");
    if (!normalized) {
      throw new Error("DockerSandboxClient requires apiUrl");
    }
    this.apiUrl = normalized;
  }

  private buildHeaders(correlation?: CorrelationContext): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiToken) {
      headers.Authorization = `Bearer ${this.apiToken}`;
    }
    if (correlation?.trace_id) headers["x-trace-id"] = correlation.trace_id;
    if (correlation?.request_id) headers["x-request-id"] = correlation.request_id;
    if (correlation?.session_id) headers["x-session-id"] = correlation.session_id;
    if (correlation?.sandbox_id) headers["x-sandbox-id"] = correlation.sandbox_id;
    return headers;
  }

  async createSandbox(
    request: DockerSandboxCreateRequest,
    correlation?: CorrelationContext
  ): Promise<DockerSandboxCreateResponse> {
    const response = await fetch(`${this.apiUrl}/sandboxes`, {
      method: "POST",
      headers: this.buildHeaders(correlation),
      body: JSON.stringify({
        sandboxId: request.sandboxId,
        sessionId: request.sessionId,
        envVars: request.envVars,
        labels: request.labels ?? {},
        timeoutSeconds: request.timeoutSeconds,
      }),
    });

    if (!response.ok) {
      throw new DockerSandboxApiError(
        `Docker sandbox create failed with HTTP ${response.status}`,
        response.status
      );
    }

    const payload =
      (await response.json()) as DockerSandboxApiResponse<DockerSandboxCreateResponse>;
    if (!payload.success || !payload.data) {
      throw new DockerSandboxApiError(
        payload.error || "Docker sandbox create failed",
        response.status
      );
    }

    log.debug("docker_sandbox.create.success", {
      sandbox_id: payload.data.sandboxId,
      provider_object_id: payload.data.providerObjectId,
    });

    return payload.data;
  }

  async stopSandbox(
    providerObjectId: string,
    correlation?: CorrelationContext
  ): Promise<DockerSandboxStopResponse> {
    const response = await fetch(
      `${this.apiUrl}/sandboxes/${encodeURIComponent(providerObjectId)}/stop`,
      {
        method: "POST",
        headers: this.buildHeaders(correlation),
      }
    );

    if (!response.ok) {
      throw new DockerSandboxApiError(
        `Docker sandbox stop failed with HTTP ${response.status}`,
        response.status
      );
    }

    const payload = (await response.json()) as DockerSandboxApiResponse<DockerSandboxStopResponse>;
    if (!payload.success || !payload.data) {
      throw new DockerSandboxApiError(
        payload.error || "Docker sandbox stop failed",
        response.status
      );
    }

    return payload.data;
  }
}

export function createDockerSandboxClient(apiUrl: string, apiToken?: string): DockerSandboxClient {
  return new DockerSandboxClient(apiUrl, apiToken);
}
