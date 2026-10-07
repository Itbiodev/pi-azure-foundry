import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs")>(),
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(() => JSON.stringify({
    resourceId: "test-resource",
    projectId: "test-project",
    auth: { type: "api-key", apiKey: "test-only-placeholder" },
  })),
}));

import extension from "./index.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("extension entry", () => {
  it("discovers chat deployments and registers the provider", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ value: [
      { name: "chat", modelName: "gpt-6", modelPublisher: "OpenAI", capabilities: { chat_completion: "true" } },
      { name: "embedding", capabilities: { embeddings: "true" } },
    ] })));
    vi.stubGlobal("fetch", fetchMock);
    const registerProvider = vi.fn();

    await extension({ registerProvider } as unknown as ExtensionAPI);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://test-resource.services.ai.azure.com/api/projects/test-project/deployments?api-version=v1",
      { headers: { Authorization: "Bearer test-only-placeholder" } },
    );
    expect(registerProvider).toHaveBeenCalledOnce();
    expect(registerProvider).toHaveBeenCalledWith("azure-foundry", expect.objectContaining({
      name: "Azure Foundry",
      streamSimple: expect.any(Function),
      models: [expect.objectContaining({ id: "chat" })],
    }));
  });
});
