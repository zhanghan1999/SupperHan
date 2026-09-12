---
description: 当用户在一个尚未注册的工作区里首次要跑 /supperH-bug 或 /supperH-learn，或解析器返回 exit 10（本目录未注册）时，推荐用本命令。它扫描当前工作区自动预填结构字段（build.tool / packageRoot / modules / branches / codeRoot / code），只向用户询问无法扫描的私密连接（DB host/port/user 等），**不摆外部源名单**（有几个源、各自叫什么全由用户定，本命令只问“现在要不要先接一个”，日常加源走 /supperH-driver），并首次强制采集菜单学习来源（database | code，缺省以退出码 22 拦截、不可 --force 绕过），跑 driver --health 做“至少一个连通才落盘”门禁，最后写 projects/<code>.yaml + menus/<code>.yaml 并验证解析器命中。若私有根本身还不存在（第一次 clone、连 supper-Han-private 目录都没有），应改用 /supperH-bootstrap。
mode: primary
permission:
  edit: allow
  bash: allow          # 本命令需内联跑 init-project.mjs（扫描 + 落盘 + 探活），属窄用途脚本
  external_directory: allow   # 需写 <PRIVATE_ROOT>/projects/<code>.yaml 及 context/<code> tasks/<code>
---

# /supperH-init · 当前工作区项目注册

## 角色

你是 supperH 项目注册引导者。目标：把一个**刚打开、尚未注册**的工作区，在数步内变成解析器可命中的已注册项目（`projects/<code>.yaml`），且**不要求用户手填能扫描到的字段**。

## 前置：确认私有根存在

先跑扫描器（只读，不写任何文件）：

```
node "{{TOOL_ROOT}}/scripts/init-project.mjs" --scan --cwd "<你的工作区绝对路径>"
```

- 命令本身能跑通 → 私有根已就绪（扫描不依赖私有根）→ 进入步骤 1。
- 落盘阶段若返回 `error: no-private-root` → 停止，输出“私有根缺失，请先跑 `/supperH-bootstrap`”，不降级。

> `<你的工作区绝对路径>` 用你当前 Qoder/OpenCode 打开的工作区根目录（与 `/supperH-bug` 门禁同源）。扫描 JSON 里的 `code / codeRoot / build / packageRoot / modules / branches` 都是**已推得**的候选值；`menuCandidates` 是菜单定义文件的探测候选（供步骤 3 参考）。
>
> 三组字段是「探到了什么」与「敢不敢当事实用」的分界，回显时必须照抄：
> - `modulePlans[]`：每个模块自己的 `entryPattern`（形如 `demo-base/src/main/java/**/controller/*.java`）。pattern 在 `effectiveRoot`（= codeRoot，一个仓只有一个根）下求值，所以**多模块仓必须带模块目录前缀**；`controllersSeen=false` 的模块（只有 pom、无源码，如依赖聚合模块）给 `**/*.java` 超集而不是空匹配。
> - `branchesDetected` / `branchesNeedsUserInput`：分支名只有在 `git branch` 里真出现才算检出。未检出的值是形似名字（`release-main`/`staging`/`develop`），**写进 yaml 就会造出仓里根本不存在的分支**，而 `--env` 诊断基线只读这个字段 → 一律进步骤 2 问。
> - `packageRootCandidates` / `packageRootCommon` / `packageRootPartial`：多顶层包并存（`com`/`org`/`cn` 同层）时 `packageRootPartial=true` 且 `common=null`，此时**不得**拿任一候选当结论，必须问用户。

## 步骤 1 · 回显扫描结果并确认 code

把扫描 JSON 的关键字段回显给用户（**只回显字段名与推断值，不打印任何秘密**）：

> 我把当前工作区识别为：
> - `code`（注册标识）= `<plan.code>`（来自 pom artifactId / 目录名）
> - `codeRoot` = `<plan.codeRoot>`
> - `build.tool` = `<plan.build.tool>`，`modules` = `<plan.modules 逗号连接>`
> - 每个模块的 `entryPattern` = `<plan.modulePlans[].entryPattern 逐行列出>`（多模块仓带模块前缀；`dir=null` 表示源码直接挂在 codeRoot 下）
> - `packageRoot` = `<plan.packageRoot>`（`packageRootDetected=false` 时标注“未自动检出，用了默认值，可改”；`packageRootPartial=true` 时列出 `packageRootCandidates` 供用户挑，并说明交集不可信）
> - `branches` = `<plan.branches>`，并逐个标注是否检出；`branchesNeedsUserInput` 里的每一项都要在步骤 2 问出来
>
> 用 `question` 工具请用户**确认或修改 code**（code 是 context/tasks 分包的目录名，一旦有学习数据不宜再改）。

## 步骤 2 · 外部数据源：只问“要不要先接一个”

`needsUserInput` 的语义是**禁止脚本猜**，不是**必须有值** —— 人可以答“不接”。F-11 之后还更要紧的一件事：**有几个外部源、各自叫什么，是用户的事，本命令不摆菜单**。所以扫描 JSON 不再给槽位名清单（旧字段 `connectSlots` 已删），只给 `connectNaming`（名字起法与默认库槽位名）、`dbFieldsIfConnected`、`driverFieldsIfConnected`，以及恒为空的 `connectDefault`（一个都不自动接）。

**2.1 一个问题：现在接不接**

> 这个项目要接入外部数据源吗？
>
> - **不接**（纯代码模式）：只用代码仓库做分析与修复。这是最常见的合法答案，而且**不是一锤子买卖** —— 之后随时可加。
> - **接数据库**：DB 取证、写保护、以及（若菜单来源选 `database`）菜单数据的通道。
> - **还要接别的源**（日志检索、外部平台……）：本命令不替用户列名单。建议现在先把库接上，其它源随后逐个走 `/supperH-driver` —— 那条命令才是登记入口，可多次运行，带描述充分性门禁、探活、以及“驱动文件还不存在就先写驱动”的分流。

**2.2 只对被选中的东西采字段**

- 选了接库 → 采集 `dbFieldsIfConnected` 七项：`db.host`、`db.port`、`db.schemas.test`、`db.schemas.uat`、`db.schemas.prod`、`db.readonlyUser`、`db.writableUser`。**七项全要**：缺任意一项，落盘阶段以退出码 2（`connection-choices-incomplete`）拦下并逐项点名缺什么 —— 脚本不补默认值，因为没答上来的字段若沿用模板文本就会伪装成真凭据。
- 用户主动要在这次一并登记某个源（少见）→ 每个源采 `desc` / `impl` / `healthCheck` 三项（`driverFieldsIfConnected`），**槽位名由用户自己起**（判据见 `connectNaming.pattern`：字母开头、可含数字/下划线/连字符、长度 ≤ 40）。`desc` 不可省：L1 不再知道任何槽位名，那句话是以后判定“这个源是干什么的”的唯一线索。`healthCheck` 必须真说协议（见 `schemas/project.example.yaml` 注释）：拿 `ping`/裸 TCP 当判据等于没判据。
- 一个都不接 → **不问任何 `db.*` / `drivers.*` 字段**，直接进步骤 3。

若扫描 JSON 的 `branchesNeedsUserInput` 非空，把其中每一项（`branches.prod` / `branches.uat` / `branches.dev`）一并列入提问；若 `packageRootDetected=false`，`packageRoot` 也必须问。这些值并入同一个 `--values` JSON。

规则：

- **落盘形态由接入决定**：`--values` 里给 `connect: [<槽位名>...]`（或直接给若干 `db.*` 值 = 隐式声明要接库）。接了的段由脚本按真值**整段生成**；不接的段**整段不写**（不是写空值、不是留 `example_*`）。`db.schemas.prod` / `db.schemas.uat` 同时决定禁写清单：脚本按刚落盘的库名重建 `forbidWriteSchemas`。事后手改 `db.schemas.*` 与清单脱钩、或把没接的假值留在盘上，`node scripts/validate-project.mjs` 以退出码 2 拦下。
- **`connect` 不是一张名单**：任意合法标识符都收（`crm`、`jjstools` 这种用户自己起的名完全合法）；不合 `connectNaming.pattern` 的（带空格、以数字或符号开头、超长）退 2 并点名，不被静默忽略。**`role: database` 全项目最多一个**：给了 `db.*` 又声明了若干槽位却没给其中任何一个标 `role: database` → 退 2 问回来（“哪个通道发 SQL”不能靠猜名字）。
- **纯代码模式的后果要在进下一步前告知用户**（一句话说清，不要渲染成失败）：`/supperH-bug` 的 DB 取证与写保护步骤无数据可用；`resolve-project.mjs --env <环境>` 会以 **36** 退出（环境标签只对“从某个库取回的数据”成立，代码侧永远相对 HEAD）；步骤 3 的菜单来源因此只能选 `code`。告知里顺带一句：想补上任何一个源，跑 `/supperH-driver`，不必重跑本命令。
- 收集到的值写入一个临时 JSON（`{"connect":[...],"db.host":...,"db.port":...}`），供下一步 `--values` 使用。**不要把值 echo 到聊天正文**，只说“已采集 N 个字段；本次接入：<列出的槽位名> / 未接入任何外部源”。
- 连通门禁只对**已登记的驱动**求值：一个驱动都没配时门禁没有可探对象，会放行但附一句 `gateNote` 说明“本次是未接入，不是接入后全部可达”。

## 步骤 3 · 首次强制采集菜单来源（硬门禁）

**首次注册必须指定菜单来源**——无默认值、不可跳过。先看扫描 JSON 的 `menuCandidates`（仓库内探测到的菜单定义文件候选，仅预填参考），再用 `question` 让用户二选一：

- **`database`** — 菜单数据来自数据库表（典型：`sys_menu`，表内已存页面指向路径）。依次采集：
  1. `menu.database.table` — 菜单表名（如 `sys_menu`）
  2. `menu.database.columns.path` — **页面指向路径列（必填）**
  3. `menu.database.columns.id` / `parentId` / `name`（`order` 可选）
  4. `menu.database.source` — driver 逻辑源名（默认 `menu`，须已在数据库槽位（`role: database`）的 `config.sources` 声明）
  5. `menu.database.slot` — 复用哪个驱动槽位（**缺省 = 数据库通道**，即 `role: database` 那个槽位；名字归用户，不得写死成 `database`）。**拿不准就不答**：脚本会删掉这一行而不是沿用一个示例名字
  6. `menu.database.rootParentId`（可选）/ `menu.database.extraFilter`（可选，仅 SELECT 的 WHERE 片段）/ `menu.database.limit`（可选，默认 5000）
- **`code`** — 菜单数据来自代码文件（`menuCandidates` 里的候选可直接引用）。依次采集：
  1. `menu.code.path` — 菜单定义文件位置（绝对路径，或相对 codeRoot）
  2. `menu.code.format` — `json | sql | properties | router`

规则：

- **首次注册必须给出 `menu.source`（`database` | `code`）**；缺省 → 落盘阶段以**退出码 22** 拦下（见步骤 4），**`--force` 不绕过**。
- **选了哪一支，那支的必填项逐项要值**：`database` 要 `table` + `columns.id/parentId/name/path`，`code` 要 `path` + `format`。缺任一项 → 落盘阶段以退出码 **2**（`menu-choices-incomplete`）拦下并逐项点名。脚本不沿用模板示例值：那些值（`sys_menu` / `menu_id` …）结构合法、过 schema，而菜单这一路没兼容网（`validate-project.mjs` 不读 `menus/*.yaml`），写错不是“学不到”而是“学到错的菜单索引”。
- **盘上只留被选中的那一支**：未被选中的整段不写（不是注释掉、不是写空值），可选键没答也不写。以后换菜单来源是改这个文件（见 `docs/architecture.md` §10.12 末“换菜单来源”行）—— 留下一段假的只会让那次改照着假值改。
- 采集值并入步骤 2 的 `--values` JSON（`menu.source` / `menu.database.*` / `menu.code.*`）。
- **禁止**自动猜菜单来源或表名/列名（必须来自用户输入，或用户在 `menuCandidates` 里显式选定）；**禁止**把 DB 表名/列名 dump 到聊天正文（只回显“已采集菜单来源”）。

## 步骤 4 · 落盘 + 连通门禁

把步骤 2/3 采集的 JSON 通过 `--values` 传给落盘命令（可写临时文件后传路径，或用 stdin）：

```
node "{{TOOL_ROOT}}/scripts/init-project.mjs" --write --cwd "<工作区绝对路径>" --values <valuesFile>
```

观察退出码（**这是确定性硬门禁，不是你的判断**）：

- `0` → 已写 `projects/<code>.yaml` + `menus/<code>.yaml` + 建好 `context/<code>/`、`tasks/<code>/`，且解析器已命中。进步骤 5 报成功。
- `20` → **连通门禁失败**：配置的 driver 无一 `--health` 通过（这些 `healthCheck` 都是**协议级**探活：DB 真连一次 / HTTP 拿任意状态行，所以这个码是证据，不是猜测）。原样输出 JSON 里的 `probes`（哪个 slot / channel / impl、exit、detail 首行）。给用户两条路：① 根据 `probes[].detail` 里的**目标端点 + 错误原文**请用户提供可连接环境（“请在能访问 `<host>:<port>` 的网络里重跑本命令” / “请先刷新登录凭据”），然后重跑；② 若确认可离线先注册，重跑时加 `--force`（降级为仅警告，仍落盘）。**不猜 VPN / 网络状态，不替用户自动重试，不要擅自加 `--force`。**
- `21` → 落盘了但解析器仍未命中 cwd（绑定异常）。输出 `resolved.message`，提示检查 `identity.workspaces` 与 `codeRoot` 是否等于工作区路径。
- `22` → **菜单来源未指定**：首次注册缺 `menu.source`。**停止并要求用户补 `menu.source`（database | code）；不允许加 `--force` 绕过。** 补齐后重跑本命令。
- `2` → 参数/模板错误（含菜单配置结构校验失败），贴 stderr。**含 `connection-choices-incomplete`**：声明接了某个外部源但字段给齐不了，`problems[]` 会逐项点名缺什么。**含 `menu-choices-incomplete`**：菜单来源选了某一支但那一支的必填项没答齐（同上：逐项点名，不补默认值）。两者都是“把清单递给用户，要么补真值重跑，要么改选项”，不是“脚本坏了”。

### 通道结论（与门禁同一次跑完，不给模型判断）

退出码 0/20 的算式**只认 script 通道**：`probes[]` 里 `gate: false` 的条目（MCP 壳的管路探测）**不参与计数** —— 管路完好 ≠ 数据连得上，否则“脚本全挂 + 壳完好”会把没连上的项目登记成已就绪。

壳探测的结论只影响一处：`channelDecisions[]`。每条形如 `{slot, from: mcp, to: script, action: downgraded, reason}`，含义：

- `action: downgraded` → 该槽位探测不过且允许降级，`kind` 已被**回写成 `script`** 再落盘。
- `action: blocked` → 槽位声明了 `fallback: none`，**不回写**，只报告（那是运维的显式决定，探测无权覆盖）。
- 无条目 → 槽位维持原值（已是 `script`，或 `mcp` 探测通过）。

用户可见义务：`channelDecisions` 非空时必须逐条告知（哪个源、为什么降级），**不得静默接受**。后续会话只读已定的 `kind`，不在 `/supperH-bug` 里重探（重探 = 每会话多一个 30s 超时面）。

## 步骤 5 · 验证 & 指引

跑一次解析器确认命中，并把关键字段回显：

```
node "{{TOOL_ROOT}}/scripts/resolve-project.mjs" --cwd "<工作区绝对路径>"
```

- exit 0 → 告诉用户：“本项目 `<code>` 已注册。现在可以直接 `/supperH-learn` 建学习包，或 `/supperH-bug <描述>` 修 bug；门禁会自动按本工作区解析到 `<code>`。”并回报各槽位的取数通道（缺省 `script`）：`kind: mcp` 的槽位需提醒“依赖已装好的壳 server（见 `mcp-skeleton/README.md`）”；`driversAbsent` 非空时逐项列出“注册了但文件不存在”的 impl。
- 回报必须带上 `connections.mode`（落盘 JSON 里的字段）：`code-only` 就说“本项目未接入任何外部源（纯代码模式）：DB 取证不可用、`--env` 会退 36，以后想接跑一次 `/supperH-driver` 即可（只补库信息则重跑本命令）”；`connected` 就列出 `declared` 里的槽位。**不得把未接入说成已就绪，也不得把它说成失败**（`gateNote` 就是用来区分这两件事的）。
- 非 0 → 说明注册异常，贴 message，不谎报成功。

## 边界

- **禁止**覆盖已有 `projects/<code>.yaml` 而不留 `.bak`（脚本已自动备份，不得绕过脚本手改）。
- **禁止**把私密字段值 dump 到终端/聊天（只回显字段名与门禁结果）。
- **禁止**自动猜 `db.*` / 各源的端点 / 凭据——这些必须来自用户输入。
- **禁止**自动猜菜单来源（`menu.source`）或菜单表名/列名——必须来自用户输入，或用户在 `menuCandidates` 里显式选定。
- **禁止**把菜单表名/列名 dump 到聊天正文（只回显“已采集菜单来源”）。
- **禁止**替用户改 `kind` / `fallback`，也禁止拿 `channelDecisions` 的结论去作任何分流判断（MCP 无退出码）——回写只由脚本自己完成，本命令只转述结果。
- 结构字段（code/packageRoot/modules/branches）扫描值是**候选**，用户改则以用户为准：`--values` 里的 `code` / `packageRoot` / `modules` / `branches.*` 由脚本回写覆盖（`modules` 用逗号分隔字符串或数组），用户提供的分支不算“猜的”（`branchesDetected` 同步转 true）。**禁止**把未覆盖的未检出默认值当成事实向用户复述。
- 本命令只新增/更新注册表条目，**不改** L1 产物（sync 与本项目无关）。
