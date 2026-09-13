---
name: data-fetch
description: supperH 统一数据获取协议 skill。定义"从注册数据源取结构化数据 → 过滤 → 归一化输出"的四段流水线，被所有需要从注册源取数的 agent 与命令共同引用（数据库只是其中一种源）。
---

# skill: data-fetch

## 前置自检（硬性）

未替换的双花括号占位符 → 立即停 + 报告“这类残留 = L1 产物未经 sync（仓库级问题，与项目配置无关）” + 引导用户在工具仓库跑 `node "{{TOOL_ROOT}}/scripts/sync-assets.mjs"` 后重启 IDE + 不降级。**不指向 `/supperH-bootstrap`** —— 它只建私有根骨架，修不了产物陈旧。

## 目标

给所有需要"从外部世界拿数据"的场景提供**同一份调用协议**——不管是发 SQL、按 traceId 检索日志、拉外部平台的记录，还是用户自己登记的其它检索类源（叫什么、有几个都不固定）。一句话能成立是因为这四个动作的形状完全一样：定住一个源 → 查一道语句 → 拿回行集。agent 侧因此不用关心具体内网实现。

## 数据源注册表

数据源**不由本仓库定义**：有几个、叫什么、干什么用，全部由 `{{PRIVATE_ROOT}}/projects/<code>.yaml` 的 `drivers` 段决定（槽位名归用户，经 `/supperH-driver` 登记）。本 skill 只规定**槽位的形状**与**每槽位的调用契约**，不列也不假设槽位名清单。

L1 里唯一被赋予机器语义的是 `role: database`（全项目最多一个）：它是写保护绑定的那个通道。其余槽位对 L1 就是“某个用户命名的源”——判它是什么要读它的 `desc`，不是猜名字。

| 要找什么 | 怎么定位（不看名字） | 是否强制 |
|---|---|---|
| 数据库通道（能发 SQL 的那个） | 解析器输出里的 `dbDriver` 别名（按 `role: database` 解出来；未接入时为 `null`） | 否（纯代码模式可以一个源都没有）；但**有 `db` 段却没这个通道 = 写保护没有可绑的出口**，一律拒写 |
| 其它任意源 | `drivers.<槽位名>`，槽位名从解析器返回的 `drivers` 键集合里取，用途看各槽位的 `desc` | 否 |

每个槽位的值是 `{desc, impl, healthCheck, config?, role?, writes?, kind?, fallback?, mcp?}`；`impl` 指向可执行脚本（Python/Shell/Node 皆可），`healthCheck` 是**协议级**探活命令（真连一次后端，不是 ping/端口探测），`kind` 决定取数走哪条通道（缺省 `script`）。通道的完整形状与 exit code ↔ JSON-RPC error code 对照见 `skills/driver-contract/SKILL.md` §调用通道。

## 四段流水线

```
[resolve] → [guard] → [invoke] → [normalize]
   定位 impl+通道   SELECT-only/写门禁   跑脚本/调工具   输出 JSON schema 校验
```

### 1. resolve（定位 impl 与通道）

- 输入：`source` = 槽位名（从注册表 `drivers` 的**实际键集合**里来，不是从本 skill 的清单里来） + 可选 `source.name`（同一槽位下多数据源，如 `<库槽位>.test / <库槽位>.prod`）
- 输出：绝对路径的 impl 脚本 + **`channel`**（`script` | `mcp`）。channel 直接取解析器返回体里 `drivers.<槽位名>.kind` 的值（缺省 `script`）—— **不在产物里写死、不拼占位符**（通道是注册期探测结论，属 L2 运行期数据）
- `channel` 是登记期已定的结论：**不得在本段重新探测、不得因为"看起来 MCP 工具不在列表里"自己改判**（kind 由登记期的机械探测写死——`/supperH-init --write` 或 `/supperH-driver` 的 add/update，两者共用同一个 `decideChannels`，见 `driver-contract` §调用通道）
- 未注册 → 抛 `SOURCE_NOT_REGISTERED`；**禁止降级到"随便找个能跑的先顶着"**

### 2. guard（守卫，硬性）

- **DB 门禁 = 只读判定，不看库名**：本次取数落在**数据库通道**（`dbDriver` 指向的槽位）时，只允许发出能被证明只读的 SQL。命中写关键词或副作用形态（完整清单见 `driver-contract` §守卫契约）→ 抛 `DB_GATE_DENY`；不弹确认、不改写 SQL、不换 schema、不重试。**判据与“它写到哪个库”无关** —— 旧写法先比 `forbidWriteSchemas` 清单再决定要不要看语句，清单为空 / 传空串 / 库名层级错配三种情形都静默放行，那是本契约已收口的缺陷。
- **未知即拒**：空语句、只有注释的语句证明不出只读 → 同样 `DB_GATE_DENY`。没有“判不出来就算读”这一档。
- **要变更数据不是本 skill 的事**：四段流水线的正常产物是行集，不是变更。需要改数据时按 `driver-contract` §SQL 工件契约产出交人工执行的 SQL 文件，本次 DB 侧结论记 `partial` + `DB_WRITE_OUT_OF_SCOPE`（与 `DB_UNREACHABLE` 分开：一个是“不授予”，一个是“连不上”）。
- **非库槽位的写动作门禁（与 DB 门禁叠加，不互替）**：上面两条只管数据库通道。其它源（发消息、改记录状态、上传文件、改远端配置）受各槽位自己的 `writes` 段约束，判据全部来自 L2 声明而不是模型对“这个动作危不危险”的印象：
  - 该槽位未声明 `writes` 段 → **只读源**，任何写动作直接拒（exit 2 + `error` 写 `WRITE_NOT_DECLARED:` 前缀，形态同 `DB_GATE_DENY`，不是新退出码）。“没列出来”等于“没授权”，不等于“没限制”。
  - 动作在其 `writes[].action` 里且 `gate: deny` → 直接拒，**不提供“要不要试试”的选项**；用户口头坚持（“我就要发”）不是绕道，要改的是声明而不是绕过它。
  - `gate: confirm` → 把**要发出去的完整载荷**（哪个源、哪条记录、什么内容）先给用户看，拿到明确同意才执行。“用户没反对”永远不等于“用户同意”。
  - 要做的动作不在词表里也不是用户登记过的 `other` → 停下问用户归类（归类结果由 `/supperH-driver` 写回 L2），**不得自己挑一个最接近的类别执行**。
- **本 skill 的四段流水线默认只读**：`invoke` 段的正常产物是行集，不是变更。写动作只能出现在显式登记过 `writes` 的槽位上，且总走 `bug-dev` / 命令层的写门禁，不在取数链路里顺手发起。
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

| 用途 | 工具 | 参数 |
|---|---|---|
| 数据库通道（`role: database`） | `db_query` | `project` / `source` / `params` / `limit` |
| 任意已白名单源 | `query` | 同上（通用兜底，也是**只有这一个**能服务非库源的工具）|

壳按 **role** 而不是槽位名判定谁能走 `db_query`：取一个不是数据库通道的源去调它会被直接拒（exit 2 语义），因为那等于把 SQL 写保护开给一个没人拦的通道。除 `db_query` 外不再有其他具名工具——“有几个源、各自叫什么”是用户的事，L1 不替它建工具。

- `source` **必须**在该槽位 L2 配置的 `mcp.sources` 白名单里（解析器返回体里的 `drivers.<槽位名>.mcp.sources`）；不在则壳直接拒（exit 2 语义），**不要改个名字重试**
- 工具返回的 `content[0].text` 就是 envelope 本体，照常走第 4 段；失败时 envelope 与 JSON-RPC error code 同时存在
- 工具调用**没有退出码**：因此本分支的结果只能用于取数，**不得拿去做任何分流判断**（红线 R3.5）
- 通道不可用（server 没起 / adapter 缺失）时壳会显式报错；按 `fallback` 处理：`script` → 告知用户重跑登记期探测（`/supperH-driver` 的 update 或 `/supperH-init --write`，kind 会被回写成 script）；`none` → 直接停下报告，**绝不默默换成另一种数据源**

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

`/supperH-bug` 抽到的锚点不含代码位置时，由 `bug-analyzer(mode=lookup)` 经本协议反查接口路由。这是一个**只读、单结果**的特化调用。

**用哪个槽位反查，本 skill 不指名**（F-11：槽位名归用户，L1 没有也不该有「日志源」这个名字）。判据：

1. 候选集 = 步骤 0 返回的 `drivers` 键集合里，`desc` 表明能按该锚点标识符换回接口路由的槽位。需要的关系由门禁脚本的 `lookupNeed` 字段递出（`trace_id -> route` / `ticket_no -> route`）——脚本只说“要成什么关系”，不说“走哪个槽位”。
2. **候选数 ≠ 1 → 不猜，直接报反查失败**（调用方因此走完整路径）。零个 = 没接能反查的源；多个 = 拿不准用户指的是哪个，选错的成本比慢一次高。
3. 判据是“这条关系成不成”，不是“这个源正统不正统”：只要被选中的源能用这个 id 换回 `route` 列，它来自日志平台还是其它产品都一样有效。所以按 `desc` 选源的残余风险是**单向失败的**：选错了返回不出 `route` 列 → 按下面第一条约定 = 反查失败 = 升格完整路径，不可能把一个错的 route 递进门禁。
4. 该槽位必须**只读**（未声明 `writes` 段）。带了任何写动作的槽位不得用于反查——反查是取证据，不是发起变更；若 driver 在执行反查时发生了写（信封 `meta` 可看出），调用方视为协议违约并升格。

调用形式（`<slot>` = 上面选出的那一个；`<source>` 与 `<idField>` 取该槽位自己在 `desc` / `config` 里声明的值）：

```
<impl.slot> --project <code> --source <source> --filter <idField>=<锚点原值> --limit 1
```

**不得凭空造 `--source` 值**：不在该槽位 `mcp.sources` 白名单里的 source 会被壳直接拒（exit 2 语义），而“换个名字再试一次”属于红线禁止的横向降级。

约定：

- driver **必须**在返回的 `data.columns` 里提供一列 `route`（值形如 `POST /api/x/y`）；缺失该列 → 视为反查失败（`code: TARGET_NOT_FOUND`），**不得**用其它列凑。
- 反查以“能锁到唯一接口路由”为目的：命中 0 行或多行且 route 不唯一 → 调用方按歧义处理（升格完整路径），**绝不在多条里任选其一**。
- 反查出的 route 只是「进门禁的钥匙」，仍要过步骤 1.5 的 G0–G4b + 否决词表 + I0；带反查锚点跑门禁时**必须**附 `--anchor-source lookup`，否则 I0 会把它当成编造的引用判 40。
- 本反查不替代也不绕过 DB 门禁，二者相互独立。

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
- 禁止把 driver 的 stdout 内容原样 dump 到 git 追踪的文件里（防止真实业务数据被误提交；如需落地只允许进 `{{PRIVATE_ROOT}}/context/`——可用子目录以 `scripts/resolve-private-root.mjs` 的 `PRIVATE_SUBS` 为准，指未登记的目录等于让用户照提示撞不存在的路径）
- 禁止"只报答案不报语句"：`query_missing` 可以出现在汇报里，不可以被省略；也禁止把没有语句的取数结果当作已验证事实写进结论

## 参考实现

见 `{{TOOL_ROOT}}/drivers-skeleton/`：

- `base_driver.py`：SELECT-only 守卫 + JSON 输出 + Decimal/datetime 序列化的共享工具
- `example_json_driver.py`：可跑的最小示例（读 JSON 文件当数据源，证明协议可落地）
- `example_data.json`：示例数据集

用户开发自己的内网 driver 时从 `base_driver.py` 派生即可，落到 `{{DRIVERS_ROOT}}/` 下并在注册条目的 `drivers.*.impl` 里登记。
