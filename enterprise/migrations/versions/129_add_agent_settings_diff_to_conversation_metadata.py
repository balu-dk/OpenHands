"""Add agent_settings_diff column to conversation_metadata table.

Stores the per-conversation agent-settings override (sparse, credential-free
diff over the user's settings) so the agent engine choice is bound to the
session rather than the user's global settings.

Revision ID: 129
Revises: 128
Create Date: 2026-07-02
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = '129'
down_revision: Union[str, None] = '128'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'conversation_metadata',
        sa.Column('agent_settings_diff', sa.JSON(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column('conversation_metadata', 'agent_settings_diff')
