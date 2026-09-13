#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
supperH driver skeleton - example_json_driver.py

A runnable, no-network driver that reads a local JSON file as its
"database". Its only job is to prove the supperH-driver-contract works
end-to-end without depending on any internal backend.

CLI (see skills/supperH-driver-contract/SKILL.md):
  python example_json_driver.py \
      --project <code> --source demo \
      [--filter k=v]... [--limit N] [--timeout S]

Exit codes:
  0 ok | 1 project unregistered | 2 bad args
  3 source unreachable (file missing) | 4 auth expired (never triggered)
  5 output schema violation
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

# base_driver.py sits next to this file (both under drivers-skeleton/ or
# both under PRIVATE_ROOT/drivers/ after the user copies them out).
sys.path.insert(0, str(Path(__file__).resolve().parent))

from base_driver import (  # noqa: E402
    BaseDriver,
    EXIT_BAD_ARGS,
    EXIT_SOURCE_UNREACHABLE,
    emit_error,
    emit_ok,
)


class ExampleJsonDriver(BaseDriver):
    name = "example_json_driver"
    version = "0.1.0"

    def run(self, args, project_cfg, filters, params_json):
        # 1) Locate example_data.json next to this file.
        data_file = Path(__file__).resolve().parent / "example_data.json"
        if not data_file.is_file():
            emit_error(EXIT_SOURCE_UNREACHABLE,
                       "example_data.json missing next to driver",
                       source=args.source)

        # 2) Load dataset.
        try:
            payload = json.loads(data_file.read_text(encoding="utf-8"))
        except Exception as e:
            emit_error(EXIT_SOURCE_UNREACHABLE,
                       "example_data.json unreadable: " + str(e),
                       source=args.source)

        # 3) Pick the requested source; "demo" is the default dataset key.
        datasets = payload.get("datasets") or {}
        key = args.source or "demo"
        if key not in datasets:
            available = ",".join(sorted(datasets.keys()))
            emit_error(EXIT_BAD_ARGS,
                       "unknown source '" + key + "'; available: " + available,
                       source=key)
        table = datasets[key]
        columns = table.get("columns") or []
        rows = table.get("rows") or []

        # 4) Row-index lookup for filters (case-sensitive on column name).
        col_idx = {c: i for i, c in enumerate(columns)}
        for k, v in (filters or {}).items():
            if k not in col_idx:
                emit_error(EXIT_BAD_ARGS,
                           "filter key '" + k + "' not in columns",
                           source=key)
        # Apply AND semantics across filters.
        if filters:
            filtered = []
            for r in rows:
                ok = True
                for k, v in filters.items():
                    cell = r[col_idx[k]]
                    # Loose equality: stringify cell before compare.
                    if str(cell) != str(v):
                        ok = False
                        break
                if ok:
                    filtered.append(r)
            rows = filtered

        # 5) Truncate.
        total_before_truncate = len(rows)
        limit = args.limit
        truncated = False
        if limit is not None and limit >= 0 and total_before_truncate > limit:
            rows = rows[:limit]
            truncated = True

        # 6) Emit.
        #    `query` here is a pseudo-SQL of what really narrowed the rows: the dataset
        #    key, the filters actually applied (insertion order = order applied), and the
        #    cap. Values stay in `params` behind `?` placeholders, mirroring how a real
        #    SQL driver must report itself. A driver that has no statement to show would
        #    have to pass query_omitted instead - see base_driver.emit_ok.
        keys = list((filters or {}).keys())
        statement = "select * from " + str(key)
        if keys:
            statement += " where " + " AND ".join(k + " = ?" for k in keys)
        if limit is not None and limit >= 0:
            statement += " limit " + str(limit)
        emit_ok(
            columns=columns,
            rows=rows,
            source=key,
            truncated=truncated,
            query=statement,
            params={k: filters[k] for k in keys} if keys else None,
            extra_meta={
                "totalMatches": total_before_truncate,
                "datasetFile": str(data_file),
            },
            driver_version=self.version,
        )


if __name__ == "__main__":
    ExampleJsonDriver().main()
