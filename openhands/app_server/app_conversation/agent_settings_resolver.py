"""Per-conversation agent-engine resolution.

A conversation may carry an ``agent_settings_diff`` override that binds the
agent engine (OpenHands CodeAct vs an ACP subprocess CLI such as Claude Code)
to that session instead of the user's global settings. The diff uses the same
sparse nested-dict shape as the settings API (``agent_settings_diff`` on the
settings POST) and is applied over the user's saved ``agent_settings`` with
the SDK's variant-aware merge: replace on ``agent_kind`` change, deep-merge
within a variant.

Credentials never travel in the diff: it is persisted verbatim on the
conversation row (and inside stored start tasks), so ``validate_agent_settings_diff``
rejects key names that carry secrets. API keys resolve from the user's
settings and secrets store at start time instead.
"""

import json
from typing import Any, Mapping

from openhands.sdk.settings import (
    ACPAgentSettings,
    OpenHandsAgentSettings,
    apply_agent_settings_diff,
)

# Key names that must never appear in a per-conversation diff because the
# diff is persisted in plaintext (conversation row, start tasks). Matched
# case-insensitively at any nesting depth.
_FORBIDDEN_DIFF_KEYS = frozenset({'api_key', 'secrets', 'litellm_extra_body'})

# Hard cap on the serialized diff so a hostile payload can't balloon the
# conversation row / start-task record.
_MAX_DIFF_JSON_BYTES = 16_384


def validate_agent_settings_diff(diff: Mapping[str, Any]) -> None:
    """Validate a per-conversation agent-settings diff.

    Raises ValueError when the diff carries credential-bearing keys or is
    unreasonably large. Field-level validity (unknown keys, bad values) is
    left to the SDK's ``validate_agent_settings`` at application time.
    """
    encoded = json.dumps(diff, default=str)
    if len(encoded.encode('utf-8')) > _MAX_DIFF_JSON_BYTES:
        raise ValueError(
            f'agent_settings_diff exceeds {_MAX_DIFF_JSON_BYTES} bytes when serialized'
        )
    _reject_forbidden_keys(diff, path='agent_settings_diff')


def _reject_forbidden_keys(value: Any, path: str) -> None:
    if isinstance(value, Mapping):
        for key, child in value.items():
            key_path = f'{path}.{key}'
            if isinstance(key, str) and key.lower() in _FORBIDDEN_DIFF_KEYS:
                raise ValueError(
                    f'{key_path} is not allowed in agent_settings_diff: '
                    'credentials must come from user settings or the secrets '
                    'store, never a per-conversation override'
                )
            _reject_forbidden_keys(child, key_path)
    elif isinstance(value, (list, tuple)):
        for index, child in enumerate(value):
            _reject_forbidden_keys(child, f'{path}[{index}]')


def resolve_effective_agent_settings(
    base: OpenHandsAgentSettings | ACPAgentSettings,
    diff: Mapping[str, Any] | None,
) -> OpenHandsAgentSettings | ACPAgentSettings:
    """Resolve the agent settings a conversation should start with.

    ``base`` is the user's saved settings; ``diff`` is the per-conversation
    override (may be None/empty, in which case ``base`` is returned as-is by
    the SDK merge). Raises pydantic ``ValidationError`` on an invalid diff.
    """
    return apply_agent_settings_diff(base, diff)


def normalize_agent_settings_diff_for_persistence(
    diff: Mapping[str, Any],
    effective: OpenHandsAgentSettings | ACPAgentSettings,
) -> dict[str, Any]:
    """Pin the resolved engine identity onto a diff before persisting it.

    The stored diff is re-applied over the user's *current* settings when the
    conversation is forked or restarted. Pinning ``agent_kind`` (and
    ``acp_server`` for ACP) makes that re-application kind-stable: if the user
    later flips their global engine, ``apply_agent_settings_diff`` sees a kind
    change and rebuilds from fresh defaults for the pinned variant instead of
    merging across the union boundary.
    """
    normalized = dict(diff)
    normalized['agent_kind'] = effective.agent_kind
    if isinstance(effective, ACPAgentSettings):
        normalized.setdefault('acp_server', effective.acp_server)
    return normalized
