"""Tests for per-conversation agent-engine resolution.

Covers the resolver module (diff validation, effective-settings resolution,
persistence normalization), the request-model validator, and the shared
ENABLE_ACP feature flag.
"""

import pytest
from pydantic import SecretStr, ValidationError

from openhands.app_server.app_conversation.agent_settings_resolver import (
    normalize_agent_settings_diff_for_persistence,
    resolve_effective_agent_settings,
    validate_agent_settings_diff,
)
from openhands.app_server.app_conversation.app_conversation_models import (
    AppConversationStartRequest,
)
from openhands.app_server.utils.feature_flags import acp_enabled
from openhands.sdk.settings import (
    ACPAgentSettings,
    OpenHandsAgentSettings,
    validate_agent_settings,
)


def _openhands_settings(**llm_overrides) -> OpenHandsAgentSettings:
    settings = validate_agent_settings(
        {'agent_kind': 'openhands', 'llm': {'model': 'claude-sonnet-4-5'}}
    )
    assert isinstance(settings, OpenHandsAgentSettings)
    if llm_overrides:
        settings = settings.model_copy(
            update={'llm': settings.llm.model_copy(update=llm_overrides)}
        )
    return settings


def _acp_settings() -> ACPAgentSettings:
    settings = validate_agent_settings(
        {'agent_kind': 'acp', 'acp_server': 'claude-code'}
    )
    assert isinstance(settings, ACPAgentSettings)
    return settings


class TestValidateAgentSettingsDiff:
    def test_accepts_engine_selection_diff(self):
        validate_agent_settings_diff(
            {'agent_kind': 'acp', 'acp_server': 'claude-code', 'acp_model': 'sonnet'}
        )

    def test_rejects_api_key_at_any_depth(self):
        with pytest.raises(ValueError, match='api_key'):
            validate_agent_settings_diff({'llm': {'api_key': 'sk-secret'}})

    def test_rejects_api_key_case_insensitively(self):
        with pytest.raises(ValueError, match='not allowed'):
            validate_agent_settings_diff({'llm': {'API_KEY': 'sk-secret'}})

    def test_rejects_secrets_key(self):
        with pytest.raises(ValueError, match='secrets'):
            validate_agent_settings_diff({'agent_context': {'secrets': {'X': 'y'}}})

    def test_rejects_forbidden_key_inside_list(self):
        with pytest.raises(ValueError, match='api_key'):
            validate_agent_settings_diff({'items': [{'api_key': 'sk'}]})

    def test_rejects_oversized_diff(self):
        with pytest.raises(ValueError, match='exceeds'):
            validate_agent_settings_diff({'padding': 'x' * 20_000})


class TestResolveEffectiveAgentSettings:
    def test_none_diff_returns_base(self):
        base = _openhands_settings()
        effective = resolve_effective_agent_settings(base, None)
        assert isinstance(effective, OpenHandsAgentSettings)
        assert effective.llm.model == 'claude-sonnet-4-5'

    def test_same_kind_diff_deep_merges_and_keeps_credentials(self):
        base = _openhands_settings(api_key=SecretStr('user-key'))
        effective = resolve_effective_agent_settings(
            base, {'agent_kind': 'openhands', 'llm': {'model': 'claude-haiku-4-5'}}
        )
        assert isinstance(effective, OpenHandsAgentSettings)
        assert effective.llm.model == 'claude-haiku-4-5'
        # Same-kind merge preserves the user's saved credentials.
        assert effective.llm.api_key is not None
        assert effective.llm.api_key.get_secret_value() == 'user-key'

    def test_cross_kind_diff_rebuilds_from_fresh_defaults(self):
        base = _openhands_settings(api_key=SecretStr('user-key'))
        effective = resolve_effective_agent_settings(
            base, {'agent_kind': 'acp', 'acp_server': 'claude-code'}
        )
        assert isinstance(effective, ACPAgentSettings)
        assert effective.acp_server == 'claude-code'
        # Cross-kind replacement must not leak the outgoing variant's config.
        assert effective.llm.api_key is None

    def test_cross_kind_acp_settings_create_a_runnable_agent(self):
        base = _openhands_settings()
        effective = resolve_effective_agent_settings(
            base, {'agent_kind': 'acp', 'acp_server': 'claude-code'}
        )
        agent = effective.create_agent()
        assert agent.agent_kind == 'acp'
        # Provider registry fills the default subprocess command.
        assert agent.acp_command

    def test_acp_base_back_to_openhands(self):
        base = _acp_settings()
        effective = resolve_effective_agent_settings(
            base, {'agent_kind': 'openhands', 'llm': {'model': 'claude-sonnet-4-5'}}
        )
        assert isinstance(effective, OpenHandsAgentSettings)
        assert effective.llm.model == 'claude-sonnet-4-5'

    def test_invalid_diff_raises_validation_error(self):
        base = _openhands_settings()
        with pytest.raises(ValidationError):
            resolve_effective_agent_settings(
                base, {'agent_kind': 'acp', 'acp_server': 'not-a-provider'}
            )


class TestNormalizeAgentSettingsDiffForPersistence:
    def test_pins_agent_kind_and_acp_server(self):
        effective = _acp_settings()
        normalized = normalize_agent_settings_diff_for_persistence(
            {'agent_kind': 'acp'}, effective
        )
        assert normalized['agent_kind'] == 'acp'
        assert normalized['acp_server'] == 'claude-code'

    def test_pins_kind_for_openhands_and_leaves_diff_otherwise_intact(self):
        effective = _openhands_settings()
        normalized = normalize_agent_settings_diff_for_persistence(
            {'llm': {'model': 'claude-haiku-4-5'}}, effective
        )
        assert normalized['agent_kind'] == 'openhands'
        assert normalized['llm'] == {'model': 'claude-haiku-4-5'}
        assert 'acp_server' not in normalized

    def test_does_not_override_explicit_acp_server(self):
        effective = _acp_settings()
        normalized = normalize_agent_settings_diff_for_persistence(
            {'agent_kind': 'acp', 'acp_server': 'claude-code'}, effective
        )
        assert normalized['acp_server'] == 'claude-code'

    def test_reapplying_pinned_diff_is_kind_stable(self):
        """The persisted diff must resolve to the same engine even after the
        user flips their global agent_kind — the point of the normalization."""
        original_base = _openhands_settings()
        diff = {'agent_kind': 'acp', 'acp_server': 'claude-code'}
        effective = resolve_effective_agent_settings(original_base, diff)
        pinned = normalize_agent_settings_diff_for_persistence(diff, effective)

        # User has since switched their global settings to ACP with a
        # different provider; the pinned diff still wins.
        new_base = _acp_settings().model_copy(update={'acp_server': 'codex'})
        reresolved = resolve_effective_agent_settings(new_base, pinned)
        assert isinstance(reresolved, ACPAgentSettings)
        assert reresolved.acp_server == 'claude-code'


class TestStartRequestAgentSettingsDiff:
    def test_request_accepts_valid_diff(self):
        request = AppConversationStartRequest(
            agent_settings_diff={'agent_kind': 'acp', 'acp_server': 'claude-code'}
        )
        assert request.agent_settings_diff == {
            'agent_kind': 'acp',
            'acp_server': 'claude-code',
        }

    def test_request_defaults_to_none(self):
        assert AppConversationStartRequest().agent_settings_diff is None

    def test_request_rejects_credential_keys(self):
        with pytest.raises(ValidationError):
            AppConversationStartRequest(
                agent_settings_diff={'llm': {'api_key': 'sk-secret'}}
            )


class TestAcpEnabledFlag:
    @pytest.mark.parametrize(
        'value,expected',
        [
            ('true', True),
            ('True', True),
            ('1', True),
            ('false', False),
            ('0', False),
            ('', False),
        ],
    )
    def test_accepts_true_and_1(self, monkeypatch, value, expected):
        monkeypatch.setenv('ENABLE_ACP', value)
        assert acp_enabled() is expected

    def test_defaults_to_disabled(self, monkeypatch):
        monkeypatch.delenv('ENABLE_ACP', raising=False)
        assert acp_enabled() is False
