#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
supperH driver skeleton - base_driver.py

Shared utilities for building data-fetch drivers that conform to the
`driver-contract` skill in this repository.

This file is a SKELETON. It does not connect to any real backend.
Copy it (or example_json_driver.py) to <PRIVATE_ROOT>/drivers/ and
subclass BaseDriver to implement your own internal-network fetcher.

Contract:
  CLI  : python <impl> --project <code> --source <name> [--filter k=v]...
                [--limit N] [--timeout S] [--params <json-file>] [--dry-run]
         python <impl> --project <code> --health
  Out  : JSON envelope on stdout (single line, no ANSI). Debug to stderr.
         Every success envelope must settle its statement question: either
         `meta.query` (+ `meta.params`) showing what actually ran, or
         `meta.queryOmitted` naming why there is nothing to show.
  Cfg  : per-project registry <PRIVATE_ROOT>/projects/<code>.yaml
         (falls back to legacy single project.yaml during migration)
  Exit : 0 ok | 1 project unregistered | 2 bad args | 3 unreachable
         | 4 auth expired | 5 schema violation
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
import time
import traceback
from datetime import datetime, date
from decimal import Decimal
from pathlib import Path
from typing import Any, Iterable


# ---------- Exit codes (do not change) ----------
EXIT_OK = 0
EXIT_PROJECT_UNREGISTERED = 1
EXIT_BAD_ARGS = 2
EXIT_SOURCE_UNREACHABLE = 3
EXIT_AUTH_EXPIRED = 4
EXIT_SCHEMA_VIOLATION = 5

DRIVER_SCHEMA_VERSION = 1
DRIVER_VERSION_DEFAULT = "0.1.0"

WRITE_SQL_KEYWORDS = (
    "INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "TRUNCATE",
    "CREATE", "GRANT", "REVOKE", "MERGE", "REPLACE",
    "CALL", "EXEC", "EXECUTE",
)

_TRACE = os.environ.get("SUPPERH_TRACE") == "1"

# Set as soon as argv carries --project, so every envelope (incl. the error ones
# raised before config routing) names the project it was asked about. The MCP
# channel does the same via supperh_contract.envelope - `project` must not be the
# one field that differs per channel, or consumers need a branch to read results.
_PROJECT_CODE: str | None = None


def trace(msg: str) -> None:
    """Emit debug info to stderr only; stdout is reserved for the JSON envelope."""
    if _TRACE:
        sys.stderr.write("[supperH-trace] " + msg + "\n")
        sys.stderr.flush()


# ---------- JSON helpers ----------
def _json_default(obj: Any) -> Any:
    """Convert Decimal/datetime/bytes to JSON-safe primitives."""
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
    return json.dumps(obj, ensure_ascii=False, default=_json_default, separators=(",", ":"))


# ---------- Envelope emit ----------
def emit_ok(columns: Iterable[str], rows: Iterable[Iterable[Any]],
            source: str, truncated: bool = False,
            extra_meta: dict | None = None,
            driver_version: str = DRIVER_VERSION_DEFAULT,
            query: str | None = None, params: Any = None,
            query_omitted: str | None = None) -> None:
    """Print a success envelope to stdout and exit 0.

    The ``query`` / ``params`` pair is what makes a result checkable: `query` is the
    statement actually executed (placeholders kept, values go to `params`), never a
    reconstructed one. A driver with nothing to show **must** pass
    ``query_omitted`` (one of adapter_opaque | redacted | not_applicable) instead of
    staying silent: silence is indistinguishable from "forgot to report", and the
    consumer's only defence is to surface it as `query_missing`.
    Keep the envelope keys and the ``query`` / ``params`` / ``query_omitted`` trio
    identical to ``mcp-skeleton/supperh_contract/envelope.py:ok_envelope`` - the two
    channels must stay parseable by one piece of consumer code. ``project`` and the
    clock are *not* parameters here because the script channel already knows them
    (``--project`` parsed from argv, module-level start timestamp); the MCP shell has
    to be told. Same output, different plumbing.
    """
    rows_list = [list(r) for r in rows]
    meta = {
        "schemaVersion": DRIVER_SCHEMA_VERSION,
        "source": source,
        "count": len(rows_list),
        "truncated": bool(truncated),
        "syncTs": datetime.utcnow().isoformat() + "Z",
        "took_ms": int((time.time() - _START_TS) * 1000),
        "driverVersion": driver_version,
    }
    # 新键排在 extra_meta 之前，与 ok_envelope 同序：驱动自己的 query 必须能覆盖默认值
    if isinstance(query, str) and query.strip():
        meta["query"] = query
        if params is not None:
            meta["params"] = params
    elif query_omitted:
        meta["queryOmitted"] = str(query_omitted)
    if extra_meta:
        meta.update(extra_meta)
    if _PROJECT_CODE:
        meta["project"] = _PROJECT_CODE
    envelope = {"ok": True, "meta": meta,
                "data": {"columns": list(columns), "rows": rows_list}}
    sys.stdout.write(dumps_compact(envelope) + "\n")
    sys.stdout.flush()
    sys.exit(EXIT_OK)


def emit_error(code: int, message: str, source: str | None = None,
               detail: str | None = None) -> None:
    """Print a failure envelope to stdout and exit with `code`."""
    meta = {"schemaVersion": DRIVER_SCHEMA_VERSION, "source": source or "unknown",
            "syncTs": datetime.utcnow().isoformat() + "Z", "count": 0}
    if _PROJECT_CODE:
        meta["project"] = _PROJECT_CODE
    err = {"code": int(code), "message": str(message)}
    if detail:
        err["detail"] = str(detail)
    envelope = {"ok": False, "error": err, "meta": meta}
    sys.stdout.write(dumps_compact(envelope) + "\n")
    sys.stdout.flush()
    sys.exit(int(code))


# ---------- Argument parsing ----------
def build_arg_parser(description: str) -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="supperH-driver",
        description=description,
        add_help=True,
    )
    p.add_argument("--project", required=False, help="Project code (matches PROJECT.identity.code)")
    p.add_argument("--source", required=False, help="Logical source name under the driver's config")
    p.add_argument("--filter", action="append", default=[], metavar="K=V",
                   help="Repeatable; filter expression")
    p.add_argument("--limit", type=int, default=None, help="Row limit")
    p.add_argument("--timeout", type=int, default=30, help="Overall timeout, seconds")
    p.add_argument("--params", type=str, default=None,
                   help="Absolute path to a JSON file with complex arguments")
    p.add_argument("--dry-run", action="store_true", help="Do not actually fetch; validate args and exit 0")
    p.add_argument("--health", action="store_true",
                   help="Probe driver/backend reachability and exit 0 when healthy (no data fetch)")
    return p


def parse_filters(pairs: list[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for raw in pairs:
        if "=" not in raw:
            emit_error(EXIT_BAD_ARGS, "malformed --filter: " + raw)
        k, v = raw.split("=", 1)
        out[k.strip()] = v.strip()
    return out


def load_params_file(path: str) -> dict:
    if not path:
        return {}
    p = Path(path).expanduser().resolve()
    if not p.is_file():
        emit_error(EXIT_BAD_ARGS, "--params file not readable: " + str(p))
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception as e:
        emit_error(EXIT_BAD_ARGS, "--params JSON parse fail: " + str(e))


# ---------- Liveness probes (protocol level; used by health()) ----------
def http_health(url: str, timeout: float = 8.0,
                verify: bool = True) -> tuple[int | None, str]:
    """Ask an HTTP(S) endpoint whether it is alive. Returns (status_or_None, detail).

    ANY HTTP status counts as alive - including 401/403. That asymmetry is the whole
    point: a 401 means the service is standing right there and only credentials are
    missing (exit 4), while a refused/hanging connection is what "unreachable"
    (exit 3) actually means.

    Do NOT replace this with socket.connect(): measured against a zero-trust tunnel,
    connect() succeeds on *every* port of an internal host - port 1, 59999 and 65500
    on one such box all came back "open" in 0.00-0.02s - because
    the gateway completes the handshake on behalf of the target, then drops whatever
    you send (the same probe at HTTP level gets `RemoteDisconnected` in ~0.2s,
    while the real port answers `401` in ~0.3s). "Port open" therefore carries zero
    information. ICMP is no better - internal hosts filter echo replies.
    Both were tried before this helper existed; <TOOL_ROOT>/docs/architecture.md §10.8
    keeps the numbers.

    `verify=False` is legitimate for a liveness probe on endpoints with a private CA:
    a certificate error would otherwise be reported as "service down". It asserts
    liveness only - never fetch data over a disabled-verification context.

    `detail` is a short string safe to show the user (no headers, no body).
    """
    import ssl
    import urllib.error
    import urllib.request
    req = urllib.request.Request(url, method="GET",
                                 headers={"User-Agent": "supperH-driver-health"})
    ctx = None
    if not verify:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            return int(resp.status), "HTTP " + str(resp.status)
    except urllib.error.HTTPError as e:      # a status response: service is alive
        return int(e.code), "HTTP " + str(e.code)
    except Exception as e:
        return None, type(e).__name__ + ": " + str(e)[:160]


def http_health_code(url: str, timeout: float = 8.0, verify: bool = True) -> tuple[int, str]:
    """http_health() mapped onto the driver exit-code contract: (code, detail).

    0 alive | 3 unreachable | 4 reachable but unauthenticated. A driver's health()
    can return this straight away, so 'is the backend up' and 'do I have a valid
    session' stop collapsing into one another.
    """
    status, detail = http_health(url, timeout=timeout, verify=verify)
    if status is None:
        return EXIT_SOURCE_UNREACHABLE, detail
    if status in (401, 403):
        return EXIT_AUTH_EXPIRED, detail + " (服务在场，只缺有效凭据)"
    return EXIT_OK, detail


# ---------- Project / private-root resolution ----------
def resolve_private_root() -> Path | None:
    """
    Locate <TOOL_ROOT>/../supper-Han-private.
    TOOL_ROOT is inferred as the parent-of-parent of this file
    (this file lives at <TOOL_ROOT>/drivers-skeleton/base_driver.py).
    If the driver has been copied out to <PRIVATE_ROOT>/drivers/,
    the caller can set SUPPERH_PRIVATE_ROOT env to override.
    """
    env = os.environ.get("SUPPERH_PRIVATE_ROOT")
    if env:
        p = Path(env).expanduser().resolve()
        return p if p.is_dir() else None
    here = Path(__file__).resolve()
    # Best-effort: search upward for a directory containing project.yaml sibling-named supper-Han-private
    for base in [here.parent, *here.parents]:
        candidate = base / "supper-Han-private"
        if candidate.is_dir():
            return candidate.resolve()
    return None


def load_project_yaml(project_code: str) -> dict:
    """
    Route to the per-project config file: <PRIVATE_ROOT>/projects/<code>.yaml.
    Falls back to the legacy single project.yaml (matching identity.code) during
    migration, so existing setups keep working until they move to the registry.
    Uses a minimal YAML-subset parser to avoid third-party deps; the driver only
    needs `identity.code` and `drivers.<slot>.config` for typical implementations.
    Multiple projects can be registered simultaneously (one file each).
    """
    root = resolve_private_root()
    if root is None:
        emit_error(EXIT_PROJECT_UNREGISTERED,
                   "private root not found; run /supperH-bootstrap")
    code = str(project_code or "").strip()
    if not code:
        emit_error(EXIT_BAD_ARGS, "--project <code> is required to route config")

    # Preferred: per-project registry file projects/<code>.yaml (or .yml).
    reg = root / "projects"
    proj_file = reg / (code + ".yaml")
    if not proj_file.is_file():
        alt = reg / (code + ".yml")
        if alt.is_file():
            proj_file = alt

    data: dict | None = None
    if proj_file.is_file():
        data = _parse_yaml_subset(proj_file.read_text(encoding="utf-8"))
    else:
        # Legacy fallback: single project.yaml, and its code must match.
        legacy = root / "project.yaml"
        if not legacy.is_file():
            emit_error(EXIT_PROJECT_UNREGISTERED,
                       "no project config for code '" + code
                       + "' (looked at projects/" + code + ".yaml and project.yaml)")
        data = _parse_yaml_subset(legacy.read_text(encoding="utf-8"))
        ident = (data.get("identity") or {})
        if str(ident.get("code", "")).strip() != code:
            emit_error(EXIT_PROJECT_UNREGISTERED,
                       "project code mismatch: requested=" + code
                       + " registered=" + str(ident.get("code", "")))

    # Guard against a registry file whose identity.code disagrees with its name.
    ident = (data.get("identity") or {})
    got = str(ident.get("code", "")).strip()
    if got and got != code:
        emit_error(EXIT_PROJECT_UNREGISTERED,
                   "project code mismatch: file=" + code + " identity.code=" + got)
    return data


def _parse_yaml_subset(text: str) -> dict:
    """
    Very small YAML-subset parser: handles 2-space indentation,
    scalar values (string / int / bool / null), and simple `key: value` maps.
    Sufficient for reading project.yaml at driver-side; sync-side uses
    a proper YAML lib in Node.
    """
    root: dict = {}
    stack: list[tuple[int, Any]] = [(-1, root)]
    for raw in text.splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip(" "))
        line = raw.strip()
        while stack and stack[-1][0] >= indent:
            stack.pop()
        if not stack:
            stack.append((-1, root))
        parent = stack[-1][1]
        if line.startswith("- "):
            # list item under a key
            val = line[2:].strip()
            if isinstance(parent, list):
                parent.append(_coerce(val))
            continue
        if ":" in line:
            k, _, v = line.partition(":")
            k = k.strip()
            v = v.strip()
            if v == "":
                child: dict = {}
                parent[k] = child
                stack.append((indent, child))
            else:
                parent[k] = _coerce(v)
    return root


def _coerce(v: str) -> Any:
    if v in ("true", "True"):
        return True
    if v in ("false", "False"):
        return False
    if v in ("null", "~", "None", ""):
        return None
    try:
        if re.fullmatch(r"-?\d+", v):
            return int(v)
        if re.fullmatch(r"-?\d+\.\d+", v):
            return float(v)
    except Exception:
        pass
    if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
        return v[1:-1]
    return v


# ---------- SQL guard ----------
def strip_sql_noise(sql: str) -> str:
    """Remove comments and string literals so keyword scan is safe."""
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


def SELECT_only_guard(sql: str, target_schema: str, forbid_writes: Iterable[str]) -> None:
    """
    Raise SystemExit(EXIT_BAD_ARGS) if this SQL is a write AND
    `target_schema` is in the forbid list.
    """
    forbid = {str(s).strip().lower() for s in (forbid_writes or [])}
    if str(target_schema).strip().lower() in forbid:
        kw = detect_write(sql)
        if kw is not None:
            emit_error(EXIT_BAD_ARGS,
                       "DB_GATE_DENY: write keyword " + kw + " against forbidden schema " + str(target_schema))


# ---------- Base class ----------
_START_TS = time.time()


class BaseDriver:
    """
    Subclass contract:
      - implement `run(args)`; call `emit_ok` / `emit_error` inside it
      - do not print to stdout except via those helpers
      - do not swallow unexpected exceptions: the top-level `main()`
        wraps your `run` in a try/except and turns any leak into exit 5.
    """

    name: str = "unnamed-driver"
    version: str = DRIVER_VERSION_DEFAULT

    def run(self, args: argparse.Namespace,
            project_cfg: dict,
            filters: dict[str, str],
            params_json: dict) -> None:
        raise NotImplementedError

    def health(self, args: argparse.Namespace, project_cfg: dict):
        """Override to probe the real backend. Return (ok: bool, detail: str).

        The probe must speak the protocol, not look around it: open a DB connection
        with the configured account, or hit the HTTP endpoint via http_health().
        Forbidden as criterion: ICMP ping, VPN/client/adapter names, bare TCP connect
        (all three report "fine" against a zero-trust gateway while nothing works -
        see http_health's docstring and <TOOL_ROOT>/docs/architecture.md §10.8).
        Keep it inside a budget: <=8s per endpoint, <=20s total, never hang. Size it
        for the COLD case - the first TLS handshake of an HTTPS endpoint through a
        zero-trust tunnel measured >3s, while the same endpoint answered warm in 0.2s.
        A 2-3s budget therefore reports a living service as unreachable.

        Skeleton default: config resolved, nothing probed (no live backend here). A
        real driver must not ship this default - it would pass the gate while offline.
        """
        return True, "default health (skeleton driver; no live backend probed)"

    def _run_health(self, args: argparse.Namespace) -> None:
        """--health path: optionally load config by code, probe, emit envelope."""
        cfg: dict = {}
        if args.project:
            try:
                cfg = load_project_yaml(args.project)
            except SystemExit:
                raise
            except Exception as e:
                emit_error(EXIT_PROJECT_UNREGISTERED,
                           "load config failed for code '" + str(args.project) + "': " + str(e),
                           source=args.source)
        try:
            ok, detail = self.health(args, cfg)
        except SystemExit:
            raise
        except Exception as e:
            emit_error(EXIT_SOURCE_UNREACHABLE, "health probe error: " + str(e),
                       source=args.source)
        if ok:
            # A liveness probe genuinely has no statement; saying so (query_omitted) is
            # what keeps it out of the consumer's `query_missing` report. Leaving both
            # keys absent would read as "this driver forgot to report" - same symptom,
            # opposite verdict.
            emit_ok(columns=["healthy"], rows=[[True]], source=args.source or "health",
                    extra_meta={"health": True, "detail": str(detail or "")},
                    driver_version=self.version, query_omitted="not_applicable")
        emit_error(EXIT_SOURCE_UNREACHABLE,
                   "health check failed: " + str(detail or "unreachable"),
                   source=args.source or "health")

    def main(self, argv: list[str] | None = None) -> None:
        global _START_TS, _PROJECT_CODE
        _START_TS = time.time()
        parser = build_arg_parser(f"supperH driver: {self.name}")
        args = parser.parse_args(argv)
        if args.project:
            _PROJECT_CODE = str(args.project)

        if args.dry_run:
            # Just print a minimal envelope; caller verifies CLI shape.
            emit_ok(columns=["dry_run"], rows=[[True]], source=args.source or "dry",
                    driver_version=self.version, query_omitted="not_applicable")

        if args.health:
            # healthCheck template may omit --source (a liveness probe has no source).
            self._run_health(args)
            return

        if not args.project:
            emit_error(EXIT_BAD_ARGS, "--project is required")
        if not args.source:
            emit_error(EXIT_BAD_ARGS, "--source is required")

        try:
            project_cfg = load_project_yaml(args.project)
        except SystemExit:
            raise
        except Exception as e:
            emit_error(EXIT_PROJECT_UNREGISTERED, "load project.yaml failed: " + str(e))

        filters = parse_filters(args.filter or [])
        params_json = load_params_file(args.params) if args.params else {}

        try:
            self.run(args, project_cfg, filters, params_json)
        except SystemExit:
            raise
        except Exception as e:
            sys.stderr.write(traceback.format_exc())
            emit_error(EXIT_SCHEMA_VIOLATION, "unhandled exception: " + str(e))

        # If run() returned without calling emit_*, treat as schema violation.
        emit_error(EXIT_SCHEMA_VIOLATION, "run() returned without emitting envelope")
