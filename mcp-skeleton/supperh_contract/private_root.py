"""
Private-root lookup for the MCP side, mirroring scripts/resolve-private-root.mjs.

Chain (first hit wins), and it is deliberately the SAME two-level chain the Node
resolver uses - no third discovery level was invented for MCP:

  1. SUPPERH_PRIVATE_ROOT            (explicit override; also what init-project.mjs
                                      injects when it probes a driver)
  2. mcp-skeleton/private-root.txt   (baked by `node scripts/sync-assets.mjs`, run from
                                      the L1 source repo — not from the installed plugin
                                      directory, which carries no scripts/ or
                                      package.json; the pointer is needed because the
                                      installed plugin lives under
                                      ~/.qoder-cn/plugins/cache/local/..., where the
                                      sibling default would resolve to nonsense)
  3. <SUPPERH_TOOL_ROOT>/../supper-Han-private   (source checkout / sibling default)

A miss is reported, never guessed at: silently picking a wrong root would point the
shell at another project's credentials.
"""

from __future__ import annotations

import os
from pathlib import Path

DEFAULT_DIR_NAME = "supper-Han-private"
POINTER_NAME = "private-root.txt"


def _pointer_candidates() -> list[Path]:
    here = Path(__file__).resolve()
    # supperh_contract/private_root.py -> supperh_contract -> mcp-skeleton
    out = []
    for base in here.parents:
        cand = base / POINTER_NAME
        if cand.is_file():
            out.append(cand)
        if (base / "mcp-skeleton").is_dir():
            out.append(base / "mcp-skeleton" / POINTER_NAME)
    return out


def _read_pointer() -> tuple[Path | None, str | None]:
    """Return (root, source_path). A pointer that exists but is not usable is an
    error to surface, not a reason to fall through to the next candidate."""
    for cand in _pointer_candidates():
        try:
            if not cand.is_file():
                continue
            text = cand.read_text(encoding="utf-8").strip()
        except OSError:
            continue
        if not text:
            return None, f"{cand} 为空：回 L1 仓库跑 `node scripts/sync-assets.mjs` 重新烤入私有根"
        p = Path(text).expanduser()
        if p.is_dir():
            return p, str(cand)
        return None, f"{cand} 指向的目录不存在：{text}（私有根被移动？回 L1 仓库跑 `node scripts/sync-assets.mjs`）"
    return None, None


def resolve_private_root() -> tuple[Path | None, str, str | None]:
    """-> (privateRoot|None, how, problem|None)

    `how` is one of "env", "private-root.txt", "tool-root-sibling", "unresolved"
    and is echoed in every envelope, so a mislocated root is visible from the
    agent side instead of showing up as an unexplained "project not registered".
    """
    env = os.environ.get("SUPPERH_PRIVATE_ROOT")
    if env:
        p = Path(env).expanduser()
        if p.is_dir():
            return p, "env", None
        return None, "env", f"SUPPERH_PRIVATE_ROOT 指向的目录不存在：{env}"

    ptr, ptr_problem = _read_pointer()
    if ptr is not None:
        return ptr, "private-root.txt", None
    if ptr_problem:
        return None, "private-root.txt", ptr_problem

    tool_root = os.environ.get("SUPPERH_TOOL_ROOT")
    bases = [Path(tool_root).expanduser()] if tool_root else list(Path(__file__).resolve().parents)
    for base in bases:
        for cand_dir in (base, *base.parents):
            sib = cand_dir.parent / DEFAULT_DIR_NAME
            if sib.is_dir():
                return sib.resolve(), "tool-root-sibling", None
            direct = cand_dir / DEFAULT_DIR_NAME
            if direct.is_dir():
                return direct.resolve(), "tool-root-sibling", None
    return None, "unresolved", (
        "私有根未找到：设 SUPPERH_PRIVATE_ROOT，或在 L1 仓库（源 checkout）跑 "
        "`node scripts/sync-assets.mjs` 重新烤入 mcp-skeleton/" + POINTER_NAME +
        "（插件目录里没有这个脚本，安装态只能靠指针文件），或先跑 /supperH-bootstrap"
    )


def private_root_problems() -> list[str]:
    """Convenience for --self-test: empty list means the shell can route config."""
    root, _how, problem = resolve_private_root()
    if root is None:
        return [problem or "private root unresolved"]
    if not (root / "projects").is_dir() and not (root / "project.yaml").is_file():
        return [f"私有根存在但没有任何注册文件（缺 projects/ 与 project.yaml）：{root}。run /supperH-init"]
    return []
