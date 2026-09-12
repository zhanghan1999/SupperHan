"""
Write-protection enforced *inside* the server, not in the prompt.

The rule this implements (redlines R1 / R3.5, docs/architecture.md §11): a data
channel may not be able to write, because "the model was told not to" is not a
boundary. Same keyword list and same DB_GATE_DENY marker as
`drivers-skeleton/base_driver.py`, so both channels deny the same statement - the
agreement is pinned by tests/mcp-manifest.test.mjs.
"""

from __future__ import annotations

import re
from typing import Iterable

from .codes import EXIT_BAD_ARGS


class ContractViolation(Exception):
    """Raised instead of sys.exit(): a server process must keep serving after a deny."""

    def __init__(self, exit_code: int, message: str):
        super().__init__(message)
        self.exit_code = int(exit_code)
        self.message = message


WRITE_SQL_KEYWORDS = (
    "INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "TRUNCATE",
    "CREATE", "GRANT", "REVOKE", "MERGE", "REPLACE",
    "CALL", "EXEC", "EXECUTE",
)

_READ_ONLY_PREFIX = "BEGIN READ ONLY"


def strip_sql_noise(sql: str) -> str:
    """Comments and literals out, so a keyword inside a string is not a write."""
    out: list[str] = []
    i, n = 0, len(sql)
    while i < n:
        c = sql[i]
        nxt = sql[i + 1] if i + 1 < n else ""
        if c == "-" and nxt == "-":
            j = sql.find("\n", i)
            i = n if j == -1 else j
            continue
        if c == "/" and nxt == "*":
            j = sql.find("*/", i + 2)
            i = n if j == -1 else j + 2
            continue
        if c in ("'", '"'):
            q = c
            i += 1
            while i < n:
                if sql[i] == "\\" and i + 1 < n:
                    i += 2
                    continue
                if sql[i] == q:
                    i += 1
                    break
                i += 1
            continue
        if c == "$" and sql.startswith("$$", i):
            j = sql.find("$$", i + 2)
            i = n if j == -1 else j + 2
            continue
        out.append(c)
        i += 1
    return "".join(out)


def detect_write(sql: str) -> str | None:
    clean = strip_sql_noise(sql).upper()
    for kw in WRITE_SQL_KEYWORDS:
        if re.search(r"\b" + kw + r"\b", clean):
            return kw
    return None


def read_only_session_statements() -> list[str]:
    """Statements an adapter must run right after connecting, before any query.

    `BEGIN READ ONLY` is server-enforced, so a guard bypass still cannot write;
    the keyword scan above is the second, client-visible line of defence.
    """
    return [_READ_ONLY_PREFIX, "SET TRANSACTION READ ONLY"]


def select_only_guard(sql: str, target_schema: str, forbid_writes: Iterable[str]) -> None:
    """Raise ContractViolation(exit 2) on a write against a forbidden schema.

    Message keeps the `DB_GATE_DENY:` marker the script channel emits, so log
    greps and existing agent guidance match both channels.
    """
    forbid = {str(s).strip().lower() for s in (forbid_writes or [])}
    if str(target_schema or "").strip().lower() in forbid:
        kw = detect_write(sql)
        if kw is not None:
            raise ContractViolation(
                EXIT_BAD_ARGS,
                "DB_GATE_DENY: write keyword " + kw + " against forbidden schema " + str(target_schema),
            )


class ReadOnlyGuard:
    """Reusable wrapper for database adapters: guard(sql, schema) then execute."""

    def __init__(self, forbid_writes: Iterable[str] = ()):
        self.forbid_writes = [str(s) for s in (forbid_writes or [])]

    def check(self, sql: str, target_schema: str) -> None:
        select_only_guard(sql, target_schema, self.forbid_writes)

    def begin_statements(self) -> list[str]:
        return read_only_session_statements()
