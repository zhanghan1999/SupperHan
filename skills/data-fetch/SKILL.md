---
name: data-fetch
description: supperH 统一数据获取协议 skill。定义"从注册数据源取结构化数据 → 过滤 → 归一化输出"的四段流水线，被所有需要读 DB / 日志 / 工单 / 效能数据的 agent 与命令共同引用。
---

# skill: data-fetch

## 前置自检（硬性）

未替换的双花括号占位符 → 立即停 + 报告“这类残留 = L1 产物未经 sync（仓库级问题，与项目配置无关）” + 引导用户在工具仓库跑 `node "{{TOOL_ROOT}}/scripts/sync-assets.mjs"` 后重启 IDE + 不降级。**不指向 `/supperH-bootstrap`** —— 它只建私有根骨架，修不了产物陈旧。

## 目标

给所有需要"从外部世界拿数据"的场景（SQL 查询、日志检索、工单拉取、研发指标）提供**同一份调用协议**，让 agent 侧不用关心具体内网实现。

## 数据源注册表

数据源**不由本仓库定义**；由 `{{PRIVATE_ROOT}}/projects/<code>.yaml` 的 `drivers` 段声明。本 skill 只规定**槽位名称**与**每槽位的调用契约**。

| 槽位 | 注册条目路径 | 用途 | 一期是否强制 |
|------|------------------|------|-------------|
| database | `{{PROJECT.drivers.database}}` | SQL 类只读/可写查询 | **是**（DB 门禁依赖） |
| logs | `{{PROJECT.drivers.logs}}` | 日志检索（例：某段时间某 trace_id 的全部日志） | 否 |
| tickets | `{{PROJECT.drivers.tickets}}` | 工单/需求/缺陷平台拉取 | 否 |
| efficiency | `{{PROJECT.drivers.efficiency}}` | 研发效能指标（构建耗时、覆盖率、流水线状态） | 否 |

每个槽位的值是 `{impl, healthCheck, config?, kind?, fallback?, mcp?}`；`impl` 指向可执行脚本（Python/Shell/Node 皆可），`healthCheck` 是**协议级**探活命令（真连一次后端，不是 ping/端口探测），`kind` 决定取数走哪条通道（缺省 `script`）。通道的完整形状与 exit code ↔ JSON-RPC error code 对照见 `skills/driver-contract/SKILL.md` §调用通道。

## 四段流水线

```
[resolve] → [guard] → [invoke] → [normalize]
   定位 impl+通道   SELECT-only/写门禁   跑脚本/调工具   输出 JSON schema 校验
```

### 1. resolve（定位 impl 与通道）

- 输入：`source` = 槽位名（`database` / `logs` / ...） + 可选 `source.name`（同一槽位下多数据源，如 database.test / database.prod）
- 输出：绝对路径的 impl 脚本 + **`channel`**（`script` | `mcp`）。channel 直接取解析器返回体里 `drivers.<槽位名>.kind` 的值（缺省 `script`）—— **不在产物里写死、不拼占位符**（通道是注册期探测结论，属 L2 运行期数据）
- `channel` 是注册期已定的结论：**不得在本段重新探测、不得因为"看起来 MCP 工具不在列表里"自己改判**（kind 由 `/supperH-init --write` 的机械探测写死，见 `driver-contract` §调用通道）
- 未注册 → 抛 `SOURCE_NOT_REGISTERED`；**禁止降级到"随便找个能跑的先顶着"**

### 2. guard（守卫，硬性）

- **DB 门禁**：`source` 落在 `database` 且 SQL 里的目标 schema 命中 `{{PROJECT.db.forbidWriteSchemas[]}}` 且 SQL 是写语句（INSERT/UPDATE/DELETE/DROP/ALTER/TRUNCATE/CREATE/GRANT/REVOKE） → 抛 `DB_GATE_DENY`；不弹确认、不改写 SQL、不换 schema。
- **清单缺失 = 拒绝，不是放行**：拿不到禁写清单（项目未接入数据库，L2 无 `db` 段或清单为空）时，写语句一律不得发出，报 `DB_GATE_NO_SCHEMA_LIST`；只读语句也没地方可发（无 `drivers.database` 通道），该源记为不可用。把“列表为空”当成“无限制”是本契约里最贵的一种错（`supperh_contract/guards.py` 的 `select_only_guard` 对空清单就是一条都不拦，所以客户端必须自己兜住）。
- **SELECT-only 判定**：SQL 里出现写关键字（不区分大小写、忽略注释和字符串常量）→ 视为写；其它视为读。
- **无执行前预检**：不在“跑 driver 之前”做任何网络/VPN 状态判断，也不得再引入预检槽位（原 `vpnPreCheck` 已删）。原因：零信任网关对 VPN 网段的**任意端口**都本地代答 accept，而内网主机常滤掉 ICMP —— 所以 ping / 网卡名 / 裸 TCP connect 三类“预检”都会在全断的情况下报绿灯（实测数：假端口 connect 均 0.02s 内“OPEN”，对它们发 HTTP 则 `RemoteDisconnected`；真端口 `401` 用 0.28s）。证据只来自本次调用自返的退出码。
- **连不上怎么办（exit 3 / 4）**：停止该源取数，把**目标端点 + 错误原文**交给用户，要求提供可连接环境（“请在能访问 `<host>:<port>` 的网络里重试” / “请重新登录刷新凭据”）。你**不猜 VPN 是否已连、不自动重试、不换网络再跑**，更不得把“拿不到数据”写成“没有数据”。

### 3. invoke（调用协议）

本段有两个分支，由 resolve 输出的 `channel` 机械选定。**两分支返回同一份 envelope、同一套 exit code 语义**（否则上层的降级逻辑得写两份）：

#### 分支 A：`channel = script`（缺省）

```
<impl> --project <code> --source <name> [--filter k=v ...] [--limit N] [--timeout S] [--params <json-file>]
```

#### 分支 B：`channel = mcp`

子 agent（已绑 `supperh-drivers`）直接调 MCP 工具，不再拼命令行：

| 槽位 | 工具 | 参数 |
|---|---|---|
| database | `db_query` | `project` / `source` / `params` / `limit` |
| logs | `log_search` | 同上 |
| tickets | `ticket_list` | 同上 |
| efficiency | `efficiency_list` | 同上 |
| 任意已白名单源 | `query` | 同上（通用兜底）|

- `source` **必须**在该槽位 L2 配置的 `mcp.sources` 白名单里（解析器返回体里的 `drivers.<槽位名>.mcp.sources`）；不在则壳直接拒（exit 2 语义），**不要改个名字重试**
- 工具返回的 `content[0].text` 就是 envelope 本体，照常走第 4 段；失败时 envelope 与 JSON-RPC error code 同时存在
- 工具调用**没有退出码**：因此本分支的结果只能用于取数，**不得拿去做任何分流判断**（红线 R3.5）
- 通道不可用（server 没起 / adapter 缺失）时壳会显式报错；按 `fallback` 处理：`script` → 告知用户回 `/supperH-init` 重跑探测（kind 会被回写成 script）；`none` → 直接停下报告，**绝不默默换成另一种数据源**

两分支共用的参数语义（CLI 写 `--x`，MCP 用同名入参）：

- `<impl>`：resolve 得到的绝对路径 —— 仅 script 分支；mcp 分支由壳按项目码去 `<PRIVATE_ROOT>/drivers/<code>/adapter.py` 查找
- `project` = `{{PROJECT.identity.code}}`；**两条通道都必须显式携带**，driver 侧据此选自己的连接配置
- `source`：数据源逻辑名（例：`test` / `uat` / `prod` / `app-logs` / `trace-logs`）；具体含义由 driver 自己解释，但**必须**能从注册条目的对应 config 里查到（mcp 分支还额外要求在 `mcp.sources` 白名单内）
- `filter`：script 分支用 `--filter k=v`（可重复）；mcp 分支放进 `params` 对象里，语义相同
- `limit`：可选，返回行数上限；缺省 = driver 内置默认（推荐 1000）
- `timeout`：仅 script 分支（`--timeout`，秒；缺省 30）；MCP 侧超时由 server/IDE 决定，不要指望它
- `params`：复杂入参 —— script 分支指向一个 JSON 文件（避免命令行转义地狱），mcp 分支直接传 object

**禁止**在命令行明文传凭据（密码 / token）；凭据只允许在 driver / server 进程内从环境变量 / `~/.xxx/` 私有配置文件读取。sync 阶段的敏感字检测会拦下把凭据写进 L1 文件（含 `.mcp.json`）的行为。

### 4. normalize（输出契约）

driver（script 分支：stdout；mcp 分支：`content[0].text`）**必须**输出一段 JSON，符合 `{{TOOL_ROOT}}/schemas/driver-response.schema.json`：

```json
{
  "ok": true,
  "meta": {
    "source": "<name>",
    "count": 0,
    "truncated": false,
    "syncTs": "2024-01-01T00:00:00Z",
    "took_ms": 12,
    "query": "select id, status from t_order where status = ? and created_at >= ? limit 100",
    "params": ["open", "2024-01-01T00:00:00Z"]
  },
  "data": {
    "columns": ["col1", "col2"],
    "rows": [["v1", "v2"], ...]
  }
}
```

失败输出：

```json
{
  "ok": false,
  "error": {"code": 3, "message": "..."},
  "meta": {"source": "..."}
}
```

Exit code 语义（**协议契约，不可改**；mcp 分支用同一套语义，只换了载体 —— 对照表唯一定义在 `driver-contract` §调用通道与 `mcp-skeleton/supperh_contract/codes.py`，本处不复写以免漂移）：

| code | 含义 | 调用方处理 |
|------|------|-----------|
| 0 | 成功 | 解析 stdout JSON |
| 1 | 项目未注册 | 停止；提示回 `/supperH-init` 注册本工作区（私有根未建时才先 `/supperH-bootstrap`）|
| 2 | 参数缺失/非法 | 停止；打印 stderr |
| 3 | 数据源不可达 | 记录 `UNREACHABLE`；按调用方策略决定阻断/降级 |
| 4 | 认证过期 | 停止；提示"请重新登录内网 / 更新 token" |
| 5 | 输出不符合 schema | **硬性阻断**；打印 stdout 前 500 字节供排查 |

### 语句可核对（硬性）

`meta.query` + `meta.params` 是"这份结果能不能被复核"的唯一凭据。只有答案没有语句，审阅者分不清"对的结论"和"碰对的结论"——而把 bug 送进数据源查一遍的全部意义就是前者。三种状态必须可机械区分：

| 状态 | 信封长相 | 调用方动作 |
|---|---|---|
| 已申报 | `meta.query` 非空，绑定值在 `meta.params`（占位符保留） | 把语句与结果**一起**贴给用户 |
| 合法省略 | 无 `query`，但 `meta.queryOmitted` ∈ `adapter_opaque` / `redacted` / `not_applicable` | 按原因说一句话；`redacted` 必须说清脱敏了什么 |
| 未报（缺陷） | 两个键都不存在 | 记 `query_missing`，且它**必须**出现在最终汇报里 |

- `query` 是**真正执行过的那一条**：占位符不替换成值（值进 `params`），事后凭记忆拼一条不算。
- 这三个键在 schema 里是**可选**的（`meta.required` 只有 `source`）。不是疏忽：把 `query` 写成必填会让已注册项目的存量驱动一夜全红。强制手段是下面第 5 条的上报义务，不是契约文件。
- 汇报形态上不允许"我查过库了，答案是 X"这种只给结论的形式；SQL 与结果是一条消息里的两样东西。
- 结论要能被数据分布**反证**：`count`、命中范围、`truncated` 都要报出来，使"这两个值不相等"这类断言能用同一份数据回头校验——比较前做过类型/精度转换的，转换必须写在语句里或说明里，不能只在脑子里。

## 环境归属（硬性）

每一行取回的数据都属于某个具体环境。“反正都是同一个项目”不成立：代码侧的新鲜度基线是 `HEAD`（你这份检出），数据侧的诊断基线是某个环境（`branches.<env>` + `db.schemas.<env>`），两者同时成立而互不蕴含。细节与接线见 `{{TOOL_ROOT}}/docs/architecture.md` §10.9。

- **环境由解析器声明**：调用方跑 `node {{TOOL_ROOT}}/scripts/resolve-project.mjs --cwd ... --env <name>`，拿返回体里的 `diagnoseBaseline = {env, branch, schema}`。环境名合法与否由脚本判（未知/空白 → exit 36），**不由取数方自行对名**。
- **`source` 必须与声明的环境对得上**：拿不准 `source: uat2` 是不是 `env: uat` 对应的库 → 先把 `diagnoseBaseline.schema` 与 driver 自己报的连接信息对一次；对不上就停下问用户，不得“先查了再说”。
- **没声明环境就不取业务数据**：`diagnoseBaseline` 缺位时只允许取与环境无关的东西（schema 元数据、菜单定义这类）。把缺省默默当成“开发库”或“测试库”是本项目最容易出的一类错：拿 dev 的数据证 prod 的结论。
- **跨环境的值不可互相佐证**：“uat 与 prod 不一致”是合法结论，但两条证据必须各自带 `env`；拿一个环境的行去解释另一个环境的行为，等于拿别人的现场证自己的结论。
- **汇报形态**：来自 DB / 日志的每条结论都要写成 `【env=<env> · source=<name>】<meta.query> → <结果>`，与 `meta.query` 同一条消息里交给用户。丢了 `env` 的语句同样可复核，但只对“同一个环境”的人可复核。

## 与 agent 的接口

调用方（agent 或 command）按 resolve 得到的 `channel` 取数：`script` 走 `bash` 工具跑 `<impl>`，`mcp` 由已绑壳的子 agent 调工具；两者拿到的都是同一份 envelope，此后：

1. 用 `driver-response.schema.json` 校验；不通过 → 视为 exit 5
2. 若 `ok=false` → 按 exit code 走对应降级
3. `ok=true` → 消费 `data.rows`；`meta.truncated=true` 时调用方**必须**在最终汇报里带上"结果被截断，实际行数 ≥ limit"的提示
4. 多源/多项目聚合时按信封里的 `meta.project` 认领结果归属（两条通道都回填），**不得从当前工作目录推断** —— 猜错项目等于把别的项目的数据写进本项目的结论
5. 判定语句申报状态（三态规则唯一定义在 `{{TOOL_ROOT}}/mcp-skeleton/supperh_contract/envelope.py:query_state`，本处不复写以免漂移）：拿到 `missing` 时记 `query_missing`，并在最终汇报里**单列一条**"本次取数未能提供执行语句：驱动既没给 `meta.query`，也没声明 `meta.queryOmitted`"。不得静默吞掉，不得改写成"没有数据"，也不得因为"数据看起来是对的"就免掉这一条——免掉的正是它要防的那种错

## anchor-lookup（快路径 F1.4：traceId / ticketNo → route）

`/supperH-bug` 抽到的锚点不含代码位置时，由 `bug-analyzer(mode=lookup)` 经本协议反查接口路由。这是一个**只读、单结果**的特化调用：

| 锚点类型 | 槽位 | 调用形式 |
|---|---|---|
| `traceId` | `drivers.logs` | `<impl.logs> --project <code> --source trace-logs --filter trace_id=<id> --limit 1` |
| `ticketNo` | `drivers.tickets` | `<impl.tickets> --project <code> --source tickets --filter ticket_no=<no> --limit 1` |

约定：

- driver **必须**在返回的 `data.columns` 里提供一列 `route`（值形如 `POST /api/x/y`）；缺失该列 → 视为反查失败（`code: TARGET_NOT_FOUND`），**不得**用其它列凑。
- 反查以“能锁到唯一接口路由”为目的：命中 0 行或多行且 route 不唯一 → 调用方按歧义处理（升格完整路径），**绝不在多条里任选其一**。
- **只读**：logs/tickets 本质是检索类数据源，不得发起任何写操作；若 driver 回报 `meta` 显示发生了写 → 调用方视为协议违约并升格。
- 本反查不替代也不绕过 DB 门禁；它与步骤 1.5 的快路径准入相互独立——反查出的 route 仍要过 G0–G4 + 否决表。

## 多源聚合（可选）

同一逻辑查询需要从多个 source 合并时（例：test 库 + uat 库比对差异），由 agent 侧发起两次 fetch 再在内存里 join，**不**在 driver 里做跨源聚合。理由：

- 保持 driver 单一职责，方便替换
- 跨源鉴权/超时策略不同，聚合语义太复杂
- 出现部分失败时容易定位

## 边界（红线）

- 禁止跳过 guard 段直接 invoke（DB 门禁必须在客户端也做一次，不完全信任 driver）
- 禁止拿 MCP 工具的结果做分流（无退出码）；也禁止主 agent 直接绑取数工具 —— `supperh-drivers` 只出现在子 agent frontmatter 里
- 禁止把 `--filter` 值拼到 shell 命令里再传给 driver（必须走 argv 数组，防注入）
- 禁止在 agent 侧硬编码任何真实内网域名 / 账号 / 库名；一律走 `PROJECT.<字段>` 类占位符与 driver 内部配置
- 禁止"driver 失败 → 换另一个 driver 重试"式横向降级；一个 source 只能对应一个 impl
- 禁止把 driver 的 stdout 内容原样 dump 到 git 追踪的文件里（防止真实业务数据被误提交；如需落地走 `{{PRIVATE_ROOT}}/context/` 或 `{{PRIVATE_ROOT}}/logs/`）
- 禁止"只报答案不报语句"：`query_missing` 可以出现在汇报里，不可以被省略；也禁止把没有语句的取数结果当作已验证事实写进结论

## 参考实现

见 `{{TOOL_ROOT}}/drivers-skeleton/`：

- `base_driver.py`：SELECT-only 守卫 + JSON 输出 + Decimal/datetime 序列化的共享工具
- `example_json_driver.py`：可跑的最小示例（读 JSON 文件当数据源，证明协议可落地）
- `example_data.json`：示例数据集

用户开发自己的内网 driver 时从 `base_driver.py` 派生即可，落到 `{{DRIVERS_ROOT}}/` 下并在注册条目的 `drivers.*.impl` 里登记。
