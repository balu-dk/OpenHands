"""Tests for checking a repository out into a running conversation's workspace.

Covers ``clone_git_repository`` (task-free clone core, shared with
conversation start) and ``checkout_repository_into_workspace`` (the
mid-conversation project switch: clone side-by-side + per-repo setup).
"""

from unittest.mock import AsyncMock, Mock

import pytest

from openhands.app_server.app_conversation.app_conversation_service_base import (
    RepositoryCheckoutError,
)
from openhands.app_server.app_conversation.live_status_app_conversation_service import (
    LiveStatusAppConversationService,
)
from openhands.app_server.integrations.service_types import ProviderType
from openhands.app_server.user.user_context import UserContext


class FakeUserInfo:
    def __init__(self, git_full_clone: bool = False):
        self.git_full_clone = git_full_clone
        self.git_user_name = None
        self.git_user_email = None


class FakeCommandResult:
    def __init__(self, exit_code: int = 0, stderr: str = '', stdout: str = ''):
        self.exit_code = exit_code
        self.stderr = stderr
        self.stdout = stdout


class FakeWorkspace:
    """Scriptable AsyncRemoteWorkspace stand-in.

    ``responders`` maps a substring of the command to an exit code; the first
    matching entry wins. Unmatched commands succeed. All executed commands are
    recorded for assertions.
    """

    def __init__(self, working_dir: str = '/workspace/project', responders=None):
        self.working_dir = working_dir
        self.responders = responders or {}
        self.commands: list[str] = []

    async def execute_command(self, command, cwd=None, timeout=None):
        self.commands.append(command)
        for needle, exit_code in self.responders.items():
            if needle in command:
                return FakeCommandResult(exit_code=exit_code)
        return FakeCommandResult(exit_code=0)


@pytest.fixture
def service():
    mock_user_context = Mock(spec=UserContext)
    mock_user_context.get_user_info = AsyncMock(return_value=FakeUserInfo())
    mock_user_context.get_authenticated_git_url = AsyncMock(
        return_value='https://x-access-token:tok@github.com/owner/repo.git'
    )
    return LiveStatusAppConversationService(
        init_git_in_empty_workspace=True,
        user_context=mock_user_context,
        app_conversation_info_service=Mock(),
        app_conversation_start_task_service=Mock(),
        event_callback_service=Mock(),
        event_service=Mock(),
        sandbox_service=Mock(),
        sandbox_spec_service=Mock(),
        jwt_service=Mock(),
        pending_message_service=Mock(),
        sandbox_startup_timeout=30,
        sandbox_startup_poll_frequency=1,
        max_num_conversations_per_sandbox=20,
        httpx_client=Mock(),
        web_url=None,
        openhands_provider_base_url=None,
        access_token_hard_timeout=None,
        app_mode='test',
    )


class TestCloneGitRepository:
    @pytest.mark.asyncio
    async def test_fresh_shallow_clone_with_branch(self, service):
        # `test -d repo/.git` fails -> directory does not exist -> clone path.
        workspace = FakeWorkspace(responders={'test -d': 1})

        git_dir = await service.clone_git_repository(
            workspace, 'owner/repo', 'feature-x', ProviderType.GITHUB
        )

        assert str(git_dir) == '/workspace/project/repo'
        clone_cmds = [c for c in workspace.commands if c.startswith('git clone')]
        assert len(clone_cmds) == 1
        assert '--depth 1' in clone_cmds[0]
        assert '--branch feature-x' in clone_cmds[0]
        assert any(c.startswith('git checkout feature-x') for c in workspace.commands)

    @pytest.mark.asyncio
    async def test_fresh_clone_without_branch_uses_workspace_branch(self, service):
        workspace = FakeWorkspace(responders={'test -d': 1})

        await service.clone_git_repository(
            workspace, 'owner/repo', None, ProviderType.GITHUB
        )

        assert any(
            'git checkout -b openhands-workspace-' in c for c in workspace.commands
        )

    @pytest.mark.asyncio
    async def test_clone_failure_raises_when_strict(self, service):
        workspace = FakeWorkspace(responders={'test -d': 1, 'git clone': 128})

        with pytest.raises(RepositoryCheckoutError) as exc_info:
            await service.clone_git_repository(
                workspace, 'owner/repo', 'main', ProviderType.GITHUB, strict=True
            )
        # The error is client-safe: no stderr (which can echo the token URL).
        assert 'tok' not in str(exc_info.value)
        assert 'owner/repo' in str(exc_info.value)

    @pytest.mark.asyncio
    async def test_clone_failure_only_warns_when_not_strict(self, service):
        workspace = FakeWorkspace(responders={'test -d': 1, 'git clone': 128})

        git_dir = await service.clone_git_repository(
            workspace, 'owner/repo', 'main', ProviderType.GITHUB, strict=False
        )

        # Conversation-start behavior: no raise, returns the target dir.
        assert str(git_dir) == '/workspace/project/repo'

    @pytest.mark.asyncio
    async def test_existing_checkout_is_not_recloned(self, service):
        # `test -d repo/.git` succeeds -> existing checkout.
        workspace = FakeWorkspace(responders={'test -d': 0})

        git_dir = await service.clone_git_repository(
            workspace, 'owner/repo', 'main', ProviderType.GITHUB
        )

        assert str(git_dir) == '/workspace/project/repo'
        assert not any('git clone' in c for c in workspace.commands)
        assert any(c.startswith('git fetch') for c in workspace.commands)
        assert any(c.startswith('git checkout main') for c in workspace.commands)

    @pytest.mark.asyncio
    async def test_existing_checkout_falls_back_to_fetch_head(self, service):
        # Plain checkout fails (branch not local); fallback creates it from
        # FETCH_HEAD after the shallow fetch.
        workspace = FakeWorkspace(
            responders={'test -d': 0, 'git checkout feature-y\n': 1}
        )

        # Exact-match responder trick doesn't work with substring matching, so
        # script explicitly: first checkout fails, fallback succeeds.
        calls = []

        async def execute_command(command, cwd=None, timeout=None):
            calls.append(command)
            if command == 'git checkout feature-y':
                return FakeCommandResult(exit_code=1)
            if 'test -d' in command:
                return FakeCommandResult(exit_code=0)
            return FakeCommandResult(exit_code=0)

        workspace.execute_command = execute_command

        await service.clone_git_repository(
            workspace, 'owner/repo', 'feature-y', ProviderType.GITHUB
        )

        assert 'git checkout -b feature-y FETCH_HEAD' in calls

    @pytest.mark.asyncio
    async def test_missing_git_url_raises_value_error(self, service):
        service.user_context.get_authenticated_git_url = AsyncMock(return_value='')
        workspace = FakeWorkspace()

        with pytest.raises(ValueError):
            await service.clone_git_repository(
                workspace, 'owner/repo', None, ProviderType.GITHUB
            )

    @pytest.mark.asyncio
    async def test_invalid_branch_name_rejected(self, service):
        workspace = FakeWorkspace(responders={'test -d': 1})

        with pytest.raises(ValueError):
            await service.clone_git_repository(
                workspace, 'owner/repo', '$(rm -rf /)', ProviderType.GITHUB
            )


class TestCheckoutRepositoryIntoWorkspace:
    @pytest.mark.asyncio
    async def test_runs_clone_setup_and_hooks(self, service):
        workspace = FakeWorkspace(responders={'test -d': 1})
        service.maybe_run_setup_script = AsyncMock()
        service.maybe_setup_git_hooks = AsyncMock()

        project_dir = await service.checkout_repository_into_workspace(
            workspace, 'owner/other-repo', 'main', ProviderType.GITHUB
        )

        assert project_dir == '/workspace/project/other-repo'
        service.maybe_run_setup_script.assert_awaited_once_with(workspace, project_dir)
        service.maybe_setup_git_hooks.assert_awaited_once_with(workspace, project_dir)

    @pytest.mark.asyncio
    async def test_propagates_checkout_error(self, service):
        workspace = FakeWorkspace(responders={'test -d': 1, 'git clone': 1})
        service.maybe_run_setup_script = AsyncMock()
        service.maybe_setup_git_hooks = AsyncMock()

        with pytest.raises(RepositoryCheckoutError):
            await service.checkout_repository_into_workspace(
                workspace, 'owner/other-repo', 'main', ProviderType.GITHUB
            )

        # Setup must not run when the clone failed.
        service.maybe_run_setup_script.assert_not_awaited()
