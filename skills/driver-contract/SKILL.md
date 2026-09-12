---
name: driver-contract
description: supperH 驱动契约 skill。定义内网数据源驱动的标准接口：CLI 参数、JSON envelope、exit code、SELECT-only 守卫、凭据装载规范、协议级探活判据，以及两种调用通道（script / mcp）的同构关系与探测降级纪律。槽位名与个数归用户（L1 不列清单）。用户自开发内网实现时以本 skill 为唯一符合性判据。
---

# skill: driver-contract

## 前置自检（硬性）

未替换的双花括号占位符 → 立即停 + 报告“这类残留 = L1 产物未经 sync（仓库级问题，与项目配置无关）” + 引导用户在工具仓库跑 `node "{{TOOL_ROOT}}/scripts/sync-assets.mjs"` 后重启 IDE + 不降级。**不指向 `/supperH-bootstrap`** —— 它只建私有根骨架，修不了产物陈旧。

## 目标

让"数据获取"这件事在本工具里具备**可替换性**：

- 本仓库不发布任何真实内网 driver 实现
- 用户在 `{{PRIVATE_ROOT}}/drivers/` 下自己写（Python / Shell / Node 皆可）
- agent 侧只依赖本 skill 定义的契约；换 driver 不用改 agent

## 三个层次的契约

| 层次 | 文件 | 谁遵守 |
|------|------|-------|
| **调用契约**（CLI + env）| 本 skill 的 §调用 | agent 侧 + driver 侧 |
| **响应契约**（JSON envelope）| `{{TOOL_ROOT}}/schemas/driver-response.schema.json` | driver 输出 + agent 消费 |
| **失败契约**（exit code 语义）| 本 skill 的 §exit-code | driver 侧 |

## 目录约定

```
{{DRIVERS_ROOT}}/                       # = {{PRIVATE_ROOT}}/drivers/
  ├── <slot>.py                         # 一个源一个文件；**槽位名由用户定**，个数不限
  ├── <另一个-slot>.py                   # 哪个是数据库通道由注册条目里的 `role: database` 标出，不靠文件名
  ├── .secrets/                         # 私有配置（不进 git，不进任何 dist）
  │   ├── db.local.json
  │   └── token.local.env
  ├── <code>/adapter.py                 # 可选：MCP 通道的项目 adapter（kind=mcp 时由壳 importlib 装载）
  └── <driver-name>.d/                  # 可选：driver 依赖的本地资源（例：schema dump 缓存）
```

登记入口是 `/supperH-driver`（写盘经 `scripts/driver-registry.mjs`）：它把实现文件写进上表第一个位置，并在 `projects/<code>.yaml` 的 `drivers.<槽位名>` 下记一条 `{desc, impl, healthCheck, role?, writes?, kind?, config?}`。本仓库不持有哪些槽位名可以存在——名字是 L2 事实。

**参考实现（骨架，非内网可用）**：

```
{{TOOL_ROOT}}/drivers-skeleton/
  ├── base_driver.py                    # 共享工具：resolve / emit_ok / emit_error / SELECT_only_guard / JSON 序列化
  ├── example_json_driver.py            # 可跑的最小示例（读 JSON 文件当数据源）
  ├── example_data.json                 # 示例数据
  └── README.md                         # "派生你自己的 driver"三步走说明
```

`drivers-skeleton/` 会被 sync 阶段拷贝到 `dist/`；用户可以直接从这里 `cp` 出去到 `{{DRIVERS_ROOT}}/` 起步。

**MCP 通道参考实现（壳 server + 共享契约包）**：

```
{{TOOL_ROOT}}/mcp-skeleton/
  ├── shell.py                 # 单条注册项 supperh-drivers：插件相对路径、零凭据
  ├── supperh_contract/        # codes / envelope / guards / private_root / registry（adapter 一律 import，不复制守卫）
  ├── requirements.txt
  └── README.md                # 写 adapter.py（公司专有，放私有根 drivers/<code>/adapter.py）的契约
```

## 调用契约

### CLI

```
<impl> --project <code> --source <name>
       [--filter k=v]...
       [--limit N]
       [--timeout S]
       [--params <json-file>]
       [--dry-run]
```

- 参数**必须**走 argv 数组，不允许 shell 字符串拼接
- `--project` = `{{PROJECT.identity.code}}`；driver 侧用它索引到自己的 config
- `--source` 语义由 driver 自解释，但对同一槽位的多 source（例：数据库通道槽位下的 test/uat/prod）**必须**在注册条目的 `drivers.<slot>.config.sources` 里显式声明
- `--filter` 可重复；`--limit` / `--timeout` 单值
- `--params` 指向 JSON 文件；文件路径必须在 `{{PRIVATE_ROOT}}` 或用户 home 之下，driver 侧校验（防被指到 `/etc/passwd`）
- `--dry-run` 可选支持；不支持时忽略而非报错

### 菜单查询保留源 `menu`

菜单学习（`/supperH-learn --menu`）复用**数据库通道**（`role: database` 那个槽位；名字归用户，不写死），但固定以**保留源名 `menu`** 调用（即 `--source menu`）。调用方通过 `--filter` 传入表名与列名，driver 负责**安全拼装 SELECT**：

```
<db-impl> --project <code> --source menu \
  --filter table=<表名> \
  --filter id=<列> --filter parentId=<列> --filter name=<列> --filter path=<列> \
  [--filter where=<SELECT-only WHERE 片段>] \
  --limit <N>
```

- driver **必须**对 `table` / 列名做标识符引用（防注入），**只**拼 `SELECT`；`--filter where` 若提供，须经 `SELECT_only_guard` 复核（禁写关键字）
- `--limit` 必须生效，`meta.truncated` 如实回填
- 返回**标准 envelope**（`data.columns` 至少含 `id/parentId/name/path`，可选 `order`；`data.rows` 与之对齐）
- `menu` 源**必须**在数据库通道（`role: database` 那个槽位）的 `config.sources` 里显式声明（同其它 source）
- 凭据仍**只**走 env / `{{DRIVERS_ROOT}}/.secrets/`（见下"环境变量"节）

### 环境变量（凭据装载）

driver **只**允许从以下途径拿凭据：

1. `os.environ['<SOME>_PASSWORD']` 类环境变量（前缀由 driver 自定义，例 `MYAPP_DB_PWD`）
2. `{{DRIVERS_ROOT}}/.secrets/*.local.json` / `*.local.env` 私有配置文件
3. OS keychain（若可用）

**禁止**：

- ❌ 从命令行 argv 收密码
- ❌ 从注册条目（`projects/<code>.yaml`）收密码（它会被 sync 读取，密码会流到 dist）
- ❌ 从 L1 仓库的任何文件收密码（L1 里连密码格式的字面字符串都会被 sync 阶段的敏感字扫描拦下）
- ❌ 把已解析的凭据打印到 stdout / stderr / 日志

### 日志与 trace

- stdout **只**用于最终 JSON envelope；任何调试信息一律走 stderr
- driver 应支持 `SUPPERH_TRACE=1` 环境变量 → 打开时把详细步骤打到 stderr
- 抛异常时 stderr 打完整 traceback；stdout 只输出 envelope（envelope 里 `ok=false, error.code=5`）

## 响应契约

严格符合 `{{TOOL_ROOT}}/schemas/driver-response.schema.json`：

```json
{
  "ok": true,
  "meta": {
    "source": "test",
    "count": 100,
    "truncated": false,
    "syncTs": "2024-06-01T12:00:00Z",
    "took_ms": 145,
    "driverVersion": "1.0.0",
    "query": "select id, name from t_user where role = ? limit ?",
    "params": ["admin", 100]
  },
  "data": {
    "columns": ["id", "name"],
    "rows": [[1, "foo"], [2, "bar"]]
  }
}
```

失败 envelope：

```json
{
  "ok": false,
  "error": {"code": 3, "message": "connection refused", "detail": "..."},
  "meta": {"source": "test", "syncTs": "..."}
}
```

字段规约：

- `meta.count` 是**实际返回**行数；`truncated=true` 表示"命中 limit 被截"
- `meta.project` 两条通道都回填本次解析到的 `identity.code`（`base_driver` 在 argv 解析完就赋值，连报错信封也带）。上层做多项目汇总时靠它认领结果，**不得从 cwd 猜**；只有烂到还没认出 code 的参数错误（exit 1/2）可以缺失 —— schema 里它是可选字段，就是为了不把"没认出的项目"误报成"没找到项目"
- `meta` 允许驱动自带附加键（`datasetFile` / `totalMatches` / `rootVia` / `slot` ……，schema 里 `additionalProperties: true`）：消费方必须**忽略未知键**而不是报错，否则每加一个驱动都要改一次契约
- `meta.syncTs` 由 driver 现取（不用与外部 sync 时间对齐）
- `meta.driverVersion` 可选，鼓励填
- **语句申报（`query` / `params` / `queryOmitted`）是成功信封的必做项**，三态必须可机械区分：
  | 态 | 怎么写 | 用在哪 |
  |---|---|---|
  | 已申报 | `emit_ok(query="...", params=...)`（占位符保留，绑定值单独给） | 任何真取数 |
  | 合法省略 | `emit_ok(query_omitted="adapter_opaque\|redacted\|not_applicable")` 三选一 | 取数在 adapter 内部完成 / 语句含凭据已脱敏 / 本就没有语句（探活、列目录） |
  | 两个都不写 | ❌ 不是第三种合法选择 | —— |

  “没报”与“本就没有”必须分得开：一个 SQL 驱动与一个健康探测驱动同样不填 `query`，消费方就分不清“驱动忘了报”（缺陷，要上报 `query_missing`）与“确实没有”（事实）。枚举而不是自由文本，是为了让“没报”这一格可机械发现（同义词会漂）。
- `query` 与 `queryOmitted` **互斥**；`params` 只能跟着 `query` 出现（没展示语句却给一堆绑定值 = 第二个无人解释的事实源）。两套实现（`base_driver.emit_ok` / `envelope.ok_envelope`）都在写入时一次性定死，不给下游去猜
- 这三个键在 schema 里是**可选**字段而不是 `required`：写死必填会让存量驱动全部 exit 5，而“加字段不得让已注册项目突然全灭”是本契约的兼容铁律。约束落在 `skills/data-fetch` 的上报义务上，不落在文件形状上
- `data.columns` 顺序与 `data.rows[i]` 严格对齐
- 空结果 → `rows: []` 而非 `rows: null`；`columns` 允许空数组
- 数值类型：`Decimal` → `float`；`datetime` → ISO 8601 字符串；`bytes` → base64 字符串。`base_driver.py` 提供 `_json_default` helper 自动处理
- `null` 保留为 JSON `null`；不要转成空字符串

## Exit code 语义（协议契约，不可改）

| code | 常量名（base_driver.py）| 触发场景 | 调用方处理 |
|------|-----------------------|---------|-----------|
| 0 | `EXIT_OK` | 成功；stdout 有合法 envelope | 解析 stdout JSON |
| 1 | `EXIT_PROJECT_UNREGISTERED` | `--project` 值不在 driver 认识的清单里 | 停止；提示回 `/supperH-init` 注册本工作区（只有连私有根目录都还没建时才先跑 `/supperH-bootstrap`）|
| 2 | `EXIT_BAD_ARGS` | 缺参、参数格式非法、`--params` 文件不可读 | 停止；打印 stderr |
| 3 | `EXIT_SOURCE_UNREACHABLE` | 网络不通 / DB down / API 500 / 超时 | 硬性阻断该源；把**端点 + 错误原文**交给用户要求可连接环境。不猜 VPN 状态、不自动重试、不把“拿不到”报成“没有” |
| 4 | `EXIT_AUTH_EXPIRED` | 401 / 403 / token 过期 | 停止；提示"重新登录内网 / 更新 token"。**服务在场只缺凭据 = 4，不是 3**（两类修法完全不同，混在一起用户会去查网络而问题在登录态）|
| 5 | `EXIT_SCHEMA_VIOLATION` | 输出不符合 `driver-response.schema.json`；未处理异常兜底 | 硬性阻断；打印 stdout 前 500 字节 + stderr 完整 |

**约定**：driver 内部 `try/except` 兜底所有未处理异常 → `emit_error(5, str(e))` + traceback 到 stderr。绝不允许"异常了直接 crash"，因为 crash 的 exit code 可能是任意值，会破坏调用方判定。

## 调用通道（script / mcp）

同一个 driver 契约有两种调用形状。**通道不改变契约**：envelope、exit code 语义、SELECT-only 守卫、`--project` 必带 —— 两条通道完全同构。

| | script（缺省）| mcp |
|---|---|---|
| 调用形状 | `<impl> --project <code> --source <name> ...` | 子 agent 调 MCP 工具：`db_query`（只能取 `role: database` 的槽位）/ `query`（任意已白名单源）|
| 结果载体 | stdout JSON + **进程退出码 0–5** | `content[0].text` 里同一份 envelope；失败另带 JSON-RPC error code |
| 谁起进程 | 子 agent 的 bash | IDE 按注册表起（插件相对路径，永不含凭据）|
| 能否做分流依据 | ✅ 唯一可以 | ❌ 禁止（server 起不来时工具静默消失，无码无 stderr）|
| 连通性判定（`healthCheck`） | ✅ 唯一判据，且必须协议级 | ❌ 壳的 `--health` 只查管路（私有根/白名单/adapter 可装载），不声称服务可达 |

配置面在 L2 `projects/<code>.yaml`（L1 只写形状，不写值）：

```yaml
drivers:
  <你起的槽位名>:          # 槽位名由用户在登记时自定，本文不举例名字
    kind: mcp            # 缺省 script；只换取数通道
    fallback: script     # 缺省 script；none = 明确不许降级（探测会 blocked，不悄悄翻写）
    mcp:
      server: supperh-drivers    # 必须与插件 .mcp.json 的 server id 一致
      sources: [app_logs]        # 闭合白名单：未列出的 source 被拒（exit 2 语义）而不是被猜
    impl: "{{DRIVERS_ROOT}}/<你起的槽位名>.py"   # 即使 kind=mcp 也必填：门禁与 fallback 都靠它
    healthCheck: "{{DRIVERS_ROOT}}/<你起的槽位名>.py --project {{PROJECT.identity.code}} --health"
```

exit code ↔ JSON-RPC error code 对照（表本体在 `mcp-skeleton/supperh_contract/codes.py`，与 `base_driver.py` 同一张表，`tests/mcp-manifest.test.mjs` 机械比对锁死）：

| driver exit | 含义（见上表）| MCP `error.code` | 会话侧动作 |
|---|---|---|---|
| 0 | OK | — | 解析 envelope |
| 1 | 项目未注册 | `-32602` Invalid params | 停止 → `/supperH-init`（私有根未建时才先 `/supperH-bootstrap`）|
| 2 | 参数非法 / 源不在白名单 | `-32602` | 停止；打印 detail，**不要自行补参重试** |
| 3 | 源不可达 | `-32000` Server error | 记 UNREACHABLE；按策略降级 |
| 4 | 凭据过期 | `-32000` | 停止；提示重新登录内网 |
| 5 | envelope 违规 / 未处理异常 | `-32603` Internal error | 硬性阻断 |

**探测与降级纪律**（机械判定，不给模型判断）：

1. 登记期（`/supperH-init --write` 或 `/supperH-driver` 的 add/update，两者共用同一个 `decideChannels`）对每个 `kind: mcp` 槽位跑一次 `python "{{TOOL_ROOT}}/mcp-skeleton/shell.py" --health --project <code> --slot <slot>`，退出码即结论。
2. 该探测只查**管路**（私有根 / 注册文件 / 白名单 / adapter 可装载），**不碰后端**：管路完好 ≠ 数据连得上，连通性门禁仍只认脚本 `healthCheck` 的退出码。
3. 探测不过 + `fallback` 非 `none` → **回写 `kind: script`** 再落盘；后续会话只读已定的 `kind`，不在会话内重探（重探 = 每会话多一个 30s 超时面）。
4. 探测不过 + `fallback: none` → 不翻写，只报 `blocked`（那是运维的显式决定，探测无权覆盖）。
5. 壳 server 或 adapter 缺失 **绝不能**被读成"这个源没有数据"——那正是本方案要消除的那类静默错误。

**按项目绑定**：注册表只有一条（壳），加项目不改注册表也不改 IDE 配置；壳在运行期从 `<PRIVATE_ROOT>/drivers/<code>/adapter.py` 查找并 `importlib` 装载。官方 server（非本壳）只是配置选型差异：换的只有 `command`/`args`，通道分类依旧两条。

## 探活判据（`healthCheck` 必须写成什么）

连通性只有一个合法判据：**驱动自己按协议真连一次目标**。`base_driver.http_health()` /
`http_health_code()` 已给 HTTP 类实现；DB 类用配置里的账号做一次真连接（连上即关，不查数据）。

因此**不存在“执行前预检”槽位**（原 `drivers.vpnPreCheck` 已删）：取数前不做任何网络/VPN 状态
判断，连通性结论只来自本次调用自返的退出码 —— 能提前测准的东西不存在，能测准的手段（带凭据
连一次）必然带业务语义，那正是各槽位 `healthCheck` 已经在做的事（完整退场理由与实测数据：
`{{TOOL_ROOT}}/docs/architecture.md` §10.8）。

三类“看起来能提前判断 VPN 通不通”的写法一律禁止，均在本机对零信任隧道网关实测证伪：

| 判据 | 实测行为 | 为什么不是证据 |
|---|---|---|
| 网卡/VPN 客户端名（枚举适配器匹配 VPN 关键字） | 冷启动 **1.80–2.42s** | 全局状态：适配器 Up ≠ 目标可达；走不需 VPN 的直连内网时反向假阻断 |
| ICMP ping | 内网地址常不回包（用户实测） | 滤掉 ICMP 是常态；回了也不代表服务在 |
| 裸 TCP connect | 同一台内网主机的 **port 1 / 59999 / 65500 全在 0.00–0.02s 报“OPEN”** | 网关替目标完成握手再丢弃后续字节 → “端口开放”恒为真，VPN 断了也报绿灯 |
| **协议级探测**（本表唯一合法项） | 真端口：HTTP `401` 用 **0.28s**、TLS 握手用 **0.21s**；假端口：`RemoteDisconnected` 用 **0.09–0.24s** | — |

三条硬约束：

- **预算**：单端点 ≤**8s**、一次探活总预算 ≤20s、多端点并行，**绝不卡死**。预算不能压小：同一个 HTTPS 端点实测冷启动首次 TLS 握手经零信任隧道 >3s（3s 预算被误判成不可达 = 假阻断），预热后 0.2s 就返回 200 —— 所以下限按冷启动定，不按热连接定。另注意 `ThreadPoolExecutor` 的
  atexit 会 join 工作线程，一个挂在黑洞 IP 上的 connect 会把进程留到超时之后——探活类 CLI
  自己算完就收尾，必要时刷完 stdout 直接 `os._exit(code)`，不要把预算之外的等待留给上层
- **状态码不是失败**：HTTP 任何状态行都算“服务在场”；401/403 → **exit 4**（缺凭据），
  拒连/超时 → **exit 3**（不可达）。两者混成一个“连不上”，用户就会去查网络而问题其实在登录态
- **失败要说清对象**：detail 里带 `host:port` 与错误原文 —— 上层靠它向用户索取可连接环境，不靠猜

## 守卫契约（SELECT-only）

`base_driver.py` 的 `SELECT_only_guard(sql_text, target_schema, forbid_writes)`：

- 扫 SQL 里的写关键字：`INSERT` / `UPDATE` / `DELETE` / `DROP` / `ALTER` / `TRUNCATE` / `CREATE` / `GRANT` / `REVOKE` / `MERGE` / `REPLACE` / `CALL` / `EXEC` / `EXECUTE`
- 忽略策略：剥离 `--` 单行注释、`/* */` 块注释、字符串常量（单双引号）、`$$ ... $$` 常量
- 命中写关键字 **且** `target_schema` 命中 `{{PROJECT.db.forbidWriteSchemas[]}}` → 抛 `DB_GATE_DENY`，exit 2
- 命中写关键字 **且** 目标 schema 允许写 → 放行；driver 需要自行使用 `writableUser` 连接
- 只有读关键字 → 一律放行；使用 `readonlyUser` 连接
- **`forbid_writes` 为空时的真实行为**：一条都不拦（实现事实，不是设计意图）。所以清单必须来自已接入的 `db` 段 —— 未接入数据库时根本不该存在带 `role: database` 的槽位；“清单缺失 = 拒绝”由 agent 侧客户端守卫兜住（见 `skills/data-fetch/SKILL.md` guard 段），不得拿本守卫的空清单当“无限制”用。
- **非库动作的写门禁也在 driver 侧跑一次**：槽位登记的 `writes[]`（`action` + `gate: confirm|deny`）是唯一授权来源。收到未声明的动作、或声明为 `deny` 的动作 → 退 2 并在 `error` 里点名原因（`WRITE_NOT_DECLARED:` / `WRITE_GATE_DENY:` 前缀，与 `DB_GATE_DENY:` 同一形态的消息标记，不是新退出码）。为何不信调用方已拦：driver 的入参可以不经过 agent 客户端（人手敲、别的工具调、测试跑），只装在客户端的门禁不是一道边界。**一期契约只标准化读路径**：写动作的**请求形态**由 driver 自定（怎么触发要写进 `desc` / `config`，让调用方看得到），但**门禁形态**是统一的（未声明 → 拒、`deny` → 拒、`confirm` → 先把完整载荷给用户看）。

**双重防御**：这一守卫在 agent 客户端也跑一次，不完全信任 driver。即使 driver 忘了实现守卫，agent 侧也会拦下。

## 幂等与重试

- **读操作**（SELECT / GET 类）默认幂等，可在 agent 侧配置重试
- **写操作**（INSERT / UPDATE 类）**必须**幂等（例：带 `WHERE id=? AND version=?` 或 upsert 语义）；否则 agent 侧不会重试，直接失败
- driver **不主动重试**；重试策略由 agent 侧统一决定，避免"N 层重试相乘"
- 超时：`--timeout` 秒数到达时 driver **必须**在 1s 内 exit（3 或 5，看具体原因）；不能 hung

## 版本兼容

- 契约版本号是 `meta.schemaVersion`（schema 在 `meta.properties` 里声明，当前 `1`）
- driver 输出 envelope 时若 `meta.schemaVersion` 缺省 → 视为 `1`
- 未来若加字段采用**向后兼容新增**；若破坏性变更 → `meta.schemaVersion` +1 且 sync 阶段做兼容检查
- **禁止**driver 输出未在 schema 里声明的**顶层**字段（顶层 `additionalProperties: false`）

## 编写新 driver 三步走

1. `cp {{TOOL_ROOT}}/drivers-skeleton/example_json_driver.py {{DRIVERS_ROOT}}/my_driver.py`
2. 在文件顶部 `from base_driver import BaseDriver` → 继承基类，重写 `fetch(params)` 方法
3. 在注册条目的 `drivers.<slot>.impl` 里登记绝对路径；跑 `node "{{TOOL_ROOT}}/scripts/sync-assets.mjs"` → sync 阶段会调 driver 的 `--help` 探活（不真跑数据查询）；exit 0 表示契约合规

跑一次真实查询自检：

```
python {{DRIVERS_ROOT}}/my_driver.py --project {{PROJECT.identity.code}} --source <name> --limit 1
```

期望：exit 0 + stdout 一段合法 envelope，且 `meta` 里语句申报状态已定（`query` 或 `queryOmitted` 至少一个）——两者都缺 = 该驱动不合规，即使 exit 0（它的结果无法被任何人复核）。

## 边界（红线）

- 禁止把 `{{DRIVERS_ROOT}}/` 加入任何 git 仓库（用户自己管理）
- 禁止 L1 仓库里出现任何具体内网产品名（本 skill 通篇用槽位名，不用产品名，就是为了让 L1 里连"某个数据库叫什么"都不出现）
- 禁止 driver 输出 escape sequence（ANSI 色码等）到 stdout；stdout 只放 JSON
- 禁止 driver 之间互相调用（保持每个 driver 单一职责）
- 禁止把值拼回语句里再报一遍（`query` 留占位符，值只进 `params`）：拼回去的那一条已经不是执行过的语句，而“看起来能复现”的伪造语句比没有语句更难查
- 禁止 `.secrets/` 目录被 sync 拷到 `dist/`（sync 白名单不包含该目录）
