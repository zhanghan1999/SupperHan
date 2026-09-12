r"""
Read the L2 registry and resolve a `source` to its MCP binding.

Boundary note (deliberate): this module never expands <DRIVERS_ROOT> /
<PRIVATE_ROOT> tokens inside `drivers.<slot>.impl` or `healthCheck`. Path expansion
has exactly one implementation - `scripts/resolve-project.mjs:expandDrivers()` - and
a Python copy would be the drift this whole stage exists to remove. Those two fields
belong to the *script* channel; if an adapter ever needs them it must shell out to
`node scripts/resolve-project.mjs --project <code> --json`, not re-parse them.

What it does read: identity.code, drivers.<slot>.kind / .mcp.{server,sources,
healthTool}, db.forbidWriteSchemas - none of which is a path.

Why this docstring is a raw string (and why L1 *.py sources must carry no
double-brace tokens at all): `node scripts/sync-assets.mjs` bakes those tokens into the artefact, so
a baked Windows path inside a literal turns into an escape sequence - the backslash
before U is a hard SyntaxError. sync --check blocks that shape rather than shipping it.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from .codes import EXIT_BAD_ARGS, EXIT_PROJECT_UNREGISTERED

DEFAULT_SERVER = "supperh-drivers"


class ContractError(Exception):
    """Carries the driver exit code the script channel would have used, so the
    shell can project it onto a JSON-RPC error code instead of inventing one."""

    def __init__(self, exit_code: int, message: str, detail: str | None = None):
        super().__init__(message)
        self.exit_code = int(exit_code)
        self.message = message
        self.detail = detail


def _load_yaml(text: str, where: str) -> dict:
    try:
        import yaml  # PyYAML, see mcp-skeleton/requirements.txt
    except ImportError as e:  # pragma: no cover - environment dependent
        raise ContractError(
            EXIT_PROJECT_UNREGISTERED,
            "PyYAML 未安装，壳无法读取注册文件：" + where,
            detail="在壳使用的解释器里执行 `pip install -r mcp-skeleton/requirements.txt`（缺依赖必须显式失败，不能退回弱解析）",
        ) from e
    try:
        data = yaml.safe_load(text)
    except Exception as e:
        raise ContractError(EXIT_PROJECT_UNREGISTERED, f"注册文件解析失败：{where}: {e}") from e
    if not isinstance(data, dict):
        raise ContractError(EXIT_PROJECT_UNREGISTERED, f"注册文件不是 mapping：{where}")
    return data


def load_project(root: Path, code: str) -> tuple[dict, Path]:
    """-> (config, file). Mirrors the resolver's routing rules:
    projects/<code>.yaml preferred, legacy single project.yaml only when its
    identity.code agrees, and a code/file disagreement is fatal (it would let one
    project's credentials answer another project's query)."""
    code = str(code or "").strip()
    if not code:
        raise ContractError(EXIT_BAD_ARGS, "project <code> 必填：注册按 projects/<code>.yaml 路由")
    reg = root / "projects"
    chosen: Path | None = None
    for name in (code + ".yaml", code + ".yml"):
        cand = reg / name
        if cand.is_file():
            chosen = cand
            break
    if chosen is None:
        legacy = root / "project.yaml"
        if not legacy.is_file():
            raise ContractError(
                EXIT_PROJECT_UNREGISTERED,
                f"未注册项目 '{code}'：{root} 下既无 projects/{code}.yaml 也无 project.yaml",
                detail="在该工作区跑 /supperH-init",
            )
        data = _load_yaml(legacy.read_text(encoding="utf-8"), str(legacy))
        got = str(((data.get("identity") or {}) or {}).get("code", "")).strip()
        if got != code:
            raise ContractError(
                EXIT_PROJECT_UNREGISTERED,
                f"项目码不匹配：请求 '{code}'，legacy project.yaml 登记的是 '{got}'",
            )
        return data, legacy

    text = chosen.read_text(encoding="utf-8")
    data = _load_yaml(text, str(chosen))
    got = str(((data.get("identity") or {}) or {}).get("code", "")).strip()
    if got and got != code:
        raise ContractError(
            EXIT_PROJECT_UNREGISTERED,
            f"注册文件与身份不符：{chosen.name} 内 identity.code='{got}'",
            detail="文件名与 identity.code 必须一致（由 /supperH-init 与 scripts/migrate-registry.mjs 保证）",
        )
    return data, chosen


@dataclass
class Binding:
    slot: str
    source: str
    server: str
    project: str
    health_tool: str | None = None
    slot_config: dict = field(default_factory=dict)
    forbid_write_schemas: list = field(default_factory=list)
    role: str | None = None

    def as_meta(self) -> dict:
        out = {"source": self.source, "project": self.project, "slot": self.slot, "server": self.server}
        # 只在有值时递出：缺席 = “这个源不是数据库通道”，与 L2 里 role 的缺省语义同构。
        if self.role:
            out["role"] = self.role
        return out


def drivers_of(cfg: dict) -> dict:
    d = cfg.get("drivers")
    return d if isinstance(d, dict) else {}


# 唯一被 L1 赋予机器语义的 role：关系库通道（写保护只绑它）。“有几个数据源、各自叫什么”
# 归用户（F-11），所以 L1 不得靠槽位名判语义——旧版 SLOT_OF_TOOL 就是把“logs”“tickets”
# 当成了契约，用户不登记这两个名字时它直接失效。
DB_ROLE = "database"


def slot_role(slot: str, sc) -> str | None:
    """Machine-semantic role of one slot, legacy name synonym included.

    存量兼容：槽位恰好叫 `database` 时按同义处理（F-10 前的写法），但 validate 会报出来——
    “靠键名猜语义”正是 F-11 要收掉的那类隐性约定。
    """
    if not isinstance(sc, dict):
        return None
    r = sc.get("role")
    if isinstance(r, str) and r.strip():
        return r.strip()
    return DB_ROLE if slot == DB_ROLE else None


def db_slot(cfg: dict) -> tuple[str, dict] | None:
    """The (slot, cfg) pair carrying `role: database`, or None when the project has no SQL channel."""
    hits = [(s, c) for s, c in sorted(drivers_of(cfg).items()) if slot_role(s, c) == DB_ROLE]
    return hits[0] if hits else None


def whitelisted_sources(cfg: dict, server: str = DEFAULT_SERVER) -> dict[str, list[str]]:
    """slot -> declared sources, for slots routed through MCP on `server`."""
    out: dict[str, list[str]] = {}
    for slot, sc in drivers_of(cfg).items():
        if not isinstance(sc, dict) or str(sc.get("kind") or "script") != "mcp":
            continue
        mcp = sc.get("mcp")
        if not isinstance(mcp, dict):
            continue
        if str(mcp.get("server") or DEFAULT_SERVER) != server:
            continue
        srcs = mcp.get("sources")
        if isinstance(srcs, list):
            out[str(slot)] = [str(s) for s in srcs]
    return out


def source_binding(cfg: dict, code: str, source: str, server: str = DEFAULT_SERVER) -> Binding:
    """Resolve `source` against the closed whitelist. An unlisted source is rejected
    (exit 2 semantics) rather than guessed at - guessing is how a wrong-credential
    query returns someone else's rows."""
    source = str(source or "").strip()
    if not source:
        raise ContractError(EXIT_BAD_ARGS, "source 必填：它决定走哪个槽位与哪套凭据")

    table = whitelisted_sources(cfg, server)
    hits = [slot for slot, srcs in table.items() if source in srcs]
    if not hits:
        listed = "; ".join(f"{s} -> {sorted(v)}" for s, v in sorted(table.items())) or "（该项目没有任何 kind=mcp 槽位）"
        raise ContractError(
            EXIT_BAD_ARGS,
            f"source '{source}' 不在项目 '{code}' 的 mcp.sources 白名单内",
            detail=f"当前 MCP 可达白名单：{listed}。未列出的源请走 script 通道（drivers.<slot>.impl），"
                   f"不要用 MCP 猜——猜中的那次会比猜错的更难发现",
        )
    if len(hits) > 1:
        raise ContractError(
            EXIT_BAD_ARGS,
            f"source '{source}' 同时出现在多个槽位的 mcp.sources 里：{sorted(hits)}",
            detail="一个 source 只能属于一个槽位，否则凭据归属不确定",
        )

    slot = hits[0]
    sc = drivers_of(cfg).get(slot) or {}
    mcp = sc.get("mcp") or {}
    db = cfg.get("db") or {}
    forbid = db.get("forbidWriteSchemas") if isinstance(db, dict) else None
    return Binding(
        slot=slot,
        source=source,
        server=str(mcp.get("server") or DEFAULT_SERVER),
        project=str(code),
        health_tool=(str(mcp["healthTool"]) if mcp.get("healthTool") else None),
        slot_config=(sc.get("config") if isinstance(sc.get("config"), dict) else {}),
        forbid_write_schemas=[str(x) for x in (forbid or [])],
        role=slot_role(slot, sc),
    )


def expects_server(cfg: dict, code: str, server: str = DEFAULT_SERVER) -> str | None:
    """Human-readable note for --self-test: does this project route anything here?"""
    table = whitelisted_sources(cfg, server)
    if not table:
        return f"项目 '{code}' 没有任何 kind=mcp 槽位（全部走 script 通道）"
    return None
