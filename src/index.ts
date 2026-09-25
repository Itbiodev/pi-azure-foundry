/**
 * Azure Foundry Extension
 *
 * Discovers models from Azure AI Foundry Deployments API and registers them with pi.
 * Routes to the correct API based on model publisher:
 *   - Anthropic → native Messages API at /anthropic/v1/messages
 *   - GPT-6+ → OpenAI Responses API at /openai/v1/responses
 *   - Other OpenAI-compatible models → /openai/deployments/{id}/chat/completions
 *
 * Config: ./azure-foundry.config.json
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type Api,
  type Message,
  type Tool,
  type TextContent,
  type ImageContent,
  type ThinkingContent,
  type ToolResultMessage,
  type ModelCost,
  calculateCost,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models";
import { MISTRAL_MODELS } from "@earendil-works/pi-ai/providers/mistral.models";
import { FIREWORKS_MODELS } from "@earendil-works/pi-ai/providers/fireworks.models";
import { HUGGINGFACE_MODELS } from "@earendil-works/pi-ai/providers/huggingface.models";
import { ZAI_MODELS } from "@earendil-works/pi-ai/providers/zai.models";
import { MINIMAX_MODELS } from "@earendil-works/pi-ai/providers/minimax.models";
import { DEEPSEEK_MODELS } from "@earendil-works/pi-ai/providers/deepseek.models";
import { XAI_MODELS } from "@earendil-works/pi-ai/providers/xai.models";
import { MOONSHOTAI_MODELS } from "@earendil-works/pi-ai/providers/moonshotai.models";
import { MOONSHOTAI_CN_MODELS } from "@earendil-works/pi-ai/providers/moonshotai-cn.models";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { DefaultAzureCredential, type AccessToken } from "@azure/identity";

// =============================================================================
// Config & Types
// =============================================================================

type AuthConfig =
  | { type: "api-key"; apiKey: string }
  | { type: "azure-identity" };

type OpenAITokenLimitParam = "max_tokens" | "max_completion_tokens";
type OpenAIRouteOverride = "responses" | "chat-completions";

interface ModelConfigOverride {
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  cost?: ModelCost;
  openaiTokenLimit?: OpenAITokenLimitParam;
  /** Force this model onto the Responses or legacy chat-completions route. */
  openaiRoute?: OpenAIRouteOverride;
}

interface Config {
  resourceId: string;
  projectId: string;
  auth: AuthConfig;
  models?: Record<string, ModelConfigOverride>;
}

// =============================================================================
// Token Provider
// =============================================================================

/** Azure AI Foundry scope for Entra ID tokens */
const AZURE_AI_SCOPE = "https://ai.azure.com/.default";

/** Cached token — refreshed when within 5 min of expiry */
let cachedToken: AccessToken | null = null;

async function getIdentityToken(): Promise<string> {
  const now = Date.now();
  const expiryBuffer = 5 * 60 * 1000; // 5 minutes
  if (cachedToken && cachedToken.expiresOnTimestamp - now > expiryBuffer) {
    return cachedToken.token;
  }
  const credential = new DefaultAzureCredential();
  cachedToken = await credential.getToken(AZURE_AI_SCOPE);
  if (!cachedToken) throw new Error("[Azure Foundry] Failed to acquire identity token");
  return cachedToken.token;
}

/**
 * Returns a token getter function appropriate for the configured auth type.
 * For api-key: always returns the static key.
 * For azure-identity: fetches/caches an Entra ID token via DefaultAzureCredential.
 */
function makeTokenGetter(auth: AuthConfig): () => Promise<string> {
  if (auth.type === "api-key") {
    return () => Promise.resolve(auth.apiKey);
  }
  return getIdentityToken;
}

interface Deployment {
  name: string;
  modelName?: string;
  modelPublisher?: string;
  capabilities?: Record<string, string>;
}

function loadConfig(): Config {
  // Search order: project root → ~/.pi/azure-foundry.config.json
  const candidates = [
    resolve(process.cwd(), "azure-foundry.config.json"),
    resolve(homedir(), ".pi", "azure-foundry.config.json"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      console.log(`[Azure Foundry] Loading config from: ${p}`);
      return JSON.parse(readFileSync(p, "utf-8"));
    }
  }
  throw new Error(
    `azure-foundry.config.json not found. Checked:\n` +
    candidates.map((p) => `  ${p}`).join("\n") +
    `\n\nCreate one in your project root or at ~/.pi/azure-foundry.config.json`
  );
}

// =============================================================================
// Deployment → Model mapping
// =============================================================================

interface ResolvedModelDetails {
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: ModelCost;
  thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
  openaiTokenLimit?: OpenAITokenLimitParam;
  openaiRoute?: OpenAIRouteOverride;
  source: "config" | "catalog" | "fallback";
}

const ZERO_COST: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const FALLBACK: ResolvedModelDetails = {
  contextWindow: 128000,
  maxTokens: 4096,
  reasoning: false,
  input: ["text"],
  cost: ZERO_COST,
  source: "fallback",
};

/** Lower-case a model/catalog name so Azure and pi-ai ids can be matched. */
function normalizeModelName(name: string): string {
  return name.toLowerCase();
}

/** Build a map from normalized model id to pi-ai's built-in model metadata. */
function buildKnownModelCatalog(): Map<string, Model<Api>> {
  const catalog = new Map<string, Model<Api>>();
  const providerCatalogs = [
    ANTHROPIC_MODELS,
    OPENAI_MODELS,
    MISTRAL_MODELS,
    FIREWORKS_MODELS,
    HUGGINGFACE_MODELS,
    ZAI_MODELS,
    MINIMAX_MODELS,
    DEEPSEEK_MODELS,
    XAI_MODELS,
    MOONSHOTAI_MODELS,
    MOONSHOTAI_CN_MODELS,
  ];
  for (const models of providerCatalogs) {
    for (const model of Object.values(models)) {
      const key = normalizeModelName(model.id);
      if (catalog.has(key)) continue;
      catalog.set(key, model as Model<Api>);
    }
  }
  return catalog;
}

/**
 * Resolve model details in precedence order:
 *   1. User override in azure-foundry.config.json (exact Azure modelName)
 *   2. pi-ai built-in model catalog (normalized id match)
 *   3. Conservative fallback defaults
 */
function resolveModelDetails(
  modelName: string,
  catalog: Map<string, Model<Api>>,
  overrides: Record<string, ModelConfigOverride> | undefined,
): ResolvedModelDetails {
  const override = overrides?.[modelName];
  const catalogModel = catalog.get(normalizeModelName(modelName));

  // Start with catalog metadata, or the conservative fallback if unknown.
  const base: ResolvedModelDetails = catalogModel
    ? (() => {
        const compatMaxTokensField = (catalogModel as any).compat?.maxTokensField;
        return {
          contextWindow: catalogModel.contextWindow,
          maxTokens: catalogModel.maxTokens,
          reasoning: catalogModel.reasoning,
          input: catalogModel.input,
          cost: catalogModel.cost,
          thinkingLevelMap: catalogModel.thinkingLevelMap,
          openaiTokenLimit:
            compatMaxTokensField === "max_tokens" || compatMaxTokensField === "max_completion_tokens"
              ? compatMaxTokensField
              : undefined,
          source: "catalog",
        };
      })()
    : FALLBACK;

  if (!override) return base;

  // Apply only the override keys that are present.
  return {
    ...base,
    ...override,
    cost: {
      ...base.cost,
      ...override.cost // spreading undefined in JS is fine
    },
    source: "config",
  };
}

/** Per-deployment API route resolved at discovery time */
export type ApiRoute =
  | { kind: "anthropic-messages" }
  | { kind: "openai-responses" }
  | { kind: "openai-chat-completions"; tokenLimit: OpenAITokenLimitParam };

const apiRouteMap = new Map<string, ApiRoute>();

/** Infer OpenAI-compat token limit from resolved metadata or model name patterns. */
function inferOpenAITokenLimit(modelName: string, resolved: ResolvedModelDetails): OpenAITokenLimitParam {
  if (resolved.openaiTokenLimit) return resolved.openaiTokenLimit;
  // GPT-5 and o-series models reject max_tokens on Azure/OpenAI chat completions
  if (/^(gpt-5|o[1-9])([-.]|$)/i.test(modelName)) return "max_completion_tokens";
  return "max_tokens";
}

function isGpt6Plus(modelName: string): boolean {
  return /^gpt-(?:[6-9]|[1-9][0-9])(?:[-.]|$)/i.test(modelName);
}

export function resolveApiRoute(d: Deployment, resolved: ResolvedModelDetails): ApiRoute {
  if (d.modelPublisher === "Anthropic") return { kind: "anthropic-messages" };
  if (resolved.openaiRoute === "responses") return { kind: "openai-responses" };
  const modelName = d.modelName ?? d.name;
  if (resolved.openaiRoute !== "chat-completions" && isGpt6Plus(modelName)) {
    return { kind: "openai-responses" };
  }
  return { kind: "openai-chat-completions", tokenLimit: inferOpenAITokenLimit(modelName, resolved) };
}

function describeApiRoute(route: ApiRoute): string {
  if (route.kind === "anthropic-messages") return "anthropic-messages";
  if (route.kind === "openai-responses") return "openai-responses";
  return `openai-chat-completions (${route.tokenLimit})`;
}

/** Auth context per-provider, keyed by provider id */
interface ProviderAuth {
  type: AuthConfig["type"];
  getToken: () => Promise<string>;
}
const providerAuthMap = new Map<string, ProviderAuth>();

function deploymentToModel(
  d: Deployment,
  catalog: Map<string, Model<Api>>,
  overrides: Record<string, ModelConfigOverride> | undefined,
) {
  const modelName = d.modelName ?? d.name;
  let details = resolveModelDetails(modelName, catalog, overrides);
  // GPT-6 deployments predate their pi-ai catalog entries. Avoid presenting them
  // as non-reasoning 4K models while still allowing every field to be overridden.
  if (isGpt6Plus(modelName)) {
    const hasCatalogEntry = catalog.has(normalizeModelName(modelName));
    details = {
      ...details,
      contextWindow: overrides?.[modelName]?.contextWindow ?? (hasCatalogEntry ? details.contextWindow : 1_000_000),
      maxTokens: overrides?.[modelName]?.maxTokens ?? (hasCatalogEntry ? details.maxTokens : 128_000),
      reasoning: overrides?.[modelName]?.reasoning ?? true,
      thinkingLevelMap: details.thinkingLevelMap ?? { off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "xhigh" },
    };
  }
  apiRouteMap.set(d.name, resolveApiRoute(d, details));

  const model = {
    id: d.name,
    name: modelName,
    reasoning: details.reasoning,
    input: details.input,
    cost: details.cost,
    contextWindow: details.contextWindow,
    maxTokens: details.maxTokens,
    thinkingLevelMap: details.thinkingLevelMap,
  };

  if (details.source === "fallback") {
    console.log(`[Azure Foundry] ${d.name}: no metadata for "${modelName}" — using fallback defaults`);
  } else if (details.source === "config") {
    console.log(`[Azure Foundry] ${d.name}: using config override for "${modelName}"`);
  }

  return model;
}

// =============================================================================
// SSE Stream Parser
// =============================================================================

export async function* parseSSE(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("data: ")) {
        const data = trimmed.slice(6);
        if (data === "[DONE]") return;
        yield data;
      }
    }
  }
}

// =============================================================================
// OpenAI-format message conversion  (for OpenAI / MoonshotAI / etc.)
// =============================================================================

function toOpenAIMessages(systemPrompt: string | undefined, messages: Message[]): unknown[] {
  const out: unknown[] = [];
  if (systemPrompt) out.push({ role: "system", content: systemPrompt });

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        out.push({ role: "user", content: msg.content });
      } else {
        out.push({ role: "user", content: msg.content.map((c) =>
          c.type === "text"  ? { type: "text", text: (c as TextContent).text } :
          c.type === "image" ? { type: "image_url", image_url: { url: `data:${(c as ImageContent).mimeType};base64,${(c as ImageContent).data}` } } :
          { type: "text", text: "" }
        )});
      }
    } else if (msg.role === "assistant") {
      const entry: Record<string, unknown> = { role: "assistant" };
      const text = msg.content.filter((b) => b.type === "text").map((b) => (b as TextContent).text).join("\n");
      const tcs = msg.content.filter((b) => b.type === "toolCall").map((b) => ({
        id: (b as any).id, type: "function", function: { name: (b as any).name, arguments: JSON.stringify((b as any).arguments) },
      }));
      if (text) entry.content = text;
      if (tcs.length) entry.tool_calls = tcs;
      out.push(entry);
    } else if (msg.role === "toolResult") {
      const m = msg as ToolResultMessage;
      out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content.filter((c): c is TextContent => c.type === "text").map((c) => c.text).join("\n") });
    }
  }
  return out;
}

function toOpenAITools(tools: Tool[]): unknown[] {
  return tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

// =============================================================================
// OpenAI Responses-format conversion
// =============================================================================

export function toResponsesInput(systemPrompt: string | undefined, messages: Message[]): unknown[] {
  const input: unknown[] = [];
  if (systemPrompt) input.push({ role: "developer", content: [{ type: "input_text", text: systemPrompt }] });
  for (const msg of messages) {
    if (msg.role === "user") {
      const content = typeof msg.content === "string"
        ? [{ type: "input_text", text: msg.content }]
        : msg.content.map((c) => c.type === "image"
          ? { type: "input_image", detail: "auto", image_url: `data:${(c as ImageContent).mimeType};base64,${(c as ImageContent).data}` }
          : { type: "input_text", text: (c as TextContent).text });
      input.push({ role: "user", content });
    } else if (msg.role === "assistant") {
      for (const block of msg.content) {
        if (block.type === "thinking" && block.thinkingSignature) {
          try { input.push(JSON.parse(block.thinkingSignature)); } catch { /* only replay valid opaque response items */ }
        } else if (block.type === "text") {
          input.push({ role: "assistant", content: [{ type: "output_text", text: block.text }] });
        } else if (block.type === "toolCall") {
          const [callId, itemId] = block.id.split("|");
          input.push({ type: "function_call", ...(itemId ? { id: itemId } : {}), call_id: callId, name: block.name, arguments: JSON.stringify(block.arguments) });
        }
      }
    } else if (msg.role === "toolResult") {
      const text = msg.content.filter((c): c is TextContent => c.type === "text").map((c) => c.text).join("\n");
      input.push({ type: "function_call_output", call_id: msg.toolCallId.split("|")[0], output: text || "(no tool output)" });
    }
  }
  return input;
}

export function toResponsesTools(tools: Tool[]): unknown[] {
  return tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters, strict: false }));
}

// =============================================================================
// Anthropic-format message conversion
// =============================================================================

function toAnthropicMessages(messages: Message[]): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        out.push({ role: "user", content: msg.content });
      } else {
        out.push({ role: "user", content: msg.content.map((c) =>
          c.type === "text" ? { type: "text", text: (c as TextContent).text } :
          c.type === "image" ? { type: "image", source: { type: "base64", media_type: (c as ImageContent).mimeType, data: (c as ImageContent).data } } :
          { type: "text", text: "" }
        )});
      }
    } else if (msg.role === "assistant") {
      const blocks: unknown[] = [];
      for (const b of msg.content) {
        if (b.type === "text" && (b as TextContent).text.trim()) blocks.push({ type: "text", text: (b as TextContent).text });
        if (b.type === "thinking") blocks.push({ type: "thinking", thinking: (b as ThinkingContent).thinking, signature: (b as ThinkingContent).thinkingSignature ?? "" });
        if (b.type === "toolCall") blocks.push({ type: "tool_use", id: (b as any).id, name: (b as any).name, input: (b as any).arguments });
      }
      if (blocks.length) out.push({ role: "assistant", content: blocks });
    } else if (msg.role === "toolResult") {
      const m = msg as ToolResultMessage;
      const text = m.content.filter((c): c is TextContent => c.type === "text").map((c) => c.text).join("\n");
      // Anthropic tool results go inside a user message
      out.push({ role: "user", content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: text, is_error: m.isError }] });
    }
  }
  return out;
}

function toAnthropicTools(tools: Tool[]): unknown[] {
  return tools.map((t) => ({
    name: t.name, description: t.description,
    input_schema: { type: "object", properties: (t.parameters as any).properties ?? {}, required: (t.parameters as any).required ?? [] },
  }));
}

// =============================================================================
// OpenAI-compatible streaming (OpenAI, MoonshotAI, etc.)
// =============================================================================

function streamOpenAI(
  model: Model<Api>, context: Context, options: SimpleStreamOptions | undefined,
  output: AssistantMessage, stream: ReturnType<typeof createAssistantMessageEventStream>,
  baseHost: string, auth: ProviderAuth, route: Extract<ApiRoute, { kind: "openai-chat-completions" }>,
): Promise<void> {
  return (async () => {
    const url = `${baseHost}/openai/deployments/${model.id}/chat/completions?api-version=2024-10-21`;
    const maxOutput = options?.maxTokens ?? model.maxTokens;
    const body: Record<string, unknown> = {
      messages: toOpenAIMessages(context.systemPrompt, context.messages),
      [route.tokenLimit]: maxOutput,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (context.tools?.length) body.tools = toOpenAITools(context.tools);

    const token = await auth.getToken();
    // OpenAI-compat route: api-key auth uses the "api-key" header;
    // Entra ID (azure-identity) uses "Authorization: Bearer".
    const authHeaders: Record<string, string> =
      auth.type === "api-key"
        ? { "api-key": token }
        : { "Authorization": `Bearer ${token}` };
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify(body),
      signal: options?.signal,
    });
    if (!response.ok) {
      const t = await response.text().catch(() => "");
      throw new Error(`Azure Foundry ${response.status}: ${t.slice(0, 500)}`);
    }
    if (!response.body) throw new Error("No response body");

    stream.push({ type: "start", partial: output });

    const tcJsonBufs = new Map<number, string>();
    const tcContentIdx = new Map<number, number>();
    const reader = response.body.getReader();

    for await (const data of parseSSE(reader)) {
      let chunk: any;
      try { chunk = JSON.parse(data); } catch { continue; }

      if (chunk.usage) {
        output.usage.input = chunk.usage.prompt_tokens ?? 0;
        output.usage.output = chunk.usage.completion_tokens ?? 0;
        output.usage.totalTokens = chunk.usage.total_tokens ?? 0;
        calculateCost(model, output.usage);
      }

      const choice = chunk.choices?.[0];
      if (!choice?.delta) continue;
      const delta = choice.delta;

      if (typeof delta.content === "string") {
        let idx = output.content.findIndex((b) => b.type === "text");
        if (idx === -1) { output.content.push({ type: "text", text: "" }); idx = output.content.length - 1; stream.push({ type: "text_start", contentIndex: idx, partial: output }); }
        const block = output.content[idx]; if (block.type === "text") { block.text += delta.content; stream.push({ type: "text_delta", contentIndex: idx, delta: delta.content, partial: output }); }
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const tci = tc.index ?? 0;
          if (tc.id) {
            output.content.push({ type: "toolCall", id: tc.id, name: tc.function?.name ?? "", arguments: {} });
            const ci = output.content.length - 1; tcContentIdx.set(tci, ci); tcJsonBufs.set(tci, "");
            stream.push({ type: "toolcall_start", contentIndex: ci, partial: output });
          }
          if (tc.function?.arguments) {
            const ci = tcContentIdx.get(tci); if (ci === undefined) continue;
            const buf = (tcJsonBufs.get(tci) ?? "") + tc.function.arguments; tcJsonBufs.set(tci, buf);
            const block = output.content[ci]; if (block.type === "toolCall") { try { block.arguments = JSON.parse(buf); } catch {} }
            stream.push({ type: "toolcall_delta", contentIndex: ci, delta: tc.function.arguments, partial: output });
          }
        }
      }

      if (choice.finish_reason === "stop") output.stopReason = "stop";
      else if (choice.finish_reason === "length") output.stopReason = "length";
      else if (choice.finish_reason === "tool_calls") output.stopReason = "toolUse";
    }

    // Finalize blocks
    for (let i = 0; i < output.content.length; i++) { if (output.content[i].type === "text") stream.push({ type: "text_end", contentIndex: i, content: (output.content[i] as TextContent).text, partial: output }); }
    for (const [tci, ci] of tcContentIdx) { const b = output.content[ci]; if (b.type === "toolCall") { try { b.arguments = JSON.parse(tcJsonBufs.get(tci) ?? "{}"); } catch {} stream.push({ type: "toolcall_end", contentIndex: ci, toolCall: b, partial: output }); } }
  })();
}

// =============================================================================
// OpenAI Responses API streaming
// =============================================================================

export async function processResponsesEvents(
  events: AsyncIterable<string>, model: Model<Api>, output: AssistantMessage,
  stream: ReturnType<typeof createAssistantMessageEventStream>,
): Promise<void> {
  const slots = new Map<number, { contentIndex: number; json?: string }>();
  let terminal = false;
  for await (const data of events) {
    let event: any;
    try { event = JSON.parse(data); } catch { continue; }
    if (event.type === "response.output_item.added") {
      const item = event.item;
      if (item.type === "reasoning") {
        output.content.push({ type: "thinking", thinking: "" });
        slots.set(event.output_index, { contentIndex: output.content.length - 1 });
        stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
      } else if (item.type === "message") {
        output.content.push({ type: "text", text: "" });
        slots.set(event.output_index, { contentIndex: output.content.length - 1 });
        stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
      } else if (item.type === "function_call") {
        output.content.push({ type: "toolCall", id: `${item.call_id}|${item.id}`, name: item.name, arguments: {} });
        slots.set(event.output_index, { contentIndex: output.content.length - 1, json: item.arguments ?? "" });
        stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
      }
    } else if (event.type === "response.reasoning_summary_text.delta" || event.type === "response.reasoning_text.delta") {
      const slot = slots.get(event.output_index); const block = slot && output.content[slot.contentIndex];
      if (slot && block?.type === "thinking") { block.thinking += event.delta; stream.push({ type: "thinking_delta", contentIndex: slot.contentIndex, delta: event.delta, partial: output }); }
    } else if (event.type === "response.output_text.delta" || event.type === "response.refusal.delta") {
      const slot = slots.get(event.output_index); const block = slot && output.content[slot.contentIndex];
      if (slot && block?.type === "text") { block.text += event.delta; stream.push({ type: "text_delta", contentIndex: slot.contentIndex, delta: event.delta, partial: output }); }
    } else if (event.type === "response.function_call_arguments.delta") {
      const slot = slots.get(event.output_index); const block = slot && output.content[slot.contentIndex];
      if (slot && block?.type === "toolCall") { slot.json = (slot.json ?? "") + event.delta; try { block.arguments = JSON.parse(slot.json); } catch {} stream.push({ type: "toolcall_delta", contentIndex: slot.contentIndex, delta: event.delta, partial: output }); }
    } else if (event.type === "response.output_item.done") {
      const slot = slots.get(event.output_index); if (!slot) continue;
      const block = output.content[slot.contentIndex]; const item = event.item;
      if (block.type === "thinking") { block.thinking = item.summary?.map((s: any) => s.text).join("\n\n") || item.content?.map((c: any) => c.text).join("\n\n") || block.thinking; block.thinkingSignature = JSON.stringify(item); stream.push({ type: "thinking_end", contentIndex: slot.contentIndex, content: block.thinking, partial: output }); }
      else if (block.type === "text") { block.text = item.content?.map((c: any) => c.text ?? c.refusal ?? "").join("") || block.text; stream.push({ type: "text_end", contentIndex: slot.contentIndex, content: block.text, partial: output }); }
      else if (block.type === "toolCall") { try { block.arguments = JSON.parse(item.arguments || slot.json || "{}"); } catch {} stream.push({ type: "toolcall_end", contentIndex: slot.contentIndex, toolCall: block, partial: output }); }
      slots.delete(event.output_index);
    } else if (event.type === "response.completed" || event.type === "response.incomplete") {
      terminal = true; const response = event.response; const usage = response?.usage;
      if (response?.id) output.responseId = response.id;
      if (usage) { const cached = usage.input_tokens_details?.cached_tokens ?? 0; output.usage.input = Math.max(0, (usage.input_tokens ?? 0) - cached); output.usage.cacheRead = cached; output.usage.output = usage.output_tokens ?? 0; output.usage.reasoning = usage.output_tokens_details?.reasoning_tokens ?? 0; output.usage.totalTokens = usage.total_tokens ?? 0; calculateCost(model, output.usage); }
      output.stopReason = event.type === "response.incomplete" ? "length" : output.content.some((b) => b.type === "toolCall") ? "toolUse" : "stop";
    } else if (event.type === "error" || event.type === "response.failed") {
      const err = event.message ?? event.response?.error?.message ?? event.response?.incomplete_details?.reason ?? "unknown Responses API error";
      throw new Error(err);
    }
  }
  if (!terminal) throw new Error("Azure Foundry Responses stream ended before a terminal event");
}

export function toResponsesRequest(model: Model<Api>, context: Context, options: SimpleStreamOptions | undefined): Record<string, unknown> {
  const body: Record<string, unknown> = { model: model.id, input: toResponsesInput(context.systemPrompt, context.messages), stream: true, store: false, max_output_tokens: Math.max(16, options?.maxTokens ?? model.maxTokens) };
  if (context.tools?.length) body.tools = toResponsesTools(context.tools);
  if (model.reasoning) {
    const level = options?.reasoning ?? "medium";
    const effort = model.thinkingLevelMap?.[level] ?? level;
    if (effort) {
      body.reasoning = { effort, summary: "auto" };
      body.include = ["reasoning.encrypted_content"];
    }
  }
  return body;
}

function streamResponses(
  model: Model<Api>, context: Context, options: SimpleStreamOptions | undefined,
  output: AssistantMessage, stream: ReturnType<typeof createAssistantMessageEventStream>,
  baseHost: string, auth: ProviderAuth,
): Promise<void> {
  return (async () => {
    const body = toResponsesRequest(model, context, options);
    const token = await auth.getToken();
    const authHeaders: Record<string, string> = auth.type === "api-key" ? { "api-key": token } : { Authorization: `Bearer ${token}` };
    const response = await fetch(`${baseHost}/openai/v1/responses`, { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders }, body: JSON.stringify(body), signal: options?.signal });
    if (!response.ok) { const text = await response.text().catch(() => ""); throw new Error(`Azure Foundry ${response.status}: ${text.slice(0, 500)}`); }
    if (!response.body) throw new Error("No response body");
    stream.push({ type: "start", partial: output });
    await processResponsesEvents(parseSSE(response.body.getReader()), model, output, stream);
  })();
}

// =============================================================================
// Anthropic Messages API streaming
// =============================================================================

function streamAnthropic(
  model: Model<Api>, context: Context, options: SimpleStreamOptions | undefined,
  output: AssistantMessage, stream: ReturnType<typeof createAssistantMessageEventStream>,
  baseHost: string, auth: ProviderAuth,
): Promise<void> {
  return (async () => {
    const url = `${baseHost}/anthropic/v1/messages`;
    const body: Record<string, unknown> = {
      model: model.id,
      messages: toAnthropicMessages(context.messages),
      max_tokens: options?.maxTokens ?? model.maxTokens,
      stream: true,
    };
    if (context.systemPrompt) body.system = context.systemPrompt;
    if (context.tools?.length) body.tools = toAnthropicTools(context.tools);

    const token = await auth.getToken();
    // Anthropic route on Azure Foundry always uses "Authorization: Bearer"
    // regardless of auth type — api-key values are valid Bearer tokens here.
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: options?.signal,
    });
    if (!response.ok) {
      const t = await response.text().catch(() => "");
      throw new Error(`Azure Foundry ${response.status}: ${t.slice(0, 500)}`);
    }
    if (!response.body) throw new Error("No response body");

    stream.push({ type: "start", partial: output });

    // Anthropic SSE events: message_start, content_block_start, content_block_delta, content_block_stop, message_delta, message_stop
    const blockIndices = new Map<number, number>(); // anthropic block index → output.content index
    const tcJsonBufs = new Map<number, string>();
    const reader = response.body.getReader();

    for await (const data of parseSSE(reader)) {
      let event: any;
      try { event = JSON.parse(data); } catch { continue; }

      if (event.type === "message_start" && event.message?.usage) {
        output.usage.input = event.message.usage.input_tokens ?? 0;
        output.usage.cacheRead = event.message.usage.cache_read_input_tokens ?? 0;
        output.usage.cacheWrite = event.message.usage.cache_creation_input_tokens ?? 0;
      }

      if (event.type === "content_block_start") {
        const cb = event.content_block;
        const anthropicIdx = event.index;
        if (cb.type === "text") {
          output.content.push({ type: "text", text: "" });
          const ci = output.content.length - 1;
          blockIndices.set(anthropicIdx, ci);
          stream.push({ type: "text_start", contentIndex: ci, partial: output });
        } else if (cb.type === "thinking") {
          output.content.push({ type: "thinking", thinking: "", thinkingSignature: "" } as ThinkingContent);
          blockIndices.set(anthropicIdx, output.content.length - 1);
          stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
        } else if (cb.type === "tool_use") {
          output.content.push({ type: "toolCall", id: cb.id, name: cb.name, arguments: {} });
          const ci = output.content.length - 1;
          blockIndices.set(anthropicIdx, ci);
          tcJsonBufs.set(anthropicIdx, "");
          stream.push({ type: "toolcall_start", contentIndex: ci, partial: output });
        }
      }

      if (event.type === "content_block_delta") {
        const ci = blockIndices.get(event.index);
        if (ci === undefined) continue;
        const block = output.content[ci];
        const d = event.delta;

        if (d.type === "text_delta" && block.type === "text") {
          block.text += d.text;
          stream.push({ type: "text_delta", contentIndex: ci, delta: d.text, partial: output });
        } else if (d.type === "thinking_delta" && block.type === "thinking") {
          (block as ThinkingContent).thinking += d.thinking;
          stream.push({ type: "thinking_delta", contentIndex: ci, delta: d.thinking, partial: output });
        } else if (d.type === "signature_delta" && block.type === "thinking") {
          (block as ThinkingContent).thinkingSignature = ((block as ThinkingContent).thinkingSignature ?? "") + d.signature;
        } else if (d.type === "input_json_delta" && block.type === "toolCall") {
          const buf = (tcJsonBufs.get(event.index) ?? "") + d.partial_json;
          tcJsonBufs.set(event.index, buf);
          try { block.arguments = JSON.parse(buf); } catch {}
          stream.push({ type: "toolcall_delta", contentIndex: ci, delta: d.partial_json, partial: output });
        }
      }

      if (event.type === "content_block_stop") {
        const ci = blockIndices.get(event.index);
        if (ci === undefined) continue;
        const block = output.content[ci];
        if (block.type === "text") stream.push({ type: "text_end", contentIndex: ci, content: block.text, partial: output });
        else if (block.type === "thinking") stream.push({ type: "thinking_end", contentIndex: ci, content: (block as ThinkingContent).thinking, partial: output });
        else if (block.type === "toolCall") {
          try { block.arguments = JSON.parse(tcJsonBufs.get(event.index) ?? "{}"); } catch {}
          stream.push({ type: "toolcall_end", contentIndex: ci, toolCall: block, partial: output });
        }
      }

      if (event.type === "message_delta") {
        if (event.usage) {
          output.usage.output = event.usage.output_tokens ?? 0;
          output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
          calculateCost(model, output.usage);
        }
        const sr = event.delta?.stop_reason;
        if (sr === "end_turn" || sr === "stop_sequence") output.stopReason = "stop";
        else if (sr === "max_tokens") output.stopReason = "length";
        else if (sr === "tool_use") output.stopReason = "toolUse";
      }
    }
  })();
}

// =============================================================================
// Unified streamSimple — routes based on publisher
// =============================================================================

function streamAzureFoundry(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    try {
      const baseHost = new URL(model.baseUrl).origin;
      const route = apiRouteMap.get(model.id) ?? { kind: "openai-chat-completions", tokenLimit: "max_tokens" };
      // Resolve auth: use registered provider auth, fall back to api-key from options.
      const auth: ProviderAuth = providerAuthMap.get(model.provider)
        ?? { type: "api-key", getToken: () => Promise.resolve(options?.apiKey ?? "") };

      if (route.kind === "anthropic-messages") {
        await streamAnthropic(model, context, options, output, stream, baseHost, auth);
      } else if (route.kind === "openai-responses") {
        await streamResponses(model, context, options, output, stream, baseHost, auth);
      } else {
        await streamOpenAI(model, context, options, output, stream, baseHost, auth, route);
      }

      stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}

// =============================================================================
// Extension Entry Point
// =============================================================================

export default async function (pi: ExtensionAPI) {
  const config = loadConfig();
  const endpoint = `https://${config.resourceId}.services.ai.azure.com/api/projects/${config.projectId}`;

  // Discover deployments
  const url = `${endpoint}/deployments?api-version=v1`;
  console.log(`[Azure Foundry] Fetching deployments from: ${url}`);

  const getToken = makeTokenGetter(config.auth);
  console.log(`[Azure Foundry] Auth: ${config.auth.type}`);

  const token = await getToken();
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) { const b = await response.text().catch(() => ""); throw new Error(`Azure Foundry API ${response.status}: ${b.slice(0, 200)}`); }

  const data = (await response.json()) as { value?: Deployment[] };
  const deployments = (data.value ?? []).filter((d) => d.capabilities?.chat_completion === "true");
  if (deployments.length === 0) throw new Error("No chat-capable deployments found");

  const catalog = buildKnownModelCatalog();
  const models = deployments.map((d) => deploymentToModel(d, catalog, config.models));

  const summary = deployments.map((d) => {
    const route = apiRouteMap.get(d.name)!;
    return `${d.name} (${d.modelPublisher}, ${describeApiRoute(route)})`;
  }).join(", ");
  console.log(`[Azure Foundry] Found ${deployments.length} deployment(s): ${summary}`);

  const providerId = "azure-foundry";
  // Store the auth context so streamAzureFoundry can build the right headers per-request.
  providerAuthMap.set(providerId, { type: config.auth.type, getToken });

  pi.registerProvider(providerId, {
    name: "Azure Foundry",
    baseUrl: endpoint,
    // For api-key auth, store the real key. For azure-identity, pass a sentinel
    // so pi's required-field validation passes — tokens are always fetched at
    // request time via providerAuthMap and this value is never used.
    apiKey: config.auth.type === "api-key" ? config.auth.apiKey : "azure-identity",
    api: "azure-foundry" as Api,
    streamSimple: streamAzureFoundry,
    models,
  });

  console.log(`[Azure Foundry] ✓ Registered ${deployments.length} model(s)`);
}
