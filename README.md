# pi-azure-foundry

A [pi](https://pi.dev) extension that connects to your [Azure AI Foundry](https://ai.azure.com) project, auto-discovers your chat deployments, and registers them as models in pi.

Supports both **API key** and **Azure identity** (Managed Identity, Azure CLI, service principal, etc.) authentication.

## Requirements

- A pi installation (`npm install -g @earendil-works/pi-coding-agent`)
- An Azure AI Foundry project with one or more chat-capable deployments

---

## Installation

### Global (works in any project)

```bash
pi install git:github.com/Itbiodev/pi-azure-foundry
```

### Try without installing

```bash
pi -e git:github.com/Itbiodev/pi-azure-foundry
```

---

## Configuration

Create an `azure-foundry.config.json` file. The extension looks in two places, in order:

1. `<current working directory>/azure-foundry.config.json` — project-specific
2. `~/.pi/azure-foundry.config.json` — global fallback

The global location is recommended for most users since it works across all projects.

### Finding your resource and project IDs

Both values come from your Azure AI Foundry project URL:

```
https://ai.azure.com/build/overview?wsid=/subscriptions/.../resourceGroups/.../providers/Microsoft.MachineLearningServices/workspaces/YOUR-PROJECT
```

Or from the Azure portal — your **resource name** is the Azure AI Services resource name, and your **project name** is the Foundry project name. They are often the same value.

### API key auth

```json
{
  "resourceId": "my-resource-eastus2",
  "projectId": "my-project-eastus2",
  "auth": {
    "type": "api-key",
    "apiKey": "your-api-key-here"
  }
}
```

Get your API key from the Azure AI Foundry portal under **Settings → API keys**.

### Azure identity auth

```json
{
  "resourceId": "my-resource-eastus2",
  "projectId": "my-project-eastus2",
  "auth": {
    "type": "azure-identity"
  }
}
```

No key needed. Uses [`DefaultAzureCredential`](https://learn.microsoft.com/en-us/javascript/api/@azure/identity/defaultazurecredential) which automatically tries, in order:

| Method | How to set up |
|---|---|
| Environment variables | Set `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID` |
| Workload identity | Configured automatically in AKS |
| Managed identity | Configured automatically on Azure VMs / App Service / Container Apps |
| Azure CLI | Run `az login` |
| Azure Developer CLI | Run `azd auth login` |
| Visual Studio Code | Sign in via the Azure extension |

For local development, `az login` is the easiest option.

---

## Usage

Once installed and configured, start pi normally. On startup you'll see:

```
[Azure Foundry] Loading config from: /Users/you/.pi/azure-foundry.config.json
[Azure Foundry] Auth: api-key
[Azure Foundry] Fetching deployments from: https://my-resource.services.ai.azure.com/...
[Azure Foundry] Found 3 deployment(s): claude-sonnet (Anthropic), gpt-4o (Microsoft), ...
[Azure Foundry] ✓ Registered 3 model(s)
```

Your deployments will appear in the pi model picker under the **Azure Foundry** provider.

---

## How it works

- **Deployment discovery** — on startup the extension calls the Foundry deployments API and filters to chat-capable deployments. No model list to maintain manually.
- **Metadata resolution** — model details (context window, max output tokens, reasoning support, vision support, and per-token pricing) are resolved by matching the Azure catalog model name against [pi-ai](https://npmjs.com/package/@earendil-works/pi-ai)'s built-in model providers. The match is case-insensitive, so `Kimi-K2.7-Code` resolves to pi-ai's `kimi-k2.7-code`.
- **Config overrides** — you can pin or override details for any catalog model via the optional `models` property in `azure-foundry.config.json`. This takes precedence over the pi-ai catalog lookup and is useful for custom deployments, negotiated pricing, or models not yet in pi-ai. See the example below.
- **Routing** — Anthropic deployments use `/anthropic/v1/messages`. GPT-6 and newer deployments use the streaming `/openai/v1/responses` API, including reasoning and multi-turn function calls. GPT-5.x, o-series, and other OpenAI-compatible deployments retain `/openai/deployments/{id}/chat/completions`; newer chat models use `max_completion_tokens`. Set `openaiRoute` per model to override the default.
- **Auth headers** — API key auth sends `api-key: <key>` on the OpenAI route and `Authorization: Bearer <key>` on the Anthropic route. Azure identity sends `Authorization: Bearer <entra-token>` on both. Tokens are cached and refreshed automatically 5 minutes before expiry.

---

## Supported models

The extension auto-discovers whatever is deployed in your Foundry project. Known models are resolved through [pi-ai](https://npmjs.com/package/@earendil-works/pi-ai)'s built-in provider catalogs (Anthropic, OpenAI, MoonshotAI, Mistral, DeepSeek, xAI, and their regional variants).

Any deployment whose catalog model name can't be matched falls back to conservative defaults (128K context / 4K output / text-only / no reasoning / no cost). To override or plug a gap, add an entry under the `models` key in `azure-foundry.config.json`.

### Overriding model details

The `models` section lets you override any subset of the resolved metadata for a specific Azure catalog model. The key must match the **Azure model name** exactly (e.g. `Kimi-K2.7-Code`). Any omitted fields are kept from the pi-ai catalog or fallback defaults.

```json
{
  "resourceId": "my-resource-eastus2",
  "projectId": "my-project-eastus2",
  "auth": {
    "type": "api-key",
    "apiKey": "your-api-key-here"
  },
  "models": {
    "Kimi-K2.7-Code": {
      "contextWindow": 262144,
      "maxTokens": 32768,
      "reasoning": true,
      "input": ["text", "image"],
      "cost": {
        "input": 0.95,
        "output": 4.0,
        "cacheRead": 0.19,
        "cacheWrite": 0
      },
      "openaiTokenLimit": "max_tokens"
    }
  }
}
```

Supported override fields:

| Field | Type | Purpose |
|---|---|---|
| `contextWindow` | number | Model context window in tokens |
| `maxTokens` | number | Maximum output tokens per request |
| `reasoning` | boolean | Whether the model emits reasoning/thinking content |
| `input` | `["text"]`, `["text", "image"]`, etc. | Supported input modalities |
| `cost` | `{ input, output, cacheRead?, cacheWrite? }` | Per-1M-token pricing in USD |
| `openaiTokenLimit` | `"max_tokens"` or `"max_completion_tokens"` | Which field pi sends for the chat-completions output token limit |
| `openaiRoute` | `"responses"` or `"chat-completions"` | Override automatic OpenAI API routing |

Common use-cases include fixing stale data in the `pi-ai` catalog, setting custom parameters configured in Foundry (e.g. `maxTokens`), or ensuring cost estimates reflect special pricing from a negotiated arrangement with Microsoft Azure.

```json
"models": {
  "Kimi-K2.7-Code": {
    "maxTokens": 32768
  }
}
```

---

## Development

```bash
git clone https://github.com/Itbiodev/pi-azure-foundry
cd pi-azure-foundry
npm install
npm run build

# Test against your own config
cp azure-foundry.config.example.json azure-foundry.config.json
# edit azure-foundry.config.json with your real values
pi -e .
```

```bash
npm run dev       # watch mode
npm run type-check  # type check without building
```

---

## License

MIT
