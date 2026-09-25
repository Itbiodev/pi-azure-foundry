import { describe, expect, it } from "vitest";
import { processResponsesEvents, resolveApiRoute, toResponsesInput, toResponsesRequest, toResponsesTools } from "./index.js";

const details = { contextWindow: 128000, maxTokens: 8192, reasoning: true, input: ["text"] as ("text" | "image")[], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, source: "fallback" as const };

describe("Responses routing", () => {
  it("routes GPT-6 while retaining legacy GPT-5 chat completions", () => {
    expect(resolveApiRoute({ name: "gpt-6-astra", modelName: "gpt-6", modelPublisher: "OpenAI" }, details)).toEqual({ kind: "openai-responses" });
    expect(resolveApiRoute({ name: "gpt-5.6-sol", modelName: "gpt-5.6", modelPublisher: "OpenAI" }, details)).toEqual({ kind: "openai-chat-completions", tokenLimit: "max_completion_tokens" });
  });
  it("honors per-model route overrides", () => {
    expect(resolveApiRoute({ name: "future", modelName: "gpt-7" }, { ...details, openaiRoute: "chat-completions" })).toEqual({ kind: "openai-chat-completions", tokenLimit: "max_tokens" });
    expect(resolveApiRoute({ name: "old", modelName: "custom" }, { ...details, openaiRoute: "responses" })).toEqual({ kind: "openai-responses" });
  });
});

describe("Responses request translation", () => {
  it("translates a multi-turn tool exchange", () => {
    const input = toResponsesInput("be useful", [
      { role: "user", content: "inspect it", timestamp: 1 },
      { role: "assistant", api: "azure-foundry", provider: "azure-foundry", model: "gpt-6", timestamp: 2, stopReason: "toolUse", usage: {} as any, content: [{ type: "toolCall", id: "call_1|fc_1", name: "read", arguments: { path: "a.ts" } }] },
      { role: "toolResult", toolCallId: "call_1|fc_1", toolName: "read", content: [{ type: "text", text: "contents" }], isError: false, timestamp: 3 },
    ] as any);
    expect(input).toEqual([
      { role: "developer", content: [{ type: "input_text", text: "be useful" }] },
      { role: "user", content: [{ type: "input_text", text: "inspect it" }] },
      { type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: '{"path":"a.ts"}' },
      { type: "function_call_output", call_id: "call_1", output: "contents" },
    ]);
    expect(toResponsesTools([{ name: "read", description: "Read", parameters: { type: "object" } } as any])).toEqual([{ type: "function", name: "read", description: "Read", parameters: { type: "object" }, strict: false }]);
  });
});

describe("Responses stream translation", () => {
  it("emits reasoning, function calls, usage, and tool-use completion", async () => {
    async function* events() {
      for (const event of [
        { type: "response.output_item.added", output_index: 0, item: { type: "reasoning" } },
        { type: "response.reasoning_summary_text.delta", output_index: 0, delta: "think" },
        { type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "rs_1", summary: [{ text: "think" }] } },
        { type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: "" } },
        { type: "response.function_call_arguments.delta", output_index: 1, delta: '{"path":' },
        { type: "response.function_call_arguments.delta", output_index: 1, delta: '"a.ts"}' },
        { type: "response.output_item.done", output_index: 1, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: '{"path":"a.ts"}' } },
        { type: "response.completed", response: { id: "resp_1", status: "completed", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, output_tokens_details: { reasoning_tokens: 2 } } } },
      ]) yield JSON.stringify(event);
    }
    const output: any = { content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} }, stopReason: "stop" };
    const emitted: any[] = [];
    await processResponsesEvents(events(), { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as any, output, { push: (e: any) => emitted.push(e) } as any);
    expect(output.content[1]).toMatchObject({ type: "toolCall", id: "call_1|fc_1", arguments: { path: "a.ts" } });
    expect(output.usage).toMatchObject({ input: 10, output: 5, reasoning: 2, totalTokens: 15 });
    expect(output.stopReason).toBe("toolUse");
    expect(emitted.map((e) => e.type)).toContain("toolcall_end");
  });
});

describe("Responses reasoning replay", () => {
  it("requests encrypted reasoning and replays it on the next stateless turn", async () => {
    const model: any = { id: "gpt-6-astra", reasoning: true, maxTokens: 128000, thinkingLevelMap: { high: "high" }, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const tools = [{ name: "read", description: "Read", parameters: { type: "object" } }] as any;
    const first = toResponsesRequest(model, { messages: [{ role: "user", content: "inspect it", timestamp: 1 }], tools } as any, { reasoning: "high" } as any);
    expect(first).toMatchObject({ store: false, reasoning: { effort: "high" }, include: ["reasoning.encrypted_content"] });

    const reasoningItem = { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "think" }], encrypted_content: "enc_abc" };
    async function* events() {
      for (const event of [
        { type: "response.output_item.added", output_index: 0, item: { type: "reasoning" } },
        { type: "response.output_item.done", output_index: 0, item: reasoningItem },
        { type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: "" } },
        { type: "response.output_item.done", output_index: 1, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: '{"path":"a.ts"}' } },
        { type: "response.completed", response: { id: "resp_1" } },
      ]) yield JSON.stringify(event);
    }
    const assistant: any = { role: "assistant", content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} }, stopReason: "stop", timestamp: 2 };
    await processResponsesEvents(events(), model, assistant, { push: () => {} } as any);

    const second = toResponsesRequest(model, { messages: [
      { role: "user", content: "inspect it", timestamp: 1 },
      assistant,
      { role: "toolResult", toolCallId: "call_1|fc_1", toolName: "read", content: [{ type: "text", text: "contents" }], isError: false, timestamp: 3 },
    ], tools } as any, { reasoning: "high" } as any);
    expect((second.input as unknown[]).slice(1)).toEqual([
      reasoningItem,
      { type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: '{"path":"a.ts"}' },
      { type: "function_call_output", call_id: "call_1", output: "contents" },
    ]);
  });

  it("omits reasoning includes for non-reasoning models", () => {
    const body = toResponsesRequest({ id: "m", reasoning: false, maxTokens: 100 } as any, { messages: [] } as any, undefined);
    expect(body.include).toBeUndefined();
    expect(body.reasoning).toBeUndefined();
  });
});
