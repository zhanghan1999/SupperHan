#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
supperH MCP shell server  (stdio)

WHAT THIS IS
------------
One registration entry (`supperh-drivers`) shipped inside the L1 plugin, in
plugin-relative form. It holds no credentials and no project values. At run time it
reads <PRIVATE_ROOT>/projects/<code>.yaml, checks the requested `source` against the
closed `drivers.<slot>.mcp.sources` whitelist, then importlib-loads the company
specific adapter at <PRIVATE_ROOT>/drivers/<code>/adapter.py.

Because the adapter is *looked up*, not *registered*, adding a project never edits
.mcp.json / IDE settings - the drift class "project configured but server not
registered" cannot occur.

WHAT THIS IS NOT
----------------
Not a gate. MCP tool calls have no exit code, and when a server fails to start its
tools vanish from the list silently. Deterministic branching stays on the script
channel's exit codes (redline R3.5), which is why the registration probe runs the
slot's *script* `healthCheck` even when `kind: mcp`, and why this shell's `--health`
answers questions about plumbing only - never about whether a backend is up.

CLI - every mode exits with the *driver* exit code (0..5), which is what gives the
registration-time probe (init-project.mjs:probeDrivers) something to assert on:

    python shell.py --serve
    python shell.py --self-test [--project <code>]
    python shell.py --health --project <code> --slot <slot>   # 注册期探测：只查管路（私有根/注册文件/白名单/adapter 可装载），不碰后端，因此不声称“服务可达”
    python shell.py --query --project <code> --source <name> [--params <json>] [--limit N]
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
import time
from pathlib import Path

# Run as `python mcp-skeleton/shell.py`: CPython puts this file's directory on
# sys.path[0], so the bundled contract package is importable without installation.
HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

# MCP stdio is UTF-8 by spec and our envelopes carry Chinese diagnostics. Left at the
# default, CPython encodes with the console code page (cp936 on zh-CN Windows): the
# Node/IDE side decodes UTF-8 and gets mojibake, and a character outside that code page
# raises UnicodeEncodeError *while writing the message that explains a failure*.
# stdout stays strict (silently replacing would corrupt protocol payloads); stderr is
# diagnostics only, so it may degrade.
try:
    sys.stdout.reconfigure(encoding="utf-8")
except AttributeError:
    pass
try:
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except AttributeError:
    pass

from supperh_contract.codes import (  # noqa: E402
    EXIT_BAD_ARGS,
    EXIT_OK,
    EXIT_PROJECT_UNREGISTERED,
    EXIT_SCHEMA_VIOLATION,
    EXIT_SOURCE_UNREACHABLE,
    mcp_error_code_for,
)
from supperh_contract.envelope import (  # noqa: E402
    dumps_compact,
    envelope_problems,
    err_envelope,
    ok_envelope,
)
from supperh_contract.guards import ContractViolation, ReadOnlyGuard  # noqa: E402
from supperh_contract.private_root import resolve_private_root  # noqa: E402
from supperh_contract.registry import (  # noqa: E402
    DEFAULT_SERVER,
    ContractError,
    drivers_of,
    load_project,
    source_binding,
    whitelisted_sources,
)

SERVER_NAME = DEFAULT_SERVER
# slot -> the tool that may serve it. Keeping this table closed means a `logs`
# source can never be fetched through `db_query` (and thus never with the wrong
# guard applied).
SLOT_OF_TOOL = {
    "db_query": "database",
    "log_search": "logs",
    "ticket_list": "tickets",
    "efficiency_list": "efficiency",
    "query": None,          # generic: any whitelisted slot
}

_TRACE = os.environ.get("SUPPERH_TRACE") == "1"


def trace(msg: str) -> None:
    """stderr only - stdout/`content[0].text` is reserved for the envelope."""
    if _TRACE:
        sys.stderr.write("[supperH-mcp] " + msg + "\n")
        sys.stderr.flush()


# ---------- adapter loading ----------
def adapter_path(root: Path, code: str) -> Path:
    return root / "drivers" / str(code) / "adapter.py"


def load_adapter(root: Path, code: str):
    """importlib-load drivers/<code>/adapter.py and return its `handle`.

    A missing adapter is reported as unreachable (exit 3) with an explicit
    "fall back to the script channel" instruction: an absent MCP adapter must never
    read as "this data source has no data".
    """
    path = adapter_path(root, code)
    if not path.is_file():
        raise ContractError(
            EXIT_SOURCE_UNREACHABLE,
            f"项目 '{code}' 没有 MCP adapter：{path} 不存在",
            detail="该源改走 script 通道（drivers.<slot>.impl），或按 mcp-skeleton/README.md 写 adapter.py。"
                   "绝不要把缺 adapter 当成查无数据",
        )
    mod_name = f"supperh_adapter_{code}".replace("-", "_")
    spec = importlib.util.spec_from_file_location(mod_name, path)
    if spec is None or spec.loader is None:
        raise ContractError(EXIT_SCHEMA_VIOLATION, f"adapter 无法装载：{path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[mod_name] = module
    try:
        spec.loader.exec_module(module)
    except Exception as e:
        raise ContractError(
            EXIT_SCHEMA_VIOLATION,
            f"adapter 导入期异常：{path}: {e.__class__.__name__}: {e}",
        ) from e
    handle = getattr(module, "handle", None)
    if not callable(handle):
        raise ContractError(
            EXIT_SCHEMA_VIOLATION,
            f"adapter 未实现 handle(source, params, ctx)：{path}",
            detail="契约见 mcp-skeleton/README.md",
        )
    return handle


# ---------- dispatch ----------
def dispatch(project: str, source: str, params: dict | None = None,
             limit: int | None = None, tool: str | None = None) -> dict:
    """The single entry both the MCP tools and the CLI share."""
    params = dict(params or {})
    root, how, problem = resolve_private_root()
    if root is None:
        raise ContractError(EXIT_PROJECT_UNREGISTERED, problem or "私有根未找到",
                            detail=f"定位链：env -> {SERVER_NAME} pointer -> tool-root sibling（本次 how={how}）")
    trace(f"privateRoot={root} via {how} project={project} source={source} tool={tool}")

    cfg, cfg_file = load_project(root, project)
    binding = source_binding(cfg, project, source, SERVER_NAME)

    want_slot = SLOT_OF_TOOL.get(tool) if tool else None
    if want_slot and want_slot != binding.slot:
        raise ContractError(
            EXIT_BAD_ARGS,
            f"工具 {tool} 只能取 drivers.{want_slot} 槽位的源，'{source}' 属于 drivers.{binding.slot}",
            detail="用 query(project, source, params) 走通用兜底，或换对应工具；分派规则是配置，不是模型判断",
        )

    guard = ReadOnlyGuard(binding.forbid_write_schemas)
    ctx = {
        "project": binding.project,
        "slot": binding.slot,
        "config": binding.slot_config,
        "private_root": root,
        "config_file": str(cfg_file),
        "guard": guard,
        "limit": limit,
        "started_at": time.time(),
        "root_how": how,
    }

    handle = load_adapter(root, binding.project)
    try:
        result = handle(source, params, ctx)
    except ContractViolation as e:
        raise ContractError(e.exit_code, e.message) from e
    except SystemExit as e:  # adapters must not exit the server process
        code = int(e.code) if isinstance(e.code, int) else EXIT_SCHEMA_VIOLATION
        raise ContractError(
            code if code in range(0, 6) else EXIT_SCHEMA_VIOLATION,
            f"adapter 调用 sys.exit({e.code})：server 进程内禁止退出，改为 return envelope 或 raise ContractViolation",
        ) from e
    except Exception as e:
        raise ContractError(
            EXIT_SOURCE_UNREACHABLE,
            f"adapter 运行期异常：{e.__class__.__name__}: {e}",
            detail=f"来源 {cfg_file}",
        ) from e

    if isinstance(result, tuple) and len(result) in (2, 3):
        columns, rows = result[0], result[1]
        # 可选第三元 = adapter 想自己申报的 meta 增量（最主要就是 query/params）。
        # 不开这个口子，MCP 通道就永远说不出"我到底跑了什么语句"，而两通道同构
        # 是契约写死的：一边能核、一边不能核，上层就只能选择相信不能核的那边。
        extra = dict(result[2]) if len(result) == 3 and isinstance(result[2], dict) else {}
        q = extra.pop("query", None)
        qp = extra.pop("params", None)
        qo = extra.pop("queryOmitted", None)
        declared = isinstance(q, str) and q.strip() != ""
        # 壳只能诚实报"我看不到"；adapter 自己给了 query 就不能同时留一个"没有语句"的标记，
        # 两者共存在 query_state 里是自相矛盾，所以这里一次性选好，不交给下游去猜。
        result = ok_envelope(columns, rows, source=source, project=binding.project,
                             started_at=ctx["started_at"],
                             query=q if declared else None,
                             params=qp if declared else None,
                             query_omitted=None if declared else (qo or "adapter_opaque"),
                             extra_meta={**extra, **binding.as_meta()})
    # 否则 adapter 直接返整份 envelope：语句字段归它所有，壳不代它填
    # （代填等于把"adapter 忘了报"伪装成"壳看不到"，两者该做的事完全不同）。
    problems = envelope_problems(result)
    if problems:
        raise ContractError(
            EXIT_SCHEMA_VIOLATION,
            "adapter 返回的 envelope 不符合契约：" + "；".join(problems),
            detail="与 script 通道同构是硬要求（base_driver.emit_ok/emit_error 同一形状）",
        )
    result.setdefault("meta", {}).update(binding.as_meta())
    result["meta"]["rootVia"] = how
    return result


# ---------- MCP surface ----------
def build_server():
    """Register the tools. Kept out of module import so --self-test works without `mcp`."""
    from mcp.server.fastmcp import FastMCP  # noqa: PLC0415 - optional dependency

    app = FastMCP(SERVER_NAME)

    def _wrap(tool: str):
        def runner(project: str, source: str, params: dict | None = None, limit: int | None = None):
            try:
                env = dispatch(project, source, params, limit, tool=tool)
            except ContractError as e:
                # The envelope still goes out as text (so it is parseable), and the
                # JSON-RPC code carries who has to fix it.
                env = err_envelope(e.exit_code, e.message, source=source, project=project, detail=e.detail)
                raise _tool_error(e, env)
            except Exception as e:  # never let a tool raise a bare traceback
                env = err_envelope(EXIT_SCHEMA_VIOLATION, f"shell internal error: {e}", source=source, project=project)
                raise _tool_error(ContractError(EXIT_SCHEMA_VIOLATION, str(e)), env)
            return dumps_compact(env)
        runner.__name__ = tool
        return runner

    for name, slot in SLOT_OF_TOOL.items():
        doc = (f"supperH driver tool (slot: {slot})" if slot
               else "generic supperH driver tool: any source in drivers.<slot>.mcp.sources")
        fn = _wrap(name)
        fn.__doc__ = doc
        app.tool(name=name, description=doc)(fn)
    return app


def _tool_error(err: ContractError, env: dict):
    from mcp.shared.exceptions import McpError  # noqa: PLC0415
    from mcp.types import ErrorData  # noqa: PLC0415

    trace(f"tool error exit={err.exit_code} code={mcp_error_code_for(err.exit_code)} {err.message}")
    return McpError(ErrorData(code=mcp_error_code_for(err.exit_code),
                              message=err.message, data=dumps_compact(env)))


# ---------- CLI ----------
def _parse_params(raw: str | None) -> dict:
    if not raw:
        return {}
    p = Path(raw).expanduser()
    if p.is_file():
        raw = p.read_text(encoding="utf-8")
    try:
        obj = json.loads(raw)
    except Exception as e:
        raise ContractError(EXIT_BAD_ARGS, f"--params 不是合法 JSON：{e}")
    if not isinstance(obj, dict):
        raise ContractError(EXIT_BAD_ARGS, "--params 必须是 JSON object")
    return obj


def self_test(project: str | None) -> dict:
    """Diagnostics for the registration-time probe: is this channel usable at all?

    Deliberately does NOT contact any backend - reachability of the real source is
    `healthCheck`'s job (local script, real exit code). This answers only: private
    root found, config readable, which slots are whitelisted, adapter present.
    """
    root, how, problem = resolve_private_root()
    if root is None:
        return err_envelope(EXIT_PROJECT_UNREGISTERED, problem or "私有根未找到",
                            source="self-test", project=project or "-",
                            detail="定位链见 mcp-skeleton/README.md")
    if not project:
        return ok_envelope(["privateRoot", "via"], [[str(root), how]],
                           source="self-test", extra_meta={"server": SERVER_NAME, "rootVia": how},
                           query_omitted="not_applicable")
    cfg, cfg_file = load_project(root, project)
    table = whitelisted_sources(cfg, SERVER_NAME)
    ad = adapter_path(root, project)
    rows = [[slot, ", ".join(srcs)] for slot, srcs in sorted(table.items())]
    if not rows:
        rows = [["(none)", "所有槽位 kind=script 或未声明，本项目不走 MCP"]]
    return ok_envelope(
        ["slot", "sources"], rows, source="self-test", project=project,
        query_omitted="not_applicable",
        extra_meta={
            "server": SERVER_NAME, "rootVia": how, "config": str(cfg_file),
            "adapter": str(ad), "adapterPresent": ad.is_file(),
            "mcpSlots": len(table),
        },
    )


def slot_health(project: str, slot: str) -> dict:
    """One slot's MCP plumbing check - the counterpart of `impl -- --health`.

    It asserts everything that must hold for an MCP call to have a chance (private root
    found, project readable, the slot really points at this shell, whitelist non-empty,
    adapter importable with a callable handle) and it does NOT contact any backend:
    adapters need real params, so invoking one with `{}` would report a *working*
    channel as broken. Backend reachability therefore stays with the script channel's
    healthCheck - the only thing allowed to feed the registration gate (R3.5).
    """
    root, how, problem = resolve_private_root()
    if root is None:
        raise ContractError(EXIT_PROJECT_UNREGISTERED, problem or "私有根未找到",
                            detail=f"定位链：env -> {SERVER_NAME} pointer -> tool-root sibling（本次 how={how}）")
    cfg, cfg_file = load_project(root, project)
    slot_cfg = drivers_of(cfg).get(slot)
    if not isinstance(slot_cfg, dict):
        raise ContractError(EXIT_BAD_ARGS, f"注册文件里没有 drivers.{slot}：{cfg_file}",
                            detail="探测不创建配置；该槽位未配置就连 'kind' 都读不到")
    table = whitelisted_sources(cfg, SERVER_NAME)
    if slot not in table:
        kind = str(slot_cfg.get("kind") or "script")
        declared = slot_cfg.get("mcp") if isinstance(slot_cfg.get("mcp"), dict) else None
        server = str(declared["server"]) if declared and declared.get("server") else "(未声明)"
        raise ContractError(
            EXIT_BAD_ARGS,
            f"drivers.{slot} 不走本壳（kind='{kind}'、mcp.server='{server}'）：探测无意义",
            detail=f"kind 需为 mcp 且 server 需为 {SERVER_NAME}；否则该槽位只可用 script 通道",
        )
    sources = table[slot]
    if not sources:
        raise ContractError(
            EXIT_BAD_ARGS,
            f"drivers.{slot}.mcp.sources 为空：白名单一个源都没列出，该槽位没有任何可取数据",
            detail="空白名单不是「无数据」而是配错了：写 mcp.sources: [<已注册源名>]，或把 kind 改回 script",
        )
    # Re-resolve through the same path a real call takes: a source listed in two slots,
    # or a slot/source disagreement, must fail here rather than mid-session.
    binding = source_binding(cfg, project, sources[0], SERVER_NAME)
    if binding.slot != slot:
        raise ContractError(
            EXIT_BAD_ARGS,
            f"source '{sources[0]}' 在 mcp.sources 里挂于 {slot}，解析却落到 {binding.slot}",
            detail="一个 source 只能属于一个槽位，否则凭据归属不确定",
        )
    handle = load_adapter(root, project)
    tool = next((t for t, s in SLOT_OF_TOOL.items() if s == slot), None)
    rows = [
        ["privateRoot", f"{root} (via {how})"],
        ["config", str(cfg_file)],
        ["kind", str(slot_cfg.get("kind"))],
        ["server", binding.server],
        ["sources", ", ".join(sources)],
        ["tool", tool or "(无专用工具，只能走 query)"],
        ["adapter", str(adapter_path(root, project))],
        ["handle", "callable" if callable(handle) else "NOT callable"],
    ]
    return ok_envelope(["check", "result"], rows, source="health", project=project,
                       query_omitted="not_applicable",
                       extra_meta={"server": SERVER_NAME, "slot": slot, "rootVia": how})


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="supperh-mcp-shell", description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--serve", action="store_true", help="run as an MCP stdio server (default)")
    mode.add_argument("--self-test", action="store_true",
                      help="print shell/registration diagnostics and exit with the driver code")
    mode.add_argument("--query", action="store_true", help="one-shot dispatch (same code path as the tools)")
    mode.add_argument("--health", action="store_true",
                      help="probe one kind=mcp slot's plumbing and exit with the driver code")
    parser.add_argument("--project", help="identity.code under <PRIVATE_ROOT>/projects/")
    parser.add_argument("--slot", help="slot name for --health, e.g. logs")
    parser.add_argument("--source", help="whitelisted source name")
    parser.add_argument("--params", help="JSON object or path to a JSON file")
    parser.add_argument("--limit", type=int)
    parser.add_argument("--tool", choices=sorted(SLOT_OF_TOOL), default="query")
    parser.add_argument("--json", action="store_true", help="pretty-print the envelope (default: compact single line)")
    args = parser.parse_args(argv)
    if args.health:
        label = args.source or "health"
    elif args.self_test:
        label = args.source or "self-test"
    else:
        label = args.source or "query"

    try:
        if args.self_test:
            env = self_test(args.project)
        elif args.health:
            if not args.project or not args.slot:
                raise ContractError(EXIT_BAD_ARGS, "--health 需要 --project 与 --slot：探测不猜项目也不猜槽位")
            env = slot_health(args.project, args.slot)
        elif args.query:
            env = dispatch(args.project, args.source, _parse_params(args.params), args.limit, tool=args.tool)
        else:
            app = build_server()
            app.run(transport="stdio")
            return EXIT_OK
    except ContractError as e:
        env = err_envelope(e.exit_code, e.message, source=label, project=args.project, detail=e.detail)
    except ImportError as e:
        env = err_envelope(EXIT_SOURCE_UNREACHABLE,
                           f"缺少 MCP 运行依赖：{e}", source=label, project=args.project,
                           detail="pip install -r mcp-skeleton/requirements.txt；或确认该源该走 script 通道")
    except Exception as e:  # a silent failure is the outcome we are guarding against
        env = err_envelope(EXIT_SCHEMA_VIOLATION, f"shell 未处理异常：{e.__class__.__name__}: {e}",
                           source=label, project=args.project)

    text = json.dumps(env, ensure_ascii=False, indent=2) if args.json else dumps_compact(env)
    sys.stdout.write(text + "\n")
    sys.stdout.flush()
    code = env.get("error", {}).get("code") if not env.get("ok") else EXIT_OK
    if env.get("ok") or code not in range(0, 6):
        return EXIT_OK if env.get("ok") else EXIT_SCHEMA_VIOLATION
    return int(code)


if __name__ == "__main__":
    sys.exit(main())
