# Plan: Multi-Agent Sessions, Repo Selector & Notifications

> **Purpose:** Living plan for the three-phase refactor. If you (human or AI) are
> picking this work up cold: read [architecture-session-engine.md](architecture-session-engine.md)
> first, then check the Status column below and continue from the first unchecked step.
> Update checkboxes and the "Decisions log" as work lands.
>
> Original goal (from the project owner, 2026-07-02): refactor OpenHands to support a
> dynamic multi-agent paradigm at session/workspace level (e.g. Claude Code via ACP in
> one session using `CLAUDE_CODE_OAUTH_TOKEN`, standard OpenHands CodeAct in another),
> plus an in-conversation GitHub repository selector, plus a notification system.

## Status overview

- [x] Phase 1 — Per-session agent engine (backend + state) — implemented 2026-07-02
      (except the optional Step 5 fork-endpoint convenience; inheritance of the
      engine override via `parent_conversation_id` IS implemented)
- [x] Phase 2 — GitHub repository selector (UI/UX + workspace checkout) —
      implemented 2026-07-02
- [x] Phase 3 — Notification system — implemented 2026-07-02

## Decisions log

| Date | Decision |
|---|---|
| 2026-07-02 | Engine is bound **per session**, not switchable mid-thread. Cross-engine switching is implemented as **fork**: new conversation with `parent_conversation_id`, same `sandbox_id` (same workspace/files), new `agent_settings`, synthesized context handover as `initial_message`. Rationale in architecture doc. |
| 2026-07-02 | Per-session engine override uses the same `AgentSettingsConfig` discriminated-union/diff format as user settings, merged with the SDK's `apply_agent_settings_diff` semantics (replace on `agent_kind` change, deep-merge within a variant). |
| 2026-07-02 | Per-session settings snapshot is persisted **sanitized** (never API keys — those resolve from the secrets store at every start). |

---

## Phase 1 — Per-session agent engine

The engine choice (`OpenHandsAgentSettings | ACPAgentSettings`) moves from per-user
global settings to the conversation. Independent per-session agent processes already
exist architecturally (one agent-server conversation per session, lifecycle via
`SandboxService`); the work is binding the *choice* to the session.

### Step 1: API + DB field — DONE (2026-07-02)
- [x] `agent_settings_diff: dict | None` on `AppConversationStartRequest`
      (`app_conversation_models.py`), with a field validator rejecting
      credential-bearing keys (`api_key`, `secrets`, `litellm_extra_body`) and
      oversized payloads. Diff shape matches the settings API convention.
      Validation/merge/normalization live in the new module
      `openhands/app_server/app_conversation/agent_settings_resolver.py`.
- [x] Alembic migration `015.py` (OSS) + enterprise `129_*.py`: nullable JSON
      column `agent_settings_diff` on `conversation_metadata`.
- [x] Column on `StoredConversationMetadata`, round-trip in
      `save_app_conversation_info` / `_to_info`, exposed on `AppConversationInfo`.
      Enterprise's `SaasSQLAppConversationInfoService` inherits both.
- [x] `agent_kind` column + `acpserver` tag kept as derived fields.

### Step 2: Resolution in the service layer — DONE (2026-07-02)
- [x] `_start_app_conversation` resolves the override via
      `resolve_effective_agent_settings(user.agent_settings, request.agent_settings_diff)`
      and threads it through
      `_build_start_conversation_request_for_user(agent_settings_override=...)`;
      the ACP/OpenHands branch runs on the effective object, and
      `_build_acp_start_conversation_request` now takes `acp_settings` as a param.
      `_configure_llm(_and_mcp)` / `_merge_custom_mcp_config` accept an optional
      `agent_settings` param (fallback: `user.agent_settings`).
- [x] Persisted normalized (kind-pinned via
      `normalize_agent_settings_diff_for_persistence`) diff on the conversation row,
      in the block that sets `agent_kind`/tags.
- [x] Session-stability: `_inherit_configuration_from_parent` copies the parent's
      persisted `agent_settings_diff` onto forks/sub-conversations; kind-pinning
      makes re-application stable even if the user's global engine changes later.
- [x] Router 400 on ACP override when `ENABLE_ACP` is off
      (`_validate_agent_settings_diff_allowed`, both start endpoints) +
      defense-in-depth re-check in the service. Shared flag helper
      `openhands/app_server/utils/feature_flags.py::acp_enabled()` is also used by
      the web-client config injector so UI and API can't disagree. Provider
      validity is enforced by the SDK union validation (bad `acp_server` → error).

### Step 3: Secrets per session — DONE (2026-07-02)
- [x] Confirmed no new mechanism needed: ACP path injects provider auth as
      `StaticSecret` in the start request, scoped to the conversation; LLM keys
      ride the `LLM` object, never container env. NOTE (verified in SDK 1.30.0):
      the claude-code provider's `api_key_env_var` is `ANTHROPIC_API_KEY`; a
      `CLAUDE_CODE_OAUTH_TOKEN` is supplied as a user custom secret instead.
- [x] Covered by `TestAgentSettingsOverrideRouting` (override wins in both
      directions; ACP path strips `llm.api_key`) + existing ACP secrets tests.

### Step 4: Frontend minimum (bridge to Phase 2) — DONE (2026-07-02)
- [x] `agent_settings_diff` threaded through `V1ConversationService.createConversation`,
      `V1AppConversationStartRequest`, and `useCreateConversation`
      (`agentSettingsDiff` variable).
- [x] Engine selector (`SettingsDropdownInput`, testId `agent-engine-dropdown`) in
      `repo-selection-form.tsx`: "Default (your agent settings)" / "OpenHands
      (CodeAct)" / one entry per `acp_providers` provider; rendered only when
      `enable_acp` is on and providers exist.

### Step 5: Fork-to-switch endpoint — TODO (optional convenience)
- [ ] "Switch engine" = create conversation with `parent_conversation_id` +
      `sandbox_id` of the source + new `agent_settings_diff` + synthesized handover
      `initial_message`. All building blocks exist now (diff field, parent
      inheritance, sandbox reuse); what remains is a convenience endpoint/UI action.

### Step 6: Tests & verification — DONE (2026-07-02)
- [x] `tests/unit/app_server/test_agent_settings_resolver.py` — diff validation,
      merge semantics, kind-pinning stability, request validator, ENABLE_ACP flag.
- [x] DB round-trip tests in `test_sql_app_conversation_info_service.py`; builder
      routing tests in `test_live_status_app_conversation_service.py`
      (`TestAgentSettingsOverrideRouting`).
- [x] Migration `015` verified (upgrade + downgrade against a stamped DB).
- [x] Backend pre-commit (ruff/mypy) green; frontend lint + `npm run build` green.
- [ ] Manual end-to-end run with `RUNTIME=local` + `ENABLE_ACP=true`: one ACP +
      one OpenHands conversation side by side (needs real LLM/Claude Code auth —
      left for a supervised session).

### Open risks (status)
1. ~~SDK fields unverified~~ — verified against installed SDK 1.30.0:
   `ACPAgentSettings(acp_server: 'claude-code'|'codex'|'gemini-cli'|'custom', ...)`;
   `create_agent()` fills the default subprocess command from `ACP_PROVIDERS`.
2. STILL OPEN: the sandbox agent-server image must be able to run the ACP CLIs
   (they launch via `npx`, so Node must be present in the image); otherwise ACP
   sessions fail at runtime regardless of backend correctness.
3. Pre-existing (unrelated) issue found on main: fresh-DB `alembic upgrade head`
   on SQLite fails in migration `013` with recent alembic versions — its
   `batch_op.create_index(..., 'execution_status', ...)` passes a string where a
   list of columns is expected. Worth an upstream fix.

---

## Phase 2 — GitHub repository selector (in-conversation) — DONE (2026-07-02)

A repo picker already existed on the home screen; Phase 2 surfaced it inside an
active conversation with a hot workspace checkout (no container restart).

- [x] Backend: `POST /api/v1/app-conversations/{id}/checkout-repository`
      (`app_conversation_router.py`, request/response models
      `CheckoutRepositoryRequest`/`CheckoutRepositoryResponse` in
      `app_conversation_models.py`). Resolves the workspace root from the
      `archiveworkspacepath` tag (fallback: sandbox spec working_dir), requires a
      RUNNING sandbox (409 when paused, mirroring the switch endpoints), and runs
      synchronously — shallow clones typically take seconds.
- [x] Clone core refactored: `clone_or_init_git_repo` now delegates to the
      task-free `AppConversationServiceBase.clone_git_repository(...)`, shared by
      conversation start and mid-conversation checkout.
      `checkout_repository_into_workspace(...)` = clone + `.openhands/` setup
      script + git hooks for the new repo. `strict=True` raises
      `RepositoryCheckoutError` with a **client-safe message** (never git stderr,
      which can echo the token-bearing remote URL); conversation start keeps its
      historical warn-only behavior via `strict=False`.
- [x] **Semantics decided: side-by-side, never destructive.** Repos land at
      `{working_dir}/{repo_name}` next to existing checkouts. An existing
      checkout is never re-cloned or reset: with a branch requested we
      best-effort `git fetch --depth 1 origin <branch>` + checkout (with a
      `checkout -b <branch> FETCH_HEAD` fallback); local state is never
      overwritten.
- [x] Persistence: on success the endpoint updates
      `selected_repository`/`selected_branch`/`git_provider` via the existing
      `update_app_conversation` path, so the conversation header reflects the
      switch.
- [x] Frontend: `ConversationRepoSelector`
      (`frontend/src/components/features/conversation/conversation-repo-selector.tsx`)
      mounted in the conversation header next to the conversation name; reuses
      `GitRepoDropdown`/`GitBranchDropdown`; `useCheckoutRepository` mutation hook
      (`frontend/src/hooks/mutation/use-checkout-repository.ts`) invalidates
      `["user", "conversation", id]` and shows success/error toasts with the new
      `project_dir`.
- [x] Tests: `tests/unit/app_server/test_checkout_repository.py` (fresh clone,
      existing-checkout no-reclone, FETCH_HEAD fallback, strict vs warn, token
      never leaked in errors, setup skipped on clone failure). Pre-existing
      clone tests updated to bind the new core method.
- NOTE: the agent's terminal cwd stays at the original project dir (the SDK
  conversation workspace is fixed at start); the new repo is available at the
  returned `project_dir` and the toast surfaces that path. A follow-up could
  auto-inform the agent of the new path in the next user message.

## Phase 3 — Notification system — DONE (2026-07-02)

Discovery: a notification hook already existed —
`frontend/src/hooks/use-agent-notification.ts` (mounted in
`controls/agent-status.tsx`) with tab-title flashing + optional sound
(`enable_sound_notifications`) on AWAITING_USER_INPUT / FINISHED /
AWAITING_USER_CONFIRMATION transitions. Phase 3 extended it rather than
building parallel plumbing:

- [x] **Critical errors covered**: `AgentState.ERROR` added to
      `NOTIFICATION_STATES` (V1 maps both `error` and `stuck` execution
      statuses to ERROR via `use-agent-state.ts`), so terminal failures now
      flash/sound/notify like the other attention states.
- [x] **OS-level browser notifications** (net-new):
      `frontend/src/utils/browser-notifications.ts` — Notification API wrapper
      (support/permission checks, `requestBrowserNotificationPermission`,
      `showBrowserNotification` with per-conversation+state `tag` dedupe and
      click-to-focus). Fired from `useAgentNotification` when the tab is
      unfocused and the setting is on.
- [x] **User setting** `enable_browser_notifications` (default off):
      backend field in `Settings` (`settings_models.py`, next to
      `enable_sound_notifications` — flows through the generic settings
      GET/POST, no migration needed since settings persist as JSON);
      frontend `Settings` type + `DEFAULT_SETTINGS` + toggle in
      `routes/app-settings.tsx` (requests OS permission on enable);
      i18n key `SETTINGS$BROWSER_NOTIFICATIONS` (all 15 languages).
      Enterprise/SaaS parity: columns on `user` + `user_settings`
      (migration `130_*.py`), load mapping in `user_store.py`, and the
      `UserAppSettingsResponse`/`UserAppSettingsUpdate` API models. Enterprise
      test suite was NOT run locally (heavy poetry env) — syntax-verified only;
      run it before merging enterprise-side.
- [x] Tests: extended `frontend/__tests__/hooks/use-agent-notification.test.ts`
      (ERROR state, browser-notification on/off); backend settings round-trip
      verified; frontend lint + build + backend pre-commit green.
- NOTE: notifications fire from the conversation being viewed (the hook is
  mounted per conversation view). Cross-conversation notifications (agent
  finishes in a background conversation while you view another) would need a
  global multi-conversation watcher — possible follow-up.
