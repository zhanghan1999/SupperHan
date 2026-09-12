"""
supperh_contract - the single source of truth for the supperH driver contract.

Why this package exists
-----------------------
The same guards and the same envelope used to live in two places:
`drivers-skeleton/base_driver.py` (script channel) and whatever an MCP adapter
author copy-pasted. Duplicated guards drift, and a drifted guard is a *silent*
difference between the two channels - the one thing the double-channel design
must not have.

So: project adapters under <PRIVATE_ROOT>/drivers/<code>/ import this package and
never re-implement exit codes, the envelope, the private-root lookup or the
SELECT-only guard.

Modules
-------
codes         exit-code table + driver-exit -> JSON-RPC error mapping
envelope      the stdout/tool-result payload shape (isomorphic to base_driver)
private_root  env -> baked pointer -> tool-root sibling discovery chain
registry      projects/<code>.yaml loading + `drivers.<slot>.mcp` binding lookup
guards        SELECT-only / forbidWriteSchemas / read-only transaction prefix

Nothing in here connects to a network or reads a credential file: reaching a real
backend stays the adapter's job, so this package can be imported and unit-tested
offline.
"""

from __future__ import annotations

from .codes import (
    DRIVER_EXIT_TO_MCP_ERROR,
    EXIT_AUTH_EXPIRED,
    EXIT_BAD_ARGS,
    EXIT_OK,
    EXIT_PROJECT_UNREGISTERED,
    EXIT_SCHEMA_VIOLATION,
    EXIT_SOURCE_UNREACHABLE,
    MCP_INTERNAL_ERROR,
    MCP_INVALID_PARAMS,
    MCP_SERVER_ERROR,
    mcp_error_code_for,
)
from .envelope import (
    QUERY_OMITTED_REASONS,
    envelope_problems,
    err_envelope,
    ok_envelope,
    query_state,
)
from .guards import ContractViolation, ReadOnlyGuard, read_only_session_statements, select_only_guard
from .private_root import resolve_private_root, private_root_problems
from .registry import (
    Binding,
    ContractError,
    load_project,
    source_binding,
    whitelisted_sources,
)

__all__ = [
    "codes",
    "EXIT_OK",
    "EXIT_PROJECT_UNREGISTERED",
    "EXIT_BAD_ARGS",
    "EXIT_SOURCE_UNREACHABLE",
    "EXIT_AUTH_EXPIRED",
    "EXIT_SCHEMA_VIOLATION",
    "MCP_INVALID_PARAMS",
    "MCP_SERVER_ERROR",
    "MCP_INTERNAL_ERROR",
    "DRIVER_EXIT_TO_MCP_ERROR",
    "mcp_error_code_for",
    "ok_envelope",
    "err_envelope",
    "envelope_problems",
    "query_state",
    "QUERY_OMITTED_REASONS",
    "resolve_private_root",
    "private_root_problems",
    "ContractError",
    "Binding",
    "load_project",
    "source_binding",
    "whitelisted_sources",
    "ContractViolation",
    "ReadOnlyGuard",
    "select_only_guard",
    "read_only_session_statements",
]

__version__ = "0.1.0"
