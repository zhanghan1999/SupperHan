# mcp-skeleton — MCP 通道的外壳与契约包

L1 层资产。这里放**与项目无关**的东西：一个 MCP 壳 server、一份共享契约包。
公司专有的取数实现（浏览器 cookie、LevelDB token、VPN 客户端探测、内网端点）**不放这里**，
放私有根 `<PRIVATE_ROOT>/drivers/<code>/adapter.py`（L2，见红线 R1 第 4 条）。

## 为什么只有一个 server

`node scripts/sync-assets.mjs`（仓库根目录执行）产出的 `.mcp.json` 里只有**一条**注册项：

```json
{
  "mcpServers": {
    "supperh-drivers": {
      "command": "python",
      "args": ["mcp-skeleton/shell.py"],
      "cwd": ".",
      "env_vars": ["SUPPERH_PRIVATE_ROOT", "SUPPERH_TOOL_ROOT", "SUPPERH_TRACE"]
    }
  }
}
```

- 全部是**插件相对**路径，零凭据、零项目值（sync 的 `--check` 形态会断言这点）。
- 项目专有 adapter 由壳在运行期 `importlib` 装载，**查找**而非**注册**。
- 所以"新增一个项目要不要再注册一个 server"这件事不存在 → 注册漂移结构性消失。
- `command` 的解释器由 sync 按平台烤定（win=`python`，其它=`python3`）。**venv 不在这里指定**：
  那会把绝对路径写进注册表。当前所有项目共用该解释器；某项目确实需要隔离 venv 时，
  在该解释器里装齐依赖，或另注册独立 server 条目并启用漂移校验（默认不启用）。

## 私有根定位链（与 `scripts/resolve-private-root.mjs` 同语义）

1. `SUPPERH_PRIVATE_ROOT` 环境变量（`init-project.mjs` 探测 driver 时就是这个注入形态）
2. `mcp-skeleton/private-root.txt` —— sync（`node scripts/sync-assets.mjs`）烤入的**指针文件**。
   必需，因为安装后的插件在 `~/.qoder-cn/plugins/cache/local/...` 下，同级缺省会解析到无意义目录。
3. `SUPPERH_TOOL_ROOT`（或本文件祖先目录）的同级 `../supper-Han-private`

定位方式会写进 envelope 的 `meta.rootVia`。**没找到就报错，绝不猜**：猜中另一个私有根
= 用别的项目的凭据查数据。

## 通道与门禁（红线 R3.5）

| | script 通道 | mcp 通道 |
|---|---|---|
| 调用 | `bash` 跑 `drivers.<slot>.impl` | `tools/call` |
| 失败信号 | 退出码 0–5 | JSON-RPC `error.code` |
| 能否做分流 | **能** | **不能** |

MCP server 起不来时，工具是从列表里**静默消失**的（没有错误码、没有 stderr），
让模型判断"这次算不算没数据"正是 R3.5 要防的"错被吞 + 静默跳过"。因此：

- `healthCheck` 恒为本地脚本，即使 `kind: mcp` —— 连通判定不交给 MCP；
- 连通判据只有一个：各槽位自己的 `healthCheck` 退出码，且它必须**真说协议**（DB 连一次 /
  HTTP 拿到任何状态码）。不存在“跑其它 driver 前先统一预检”的槽位（原 `vpnPreCheck`，已删）：
  零信任网关对 VPN 网段的任意端口都代答 accept，预检能测的都不是证据（实测见
  `docs/architecture.md` §10.8）；壳的 `--health` 也同理——它只查管路，不声称服务可达；
- MCP 取数工具**只绑子 agent**，主 agent / 命令入口一律不绑（R3.5 窄 bash 白名单已规定
  "跑 driver 必须派子 agent"，绑主 agent 等于开一条绕过它的直道）。

## 退出码 ↔ JSON-RPC 错误码

| driver exit | 含义 | MCP error.code | 谁该修 |
|---|---|---|---|
| 0 | 成功 | — | — |
| 1 | 项目未注册 / 私有根未找到 | `-32602` | 调用方的 project / 注册状态 |
| 2 | 参数非法（含 source 不在白名单） | `-32602` | 调用方 |
| 3 | 数据源不可达 / 没有 adapter | `-32000` | 环境（含"该走 script"） |
| 4 | 认证过期 | `-32000` | 环境（重新握手） |
| 5 | envelope 违反契约 | `-32603` | adapter 作者 |

envelope 同时放进 `content[0].text`（单行紧凑 JSON，与 script 通道 stdout 同形），
所以一次失败调用既能被协议层看到，也能被解析层看到。

## L2 adapter 契约

`<PRIVATE_ROOT>/drivers/<code>/adapter.py`：

```python
from supperh_contract import ok_envelope, ReadOnlyGuard   # 守卫 import，不复制

def handle(source: str, params: dict, ctx: dict) -> dict:
    """ctx: project / slot / config / private_root / guard / limit / started_at

    返回 envelope（用 ok_envelope / err_envelope），或 (columns, rows[, meta 增量])
    由壳包装。禁止 sys.exit()：那会杀掉 server 进程。写保护用 ctx['guard']。
    """
    guard = ctx["guard"]          # ReadOnlyGuard: DB_GATE_DENY + forbidWriteSchemas
    sql = build_sql(source, params)
    guard.check(sql, target_schema=ctx["config"].get("schema", ""))
    columns, rows = fetch(sql)
    # 第三个元是给 adapter 自己申报语句用的：只有它知道真跑了什么，壳只能诚实
    # 说 `adapter_opaque`。不给这个口子，MCP 通道就永远交不出可核对的结果。
    return columns, rows, {"query": sql, "params": bound_values}
    # 或者整份自己拼：ok_envelope(columns, rows, source=source,
    #                            project=ctx["project"], query=sql, params=bound_values)
```

- `meta.query` / `meta.params` / `meta.queryOmitted` 三态规则见
  `skills/driver-contract/SKILL.md` §字段规约；本仓库的示例 fixture adapter 会申报
  语句，因为 `tests/mcp-manifest.test.mjs` 拿两条通道的 meta 键集做对称比对，
  一边报一边不报会在那里失败，而不是悄悄分叉。

- **不实现**：任意 URL 的 `http_fetch`、无守卫的自由文本 `sql` 参数、把 `*.local.json`
  路径当参数暴露给模型。
- 凭据只进 server 进程（adapter 自己读 `<PRIVATE_ROOT>/credentials/*.local.json`），
  禁写进 `.mcp.json` 字面量（R1 第 4 条）。

## 白名单配置（L2 `projects/<code>.yaml`）

```yaml
drivers:
  database:
    impl: "{{DRIVERS_ROOT}}/demo/db-query.py"      # script 通道，仍保留
    healthCheck: "{{DRIVERS_ROOT}}/demo/db-query.py --health"
    kind: mcp                                      # 取数走 MCP
    fallback: script                                # server 不可用时由注册期探测决定
    mcp:
      server: supperh-drivers                       # 必须与 .mcp.json 的 id 一致
      sources: [sys_menu, demo_order]                # 闭合白名单：未列出 = 拒绝(exit 2)
      healthTool: db_health                          # 可选，仅诊断用
```

校验规则（`node scripts/validate-project.mjs`）：`kind: mcp` 必须带 `mcp.server` + 非空 `mcp.sources`；
`kind: script` 不得挂 `mcp` 段；`fallback: none` 只警告不阻断。

## 自检 / 一次性查询（不依赖 `mcp` 包）

```bash
python mcp-skeleton/shell.py --self-test                       # 私有根定位到了吗
python mcp-skeleton/shell.py --self-test --project <code>      # 哪些槽位/源走 MCP、adapter 在不在
python mcp-skeleton/shell.py --query --project <code> --source <name> --params '{}' --json
```

CLI 的**进程退出码就是 driver 退出码**——这正是 `init-project.mjs` 的 `probeDrivers()`
能给 MCP 通道做探测的原因：判定仍然来自本地退出码，模型不参与，分流语义不变。

## 已知不一致（登记，未修）

- 每项目独立 venv 未实现（见上"为什么只有一个 server"）。
