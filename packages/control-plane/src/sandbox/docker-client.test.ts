import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DockerSandboxApiError,
  DockerSandboxClient,
  type DockerSandboxCreateResponse,
} from "./docker-client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DockerSandboxClient", () => {
  it("throws when apiUrl is missing", () => {
    expect(() => new DockerSandboxClient("")).toThrow("requires apiUrl");
  });

  it("creates a sandbox with auth headers", async () => {
    const client = new DockerSandboxClient("http://docker-sandbox-api:8788/", "secret-token");
    const data: DockerSandboxCreateResponse = {
      sandboxId: "sandbox-1",
      providerObjectId: "container-1",
      status: "running",
      createdAt: 123,
    };
    fetchSpy.mockResolvedValue(jsonResponse({ success: true, data }));

    const result = await client.createSandbox({
      sandboxId: "sandbox-1",
      sessionId: "session-1",
      envVars: { FOO: "bar" },
      labels: { app: "open-inspect" },
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://docker-sandbox-api:8788/sandboxes",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer secret-token",
          "Content-Type": "application/json",
        }),
      })
    );
    expect(result).toEqual(data);
  });

  it("throws DockerSandboxApiError on non-OK responses", async () => {
    const client = new DockerSandboxClient("http://docker-sandbox-api:8788");
    fetchSpy.mockResolvedValue(new Response("boom", { status: 503 }));

    await expect(client.stopSandbox("container-1")).rejects.toBeInstanceOf(DockerSandboxApiError);
  });
});
