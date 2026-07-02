"""Shared feature-flag helpers.

Flags that gate behavior in more than one place (e.g. both the web-client
config and API validation) must be read through a single helper so the UI
and the API can never disagree about whether a feature is on.
"""

import os


def acp_enabled() -> bool:
    """Whether ACP (Agent Client Protocol) subprocess agents are enabled.

    Gates both the web-client ``enable_acp`` feature flag and API-level
    validation of per-conversation ACP engine overrides.
    """
    return os.getenv('ENABLE_ACP', 'false').lower() in ('true', '1')
