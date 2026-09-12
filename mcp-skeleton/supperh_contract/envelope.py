"""
The envelope both channels return.

Field-for-field identical to `drivers-skeleton/base_driver.py:emit_ok/emit_error`,
on purpose: an agent (or a downstream Skill) must be able to parse the result of
`db_query` exactly like the stdout of `python <impl> --source db`. If the two shapes
diverge, every consumer needs a branch, and a forgotten branch reads as "no data"
instead of "wrong channel".

`meta.project` is emitted by both channels now (base_driver sets it from `--project`
as soon as argv is parsed), and `schemas/driver-response.schema.json` declares it.
It stays *optional* in the schema on purpose: an envelope rejected before any project
code was known (bad args) has nothing to name, and "missing project" must not be
reported as "the data source is empty".

`meta.query` / `meta.params` are the *reproducibility* pair. They exist because a
result without the statement that produced it cannot be audited: the reviewer sees an
answer, has no way to tell a correct one from a lucky one, and the whole point of
routing a bug through a data source is lost. Three distinct states are modelled
(see `query_state`), and the one that used to be silent - "the driver never said"
(`missing`) - is now nameable, which is the only way a consumer can flag it.
"""

from __future__ import annotations

import base64
import json
import time
from datetime import datetime, date, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Iterable

SCHEMA_VERSION = 1
DRIVER_VERSION_DEFAULT = "0.1.0"

# 为什么"没有语句"要说清而不能不吭声：一个 SQL 驱动与一个健康探测驱动同样不填
# `query`，消费方就分不清"忘了报"与"本就没有"。前者是缺陷要上报，后者是事实。
# 枚举而不是自由文本，是为了让"没报"这一格可机械发现（同义词会漂）。
QUERY_OMITTED_REASONS = (
    "adapter_opaque",   # 取数在 adapter 内部完成，壳看不到语句（MCP 通道默认）
    "redacted",         # 语句含凭据/业务敏感字，已脱敏故不给（须另附脱敏说明）
    "not_applicable",   # 本就没有可复述的语句：健康探测、列目录、读文件元信息
)


def query_state(env: Any) -> tuple[str, str | None]:
    """Classify one envelope's reproducibility state.

    Returns ``("declared", query)`` / ``("omitted", reason)`` / ``("missing", problem)``.
    Never raises: consumers call this on results they are about to report, and a
    diagnostic helper that throws would turn "we cannot show the SQL" into "we got
    no data at all" - which is the exact confusion this pair exists to prevent.

    "missing" is the state a consumer **must surface** in its final report. A driver
    that has no statement to show has to say so via ``query_omitted``; silence is a
    defect of the driver, not an absence of data.
    """
    try:
        meta = env.get("meta") if isinstance(env, dict) else None
        if not isinstance(meta, dict):
            return ("missing", "meta 不可读，无法判断语句申报状态")
        q = meta.get("query")
        omitted = meta.get("queryOmitted")
        if isinstance(q, str) and q.strip():
            if omitted is not None:
                return ("missing", "query 与 queryOmitted 同时存在，申报自相矛盾")
            return ("declared", q)
        if omitted is not None:
            if omitted not in QUERY_OMITTED_REASONS:
                return ("missing", f"queryOmitted 值不在枚举内：{omitted!r}")
            return ("omitted", str(omitted))
        return ("missing", "驱动既未给 meta.query 也未声明 queryOmitted（结果无法复现，也无法核对）")
    except Exception as e:  # noqa: BLE001 - a helper must never be the reason data is lost
        return ("missing", f"query_state 内部异常：{e.__class__.__name__}: {e}")


def _json_default(obj: Any) -> Any:
    if isinstance(obj, Decimal):
        return float(obj)
    if isinstance(obj, (datetime, date)):
        return obj.isoformat()
    if isinstance(obj, (bytes, bytearray)):
        return base64.b64encode(bytes(obj)).decode("ascii")
    if isinstance(obj, Path):
        return str(obj)
    raise TypeError("unserializable type: " + type(obj).__name__)


def dumps_compact(obj: Any) -> str:
    """Same serialisation the script channel uses (no ASCII escaping, no padding)."""
    return json.dumps(obj, ensure_ascii=False, default=_json_default, separators=(",", ":"))


def _utc_now() -> str:
    # datetime.utcnow() is deprecated on 3.12+; base_driver still calls it, so the
    # *value* stays an aware-UTC ISO string with a trailing Z either way.
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def ok_envelope(columns: Iterable[str], rows: Iterable[Iterable[Any]], source: str,
                project: str | None = None, truncated: bool = False,
                started_at: float | None = None, extra_meta: dict | None = None,
                driver_version: str = DRIVER_VERSION_DEFAULT,
                query: str | None = None, params: Any = None,
                query_omitted: str | None = None) -> dict:
    rows_list = [list(r) for r in rows]
    meta: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "source": str(source),
        "count": len(rows_list),
        "truncated": bool(truncated),
        "syncTs": _utc_now(),
        "took_ms": int((time.time() - started_at) * 1000) if started_at else 0,
        "driverVersion": driver_version,
    }
    if project:
        meta["project"] = str(project)
    # 新键一律排在 extra_meta 之前：驱动自带的同名键要能覆盖壳的默认结论
    # （壳只能说"adapter 内部取数我看不到"，adapter 自己知道真语句）。
    _set_query(meta, query, params, query_omitted)
    if extra_meta:
        meta.update(extra_meta)
    return {
        "ok": True,
        "meta": meta,
        "data": {"columns": list(columns), "rows": rows_list},
    }


def _set_query(meta: dict, query: str | None, params: Any, query_omitted: str | None) -> None:
    """Write the reproducibility pair, keeping "not said" representable.

    Mutually exclusive by construction: passing both would make the envelope claim
    "here is the statement" and "there is no statement" at once, and a consumer
    reading either one would be silently wrong. `query_omitted` loses to `query`.
    `params` is dropped together with an absent query - bound values for a statement
    nobody showed are not evidence, they are a second unexplained source of truth.
    """
    if isinstance(query, str) and query.strip():
        meta["query"] = query
        if params is not None:
            meta["params"] = params
    elif query_omitted:
        meta["queryOmitted"] = str(query_omitted)


def err_envelope(code: int, message: str, source: str | None = None,
                 project: str | None = None, detail: str | None = None) -> dict:
    meta: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "source": str(source or "unknown"),
        "syncTs": _utc_now(),
        "count": 0,
    }
    if project:
        meta["project"] = str(project)
    err: dict[str, Any] = {"code": int(code), "message": str(message)}
    if detail:
        err["detail"] = str(detail)
    return {"ok": False, "error": err, "meta": meta}


def envelope_problems(env: Any) -> list[str]:
    """Structural self-check. Non-empty means exit 5 semantics: the adapter broke
    the contract, so the shell must not forward a half-readable payload."""
    problems: list[str] = []
    if not isinstance(env, dict):
        return ["envelope is not an object"]
    if not isinstance(env.get("ok"), bool):
        problems.append("envelope.ok must be boolean")
    meta = env.get("meta")
    if not isinstance(meta, dict):
        problems.append("envelope.meta must be an object")
    else:
        if "source" not in meta:
            problems.append("envelope.meta.source missing")
    if env.get("ok") is True:
        data = env.get("data")
        if not isinstance(data, dict):
            problems.append("envelope.data must be an object when ok=true")
        else:
            if not isinstance(data.get("columns"), list):
                problems.append("envelope.data.columns must be an array")
            if not isinstance(data.get("rows"), list):
                problems.append("envelope.data.rows must be an array")
    else:
        err = env.get("error")
        if not isinstance(err, dict):
            problems.append("envelope.error must be an object when ok=false")
        elif not isinstance(err.get("code"), int):
            problems.append("envelope.error.code must be an integer (driver exit code)")
    return problems
