"""
Write-protection enforced *inside* the server, not in the prompt.

The rule this implements (redlines R1 / R3.5, docs/architecture.md §11): a data
channel may not be able to write, because "the model was told not to" is not a
boundary. Same keyword list and same DB_GATE_DENY marker as
`drivers-skeleton/base_driver.py`, so both channels deny the same statement - the
agreement is pinned by tests/mcp-manifest.test.mjs.

判据的形状（2026-09 改动，别改回去）：判定对象是**自己有没有出口**，不是**语句想不想写**。
数据库通道在 L1 契约里是只读源——`db.writableUser` 与 `db.forbidWriteSchemas` 已从
schemas/project.schema.yaml 退役，需要变更数据时唯一合法产物是一份 SQL 工件
（skills/supperH-driver-contract/SKILL.md §SQL 工件契约），由人执行。理由：从文本判定"这条语句会不会
改数据"不可完备（`SELECT setval(...)` 改序列、`SELECT ... INTO` 在 PG 里建表、藏在函数里的
UPDATE 都不含写关键词），而"这条通道没有执行写的出口"是恒定、可静态审计、不随 SQL 语法演化的。
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

# 写关键词之外的已知副作用形态。列在这里不是为了"识别全部写"（那做不到，见模块 docstring），
# 而是为了让"诚实形态的误用"也别悄悄通过：把只读语句当成写语句放行，比误拦一条更糟。
_SIDE_EFFECT_FN_RE = re.compile(
    r"\b(nextval|setval|txid_current|pg_sleep|pg_advisory_lock|pg_terminate_backend|"
    r"pg_cancel_backend|pg_reload_conf|dblink_exec|dblink|lo_import|lo_export|lo_put|"
    r"lo_truncate)\s*\(",
    re.IGNORECASE,
)

# PG / GaussDB 语义下 `SELECT ... INTO t` 等价于 CREATE TABLE AS —— 关键词表里没有 INTO。
_SELECT_INTO_RE = re.compile(r"\bselect\b[\s\S]*?\binto\b", re.IGNORECASE)


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


def detect_side_effect(sql: str) -> str | None:
    """关键词表盖不到的副作用形态；命中即按写处理。返回命中的标记名。"""
    clean = strip_sql_noise(sql)
    m = _SIDE_EFFECT_FN_RE.search(clean)
    if m:
        return m.group(1).upper()
    if _SELECT_INTO_RE.search(clean):
        return "SELECT_INTO"
    return None


def read_only_session_statements() -> list[str]:
    """Statements an adapter must run right after connecting, before any query.

    `BEGIN READ ONLY` is server-enforced, so a guard bypass still cannot write;
    the keyword scan above is the second, client-visible line of defence.
    """
    return [_READ_ONLY_PREFIX, "SET TRANSACTION READ ONLY"]


def select_only_guard(sql: str, target_schema: str = "", forbid_writes: Iterable[str] = ()) -> None:
    """Raise ContractViolation(exit 2) unless the statement is provably read-only.

    Message keeps the `DB_GATE_DENY:` marker the script channel emits, so log
    greps and existing agent guidance match both channels.

    两处与旧实现的实质差别（旧形态：先比 `target_schema` 是否命中 forbidWriteSchemas，
    命中才去看关键词）：

    1. **不再比库名**。旧写法有三个静默放行口：清单为空、target_schema 为空、以及层级错配
       —— 清单里装的是 database 名（`appdb`），adapter 传的是 PG schema 名（`app_dw`，来自
       jdbc URL 的 currentSchema），两者永不相等，于是配对了也拦不住，配错了更拦不住。
    2. **未知即拒**。旧实现的否定分支什么都不做，"没配"读起来就是"无限制"。空语句 / 仅含
       注释的语句证不出只读，一律拒。

    `target_schema` / `forbid_writes` 两个形参是已退役机制的**兼容位**，不参与判定：留着是
    为了让存量 adapter 的 `guard.check(sql, schema)` 不至于 TypeError。新代码只传 sql。
    """
    raw = str(sql or "")
    if not strip_sql_noise(raw).strip():
        raise ContractViolation(
            EXIT_BAD_ARGS,
            "DB_GATE_DENY: unjudgeable statement —— 空语句或仅含注释，无法证明它是只读的（未知即拒）",
        )
    kw = detect_write(raw) or detect_side_effect(raw)
    if kw is not None:
        raise ContractViolation(
            EXIT_BAD_ARGS,
            "DB_GATE_DENY: write side effect " + kw
            + " —— 数据库通道无条件只读；需要变更数据请产出 SQL 工件交人工执行"
            "（见 skills/supperH-driver-contract/SKILL.md §SQL 工件契约）",
        )


class ReadOnlyGuard:
    """Reusable wrapper for database adapters: guard.check(sql) then execute.

    构造参数与 `check` 的第二个参数是兼容位（见 select_only_guard 的说明），不参与判定。
    """

    def __init__(self, forbid_writes: Iterable[str] = ()):
        self.forbid_writes = [str(s) for s in (forbid_writes or [])]

    def check(self, sql: str, target_schema: str = "") -> None:
        select_only_guard(sql, target_schema, self.forbid_writes)

    def begin_statements(self) -> list[str]:
        return read_only_session_statements()
