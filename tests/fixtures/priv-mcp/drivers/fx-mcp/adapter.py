#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Fixture adapter for tests/fixtures/priv-mcp/projects/fx-mcp.yaml.

Stands in for the company-specific adapter that lives in the private root (never in
this repo). Two jobs in one file:

  * make the positive branch of `shell.py --health` reachable by an automated test
    (adapter present + `handle` callable);
  * make `shell.py --query` return real rows so envelope shape can be asserted
    without touching any backend, and make the reproducibility pair (`meta.query`,
    `meta.params`) present on the MCP side too, so the two-channel symmetry check has
    something to compare instead of skipping the field.
"""

COLUMNS = ["id", "message"]
ROWS = [[1, "fixture row one"], [2, "fixture row two"]]


def handle(source, params, ctx):
    """(columns, rows, meta) - the third slot is how an adapter declares its own state.

    Only the adapter knows what it ran, so without that opening the MCP channel could
    never say more than "adapter_opaque" while the script channel handed out real statements -
    and tests/mcp-manifest.test.mjs compares the contract-declared meta keys of both
    channels, so an asymmetric fixture would fail there instead of silently diverging.
    """
    limit = ctx.get("limit")
    rows = ROWS[:limit] if isinstance(limit, int) and limit > 0 else ROWS
    bound = params if isinstance(params, dict) else {}
    statement = "select " + ", ".join(COLUMNS) + " from " + str(source)
    if bound:
        statement += " where " + " AND ".join(k + " = ?" for k in bound)
    if isinstance(limit, int) and limit > 0:
        statement += " limit " + str(limit)
    meta = {"query": statement}
    # 没有绑定值就不写 params：空对象和"无参数"是两种说法，而两通道同构比对的是
    # 键的存在性（脚本侧无 filter 时根本不带这个键），多一个空键就会判成分叉。
    if bound:
        meta["params"] = dict(bound)
    return COLUMNS, rows, meta
