"""
Exit-code table shared by both channels, plus the MCP error-code mapping.

The five driver codes are frozen by `schemas/driver-response.schema.json` and by
`drivers-skeleton/base_driver.py`; changing a value here without those two is a
contract break, so `tests/mcp-manifest.test.mjs` asserts all three tables agree.

MCP has no exit code - that is precisely why deterministic gating may never run on
this channel (R3.5). The mapping below exists only so a failed tool call stays
*diagnosable* instead of turning into "the tool silently did nothing": every driver
code is projected onto a JSON-RPC error code the agent can read.
"""

from __future__ import annotations

EXIT_OK = 0
EXIT_PROJECT_UNREGISTERED = 1
EXIT_BAD_ARGS = 2
EXIT_SOURCE_UNREACHABLE = 3
EXIT_AUTH_EXPIRED = 4
EXIT_SCHEMA_VIOLATION = 5

DRIVER_EXIT_CODES = (
    EXIT_OK,
    EXIT_PROJECT_UNREGISTERED,
    EXIT_BAD_ARGS,
    EXIT_SOURCE_UNREACHABLE,
    EXIT_AUTH_EXPIRED,
    EXIT_SCHEMA_VIOLATION,
)

# JSON-RPC 2.0 standard minus-32xxxx range, plus the server-defined band.
MCP_INVALID_PARAMS = -32602   # the caller can fix it: bad/unknown source, bad params, unregistered code
MCP_INTERNAL_ERROR = -32603   # the adapter broke its own contract (exit 5)
MCP_SERVER_ERROR = -32000     # the environment is broken: unreachable, auth expired, server down

DRIVER_EXIT_TO_MCP_ERROR = {
    EXIT_PROJECT_UNREGISTERED: MCP_INVALID_PARAMS,
    EXIT_BAD_ARGS: MCP_INVALID_PARAMS,
    EXIT_SOURCE_UNREACHABLE: MCP_SERVER_ERROR,
    EXIT_AUTH_EXPIRED: MCP_SERVER_ERROR,
    EXIT_SCHEMA_VIOLATION: MCP_INTERNAL_ERROR,
}


def mcp_error_code_for(exit_code: int) -> int:
    """Project a driver exit code onto a JSON-RPC error code.

    Anything unmapped (including 0) is reported as an internal error rather than
    being swallowed: an unexpected value is itself a contract violation.
    """
    try:
        code = int(exit_code)
    except (TypeError, ValueError):
        return MCP_INTERNAL_ERROR
    if code == EXIT_OK:
        return MCP_INTERNAL_ERROR
    return DRIVER_EXIT_TO_MCP_ERROR.get(code, MCP_INTERNAL_ERROR)


def describe(exit_code: int) -> str:
    return {
        EXIT_OK: "ok",
        EXIT_PROJECT_UNREGISTERED: "project not registered",
        EXIT_BAD_ARGS: "illegal arguments",
        EXIT_SOURCE_UNREACHABLE: "source unreachable",
        EXIT_AUTH_EXPIRED: "authentication expired",
        EXIT_SCHEMA_VIOLATION: "envelope schema violation",
    }.get(int(exit_code), "unknown exit code")
