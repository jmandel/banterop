
# Simple LLM Registry + Scenario API (No Manager Knowledge of Internals)

This package provides:
- `/api/llm/*` using a **registry** of providers. The registry just calls each provider's descriptor;
  it **does not** import or know about any provider's internals.
- `/api/scenarios/*` CRUD with one JSON column and a published guard (`X-Edit-Token`).

## How it's simpler

- Each provider exports a **descriptor** (`ProviderDescriptor`) with:
  - `name`, `getMetadata(env)`, `isAvailable(env)`, `create(env, cfg)`
- The registry has **no provider-specific code**. Providers self-register via side-effect imports.
- `availableProviders(env)` and `createProvider(env, opts)` are generic and do not mention Google/OpenRouter/etc.
- You still get **env-based model include lists** via `LLM_MODELS_{PROVIDER}_INCLUDE` (applied generically in the registry).

## Mounting the routes

```ts
import { Hono } from 'hono';
import { installLLMAndScenarios } from './server/install/llm-and-scenarios';

const app = new Hono();
installLLMAndScenarios(app);
```

## ENV

```
DEFAULT_LLM_PROVIDER=mock
DEFAULT_LLM_MODEL=mock-model

# Keys for server-backed providers
GOOGLE_API_KEY=...                   # Google Gemini API key
OPENROUTER_API_KEY=...

# OpenRouter provider routing (optional JSON)
OPENROUTER_PROVIDER_CONFIG='{"ignore":["baseten"],"allow_fallbacks":true,"sort":"throughput"}'

# Per-provider model includes (optional)
LLM_MODELS_GOOGLE_INCLUDE=gemini-2.5-flash,gemini-2.5-pro
LLM_MODELS_OPENROUTER_INCLUDE=@preset/chitchat

# Scenario guard
PUBLISHED_EDIT_TOKEN=secret-token
```

## HTTP

- `GET /api/llm/providers`
- `POST /api/llm/complete`
- `GET /api/scenarios/` / `GET /api/scenarios/:id` / `POST` / `PUT` / `DELETE`

## Notes

- For **browser-direct** flows (users supply their own keys), implement a client-only provider in your frontend.
- The included **browserside** provider is a convenient proxy that posts to your server `/api/llm/complete`.
