# Architecture Notes: Session State & Agent Engine Selection

> **Purpose:** Orientation doc for AI agents and developers working on the
> multi-agent-per-session refactor (see [multi-agent-refactor-plan.md](multi-agent-refactor-plan.md)).
> Compiled from a full codebase survey on 2026-07-02 (commit `ae5b8a995`).
> Line numbers will drift — treat them as anchors, verify before editing.

## TL;DR

- The live backend is `openhands/app_server/`. The legacy `openhands/server/` package is a deprecated shell that re-exports the new app (`openhands/server/listen.py`, `openhands/server/app.py`).
- **An ACP (Agent Client Protocol) integration already exists** for subprocess CLI agents: `claude-code`, `codex`, `gemini-cli`. The engine discriminator is `agent_kind` (`'openhands'` vs `'acp'`).
- The engine is currently selected **per user** (global `Settings.agent_settings`), not per session. Making it per-session is a matter of threading an override through the conversation-start request — most of the machinery (DB column, webhook reconciliation, model switching) already exists.
- The agent loop itself is **not in this repo**. It lives in the external pinned packages `openhands-sdk` / `openhands-agent-server` / `openhands-tools` (see `pyproject.toml` for the pinned version; source repo: `software-agent-sdk`).

## Two-tier runtime architecture

```
┌──────────────────────┐   HTTP + X-Session-API-Key   ┌─────────────────────────┐
│ app_server           │ ───────────────────────────► │ agent-server            │
│ (this repo,          │   POST /api/conversations    │ (inside sandbox:        │
│  control plane)      │   GET  .../events (SSE/WS)   │  Docker container,      │
│                      │ ◄─────────────────────────── │  local process, or      │
│                      │   webhooks back to app_server│  remote runtime)        │
└──────────────────────┘                              └─────────────────────────┘
```

- One sandbox hosts one agent-server; multiple conversations can share a sandbox depending on `sandbox_grouping_strategy` (`live_status_app_conversation_service.py`, `_select_sandbox_by_strategy`).
- **The sandbox is engine-agnostic.** The engine is encoded entirely in the body of `POST {agent_server_url}/api/conversations` (an SDK `StartConversationRequest` whose `agent` field is the discriminated union `Agent | ACPAgent`). Container env vars do NOT select the engine.
- Sandbox backends: `DockerSandboxService` (default), `ProcessSandboxService` (`RUNTIME=local|process`), `RemoteSandboxService` (`RUNTIME=remote`). Selected in `openhands/app_server/config.py:config_from_env()`.

## Where the engine choice lives today

- User settings model: `openhands/app_server/settings/settings_models.py` — `Settings.agent_settings: AgentSettingsConfig`, a discriminated union `OpenHandsAgentSettings | ACPAgentSettings` on `agent_kind` (types come from `openhands.sdk.settings`). LLM config + API key live *inside* `agent_settings.llm`.
- Merge semantics for changing settings: `Settings.update()` uses the SDK's `apply_agent_settings_diff` — **replace on `agent_kind` change, deep-merge within a variant**. Reuse this for any per-session override logic.
- Settings persistence: `SettingsStore` ABC (`settings/settings_store.py`) resolved via `get_impl()` from `server_config.settings_store_class`. OSS impl: `FileSettingsStore` (settings.json in file store). Enterprise: `enterprise/storage/saas_settings_store.py` (org-shared + member-private diff).
- **The branch point:** `openhands/app_server/app_conversation/live_status_app_conversation_service.py`, `_build_start_conversation_request_for_user()` (~line 1572). At ~line 1620 it does `isinstance(user.agent_settings, ACPAgentSettings)` → ACP path, else OpenHands/CodeAct path. This is where a per-session override must be applied.

## Conversation start call chain

1. `POST /api/v1/app-conversations` → `start_app_conversation()` in `app_conversation_router.py` (~line 364). Async/task-based: returns a start task; the frontend polls `GET /api/v1/app-conversations/start-tasks?ids=...` until `READY`.
2. `LiveStatusAppConversationService._start_app_conversation()` (~line 326) orchestrates:
   - `_wait_for_sandbox_start` — reuse/start/resume sandbox.
   - `run_setup_scripts` — git clone/init, `.openhands/setup.sh`, hooks, skills (`app_conversation_service_base.py`).
   - `_build_start_conversation_request_for_user` — builds the SDK `StartConversationRequest` (the engine decision).
   - `httpx_client.post(f'{agent_server_url}/api/conversations', ...)` (~line 465) — starts the agent.
   - Persists `AppConversationInfo` (`agent_kind`, `llm_model`, tags) at ~lines 498–527.
3. ACP request builder: `_build_acp_start_conversation_request()` (~line 1878). Notable behaviors: sets `acp_isolate_data_dir=True`; **strips `llm.api_key`/`base_url`** so proxy creds don't leak into the subprocess env; secrets must be `StaticSecret` (LookupSecret JWT headers would be redacted and break subprocess auth); git provider tokens become `{PROVIDER}_TOKEN` static secrets passed as top-level `secrets=`.

## Persistence model

Single table `conversation_metadata` — `StoredConversationMetadata` in
`openhands/app_server/app_conversation/sql_app_conversation_info_service.py` (~lines 65–122). Engine-relevant columns:

| Column | Notes |
|---|---|
| `agent_kind` (str, nullable) | Persisted engine kind (`'openhands'`/`'acp'`). Added in migration `009.py`. |
| `llm_model` (str) | Scalar model name only; full LLM config is NOT persisted per conversation. |
| `tags` (JSON dict) | Only per-conversation JSON blob. Keys used: `acpserver` (ACP provider key) and `archiveworkspacepath` (see `app_conversation_models.py` tag constants). |
| `sandbox_id`, `parent_conversation_id` | Runtime link and sub-conversation/fork link. |
| `conversation_version` | `'V1'` = app_server conversations. |

- Full LLM/agent/MCP/secrets config is rebuilt at each start from the user's global settings — there is **no per-conversation agent_settings snapshot today** (this is the main gap for the refactor).
- API models: `openhands/app_server/app_conversation/app_conversation_models.py` — `AppConversationInfo` (computed `acp_server` from the tag), `AppConversationStartRequest` (~line 189; has `llm_model`, `agent_type` DEFAULT/PLAN, `sandbox_id`, `parent_conversation_id`, `secrets`, but **no engine field**).
- Alembic: `openhands/app_server/app_lifespan/alembic/versions/` — linear chain, `014.py` was head at survey time. Pattern for new columns: `op.batch_alter_table('conversation_metadata')` (see `012.py`/`013.py`).

## Existing ACP surface (reuse, don't rebuild)

- `POST /api/v1/app-conversations/{id}/switch_acp_model` (`app_conversation_router.py` ~line 774) — proxies a protocol-level `session/set_model` to the ACP subprocess. Precedent for live per-conversation changes.
- `POST /{id}/switch_profile` — LLM profile switch, persists `llm_model` via `_persist_conversation_model`.
- Feature flag: `ENABLE_ACP` env var → `WebClientFeatureFlags.enable_acp` (`web_client/default_web_client_config_injector.py`). `acp_providers` (with `default_command`, `default_model`, `available_models`, `api_key_env_var`, `base_url_env_var`) is served to the frontend from the SDK's `ACP_PROVIDERS` registry.
- Webhook reconciliation branches on `agent.agent_kind == 'acp'` in `event_callback/webhook_router.py` (`_resolve_acp_server_key` prefers the conversation's own `ACPAgent.acp_command`).
- The literal `CLAUDE_CODE_OAUTH_TOKEN` does not appear in this repo: each provider's auth env var is data-driven via `ACPProviderConfig.api_key_env_var`, defined in the SDK (`openhands/sdk/settings/acp_providers.py` in the `software-agent-sdk` repo). Inspect the pinned SDK wheel for exact commands/env vars.

## Secrets flow

- Models: `openhands/app_server/secrets/secrets_models.py` (`provider_tokens` + `custom_secrets`, `get_env_vars()`); stores resolved via `SecretsStoreImpl = get_impl(...)` in `shared.py`.
- OpenHands path: secrets ride inside `AgentContext(secrets=...)` on the agent; git tokens are `LookupSecret` (SaaS, webhook-backed) or `StaticSecret` (OSS).
- ACP path: secrets ride as top-level `secrets=` on the request and MUST be `StaticSecret`.
- LLM API keys travel on the `LLM` object inside the start request (serialized with `context={'expose_secrets': True}`), **not** via container env — so two conversations with different engines in the same sandbox do not see each other's keys.

## Frontend contract (for Phases 2–3)

- Conversation creation: `frontend/src/hooks/mutation/use-create-conversation.ts` → `V1ConversationService.createConversation` (`frontend/src/api/conversation-service/v1-conversation-service.api.ts`) → `POST /api/v1/app-conversations`, then poll start task. `agent_type`/`llm_model` already exist in the signature but are only partially surfaced.
- GitHub repo picker **already exists**: `frontend/src/components/features/home/repo-selection-form.tsx` + `git-repo-dropdown/`; backend list endpoint `GET /api/v1/git/repositories/search` (`GitService` in `frontend/src/api/git-service/`). Phase 2 = surface this inside an active conversation + backend checkout-into-running-workspace.
- Live events: `frontend/src/contexts/conversation-websocket-context.tsx` (WebSocket, parses events, sets `execution_status`). Agent state mapping for notifications: `frontend/src/hooks/use-agent-state.ts` (`IDLE→AWAITING_USER_INPUT`, `FINISHED`, `ERROR`/`STUCK`, `WAITING_FOR_CONFIRMATION`).
- Toasts: react-hot-toast, `<Toaster />` mounted in `frontend/src/root.tsx`, helpers in `frontend/src/utils/custom-toast-handlers.tsx`. **No browser Notification API / service worker usage exists** — OS-level push is net-new. Closest existing mechanism: `frontend/src/utils/browser-tab.ts` (tab title updates).

## Key architectural decision (settled)

**Engine is bound per session; cross-engine "switch" = fork, not in-thread handover.**
Rationale: OpenHands SDK event history and ACP subprocess-internal state are not
interconvertible; all bookkeeping (single `agent_kind` column, webhooks, cost tracking)
assumes one engine per conversation; `parent_conversation_id` + `sandbox_id` reuse
already enable forking into the same workspace with a synthesized context handover
as `initial_message`.
