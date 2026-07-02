"""Add enable_browser_notifications column to user and user_settings tables.

Per-user toggle for OS-level browser notifications (agent finished, awaiting
input, critical error), mirroring enable_sound_notifications.

Revision ID: 130
Revises: 129
Create Date: 2026-07-02
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = '130'
down_revision: Union[str, None] = '129'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'user',
        sa.Column('enable_browser_notifications', sa.Boolean(), nullable=True),
    )
    op.add_column(
        'user_settings',
        sa.Column('enable_browser_notifications', sa.Boolean(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column('user_settings', 'enable_browser_notifications')
    op.drop_column('user', 'enable_browser_notifications')
