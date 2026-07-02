"""Add agent_settings_diff column to conversation_metadata table

Stores the per-conversation agent-settings override (sparse, credential-free
diff over the user's settings) so the agent engine choice is bound to the
session rather than the user's global settings.

Revision ID: 015
Revises: 014
Create Date: 2026-07-02 00:00:00.000000
"""

from typing import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = '015'
down_revision: str | None = '014'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        'conversation_metadata',
        sa.Column('agent_settings_diff', sa.JSON, nullable=True),
    )


def downgrade() -> None:
    op.drop_column('conversation_metadata', 'agent_settings_diff')
