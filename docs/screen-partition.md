# F-15 · 页面档案模型（screen partition）· 设计定稿

**状态**：设计已定稿（含一轮**通用性修订**），**代码一行未动**。分期计划见 §9。

**通用性修订记要**：本文最初是按"服务端渲染 + 数据库菜单表"这一种形态写成的。修订后要求**同一套 L1**
能同时装下两类相反形状：服务端渲染（有后端菜单表、Controller 返视图名、模板里抽按钮）与前端路由表
（无后端表、入口直接指向组件文件、压根没有"Controller → 模板"这一跳）。四处改动：

1. `render`（呈现）段改名 **`template`**（模板工件）—— 见 §3；
2. 六段从"固定顺序的链"改成**键依赖图** —— `hops`（跳）为 L2 一等公民，见 §4.2；
3. 来源不再做成枚举，改用 **`evidence`（证据类别）轴** —— 见 §4.4；
4. 发现器补 `via: code` 一类，并**删去旧版"发现器可为空 = 纯靠代码扫路由"这句未建模的承诺** —— 见 §4.1 / §4.5。

> **纯度提醒（改本文件前必读）**：本文件在 `L1_SCAN_DIRS` 名单内，`node scripts/sync-assets.mjs --check`
> 会把注册条目的 `identity.code` 等专有值当事实逐字比对（长度 ≥ 3 即参与）。所以全文用 `<code>` / `demo`
> 指代，**不许出现任何真实项目短码、库名、表名、包根、本机路径**。样例里的 `demo:order:add` 这类权限串、
> `<webapp 目录>` 这类路径段都是编的形态示例，不是任何一个真项目的值。

---

## 1. 现有模型覆盖到哪一段

一条真实的"用户看到一个页面"的链，共四段：

| 段 | 内容 | 介质 | 现有模型 |
|---|---|---|---|
| ① | 页面清单：中文名 + 入口路径 | **数据库表**（或下发菜单的接口） | ✅ 唯一被支持的一段 |
| ② | 入口路径 → 处理该路径的代码 → **模板工件**（服务端渲染是 Controller 返回的视图名所指的模板文件；前端路由表是组件文件） | Java 代码 / 前端代码 | ❌ 无 |
| ③ | 模板文件里的**动作**（按钮 / 链接 / 批量）、各自的**权限标识**、以及页面运行时打的**数据接口** | 模板文本 + JS | ❌ 无 |
| ④ | 下钻目标（明细页 / 弹层 / 导出）→ 回到 ② | 模板文本 | ❌ 无 |

`schemas/menu.example.yaml` 对这个模块的定义原文是：**「菜单学习的本质：菜单项 → 其指向的页面路径 → 后端路由/代码」**。
它把 path 当**终点**；真实需求把 path 当**入口**。②③④ 三段一行都不在模型里。

### 1.1 四处结构性违背（逐条盘上依据）

| # | 需求 | 现状 | 依据 |
|---|---|---|---|
| 1 | 多来源结合 | `source` 被 `oneOf` 做成**互斥二选一**，顶层 `additionalProperties: false` 连第三个键都不许出现 | `schemas/menu.schema.yaml` L92-98 / L13 |
| 2 | 来源可以是**接口** | 两支都不行：`database` = 走数据库通道 SELECT；`code` = 读**文件**（`json/sql/properties/router` 全是文件解析） | 同上 L30-32 / L79-80 |
| 3 | 装得下**按钮** | `database.columns` 是 `additionalProperties: false` + 固定 5 属性；envelope 列也硬定为同四列（可选 `order`）→ **类型列与权限列无处声明** | 同上 L50-59；`skills/supperH-driver-contract/SKILL.md` §菜单查询 |
| 4 | 学到能用 | `menu` 保留分区被明确挡在快路径门外 | `scripts/fastpath-gate.mjs` L677 |

**第 2 条尤其该记下来**：通道层早就中立了 —— `drivers.<槽位>` 可以是任意源（script 或 mcp），desc 写"菜单接口"完全合法，
`/supperH-driver` 也登记得了。**是菜单来源层的枚举没跟上通道层的中立化。** F-10 / F-11 把"源叫什么、有几个"交给了 L2，
而 `menu.source` 仍是一张 2 值的 L1 名单 —— 同一个病没治完。

---

## 2. 重新规范：学习对象是「页面」，菜单降级为「发现器」

一句话：**`menu`（菜单）不再是被学习的对象，它只是"从哪儿发现这些页面"的途径之一。**

命名选定 **`screen`（页面档案）**：一个用户可见界面 = 一条记录，含明细页与弹层。四个候选的取舍：

| 候选 | 判定 |
|---|---|
| **`screen`** | ✅ 选定。中性于视图技术，不含"导航"暗示；弹层/明细页天然是它的一条记录，正好接住"下钻" |
| `page` | ❌ 与 Java 分页参数、`PageResult` 撞名，读代码时会判错 |
| `view` | ❌ 与 MVC 的 view（模板文件本身）撞名；同一条记录里既要有 view 段、整个东西又叫 view，必然绕 |
| `ui-map` | ❌ 是集合名不是记录名，且暗示"只做索引不做内容" |

**命名补记（同一条理由管到段名）**：段名 `render`（呈现）已被改名 **`template`**（模板工件）—— "render" 是服务端渲染的
词，前端路由表项目里没有"渲染"这一跳，它有的是"路由指向组件文件"。`template` 对 JSP、`.vue`、layout XML、下发的 UI
schema **四种形态都成立**。`menu` 保留为 legacy 别名 + 只发警告（见 §8）。

## 3. 一个 screen 的六段形状

六段是**产物骨架**（代际、门禁、`index.md` 列集合都依赖它，故必须固定）；填它们的**跳数与跳序由项目形状决定**（§4.2）。

| 段 | 装什么 | 产出哪些键 | 谁消费它 | 能否反查到可改工件 | 进锚点资格 |
|---|---|---|---|---|---|
| **identity** | 页的中文名、稳定 id | `screenId` / `name` | `index.md` 展示；`route` 反查时作候选名 | 否（是名字不是工件） | ❌ |
| **entry** | 入口路径 → 处理该路径的代码位置（服务端渲染是 Controller 方法，前端路由表是组件） | `route` / `entryCode` | `template`、`dataSources` 反查的后端侧 | ✅ `path:line` | ✅（须 `evidence: static`） |
| **template** | 模板/组件工件的仓库内路径 | `templateFile` | `actions` / `dataSources` / `drilldowns` 的搜索根 | ✅ | ✅ |
| **actions** | 页上动作：按钮 / 链接 / 批量 + 各自权限标识 + 点了打哪个接口 | `action`（含 `perms`） | 反查后端权限注解 | ✅ | ✅（`perms` 是这条链上唯一的双向锚） |
| **dataSources** | 页面运行时接口（表格、字典、下拉、上传）→ 各自背后的代码位置 | `route` | 与 entry 同路反查 | ✅ | ✅ |
| **drilldowns** | 下钻目标（另一个 screen 的入口 / 弹层 / 导出） | `route` → 另一条 screen | 建页面间图 | ✅ | 一期 ❌（见 §9 F-15e） |

四条关键转变：

1. **每段独立来源、独立可缺**。不再问"数据库还是代码"—— identity 从库里来，template / actions / dataSources 从代码里来。
   "多来源怎么合成"这个伪问题随之消失：它压根不是同一份数据的多个来源，而是**不同段各有来源**。
2. **只有 identity 一段依赖外部通道**。推论（重要，因为它改变优先级）：**一个驱动都没登记的项目，也能立刻学到
   entry / template / actions / dataSources 四段**（全在代码仓里，纯静态解析），只是少了页面的中文名。
3. **六段的骨架固定，但** `identity → entry → template → actions` **不是必经链**。服务端渲染项目走满；前端路由表项目
   没有"Controller 返回视图名"这一跳（路由直接指组件），`entry` 与 `template` 由**同一条 hop** 一次产出；
   低代码下发项目两个形态都不走（§4.4 `evidence: generated`）。
4. **能否进锚点门禁不看段名、看证据类别**（§4.4）：能机械反查到一个可改工件的只成语料，永不进门禁 —— 与既有的
   "按来源类别决定门禁落点"同纪律，只是把判据从"哪个段"换成"哪类证据"，这样新增段或新增形态都不会让门禁判定漂移。

---

## 4. 形状：键依赖图 + 规则归 L2

设计约束的来源：`format: json|sql|properties|router` 这种 L1 内置枚举，就是今天把"接口"漏掉的成因。所以解析能力
一律不做成 L1 枚举。L1 只保证四件事：**键声明闭合**、**每条规则必须命名并带 `desc`**、**命中结果必须带 `path:line`**、
**未命中不许造**（§4.5）。换视图技术、换项目形状只改 L2，L1 一行不动。

`menus/<code>.yaml` → 改名 `screens/<code>.yaml`（与 §8 的兼容策略一并处理）。目标形状（字段名以此为准）：

```yaml
schemaVersion: 2
project: <code>

# ── ① 发现器（discovery）：页面清单从哪来。四类介质，至少一项 ────────────
discovery:
  - via: database                 # 读库里的菜单表
    slot: <可选>                  # 缺省 = role: database 那个槽位；槽位名归用户，不得写死
    source: <driver 逻辑源名>      # 须在该槽位 config.sources 里声明
    table: <菜单表名>
    columns:                      # 权限列与类型列在这里才第一次有了位置
      id: <列名>
      parentId: <列名>
      name: <列名>                # → 产出 identity 的 name
      path: <列名>                # → 产出 entry 的 route（必填）
      type: <列名>                # 可选：目录 / 菜单 / 按钮 的区分列
      typeValues: { group: <值>, page: <值>, action: <值> }   # 可选：值 → 语义映射
      perms: <列名>               # 可选：权限标识列（动作段的主料）
      order: <列名>
    rootParentId: <可选>
    extraFilter: <可选，仅 SELECT 的 WHERE 片段>
    limit: 5000
  - via: driver                   # 接口下发菜单（旧模型完全不能表达的一类）
    slot: <已登记的槽位名>
    source: <逻辑源名>
    map: { name: <键路径>, path: <键路径>, perms: <键路径> }
  - via: code                     # 新增：没有表也没有接口时，清单从代码本身来（扫路由/扫组件目录）
    profile: <可选，见 §5>
    rules: [ { desc: <必填>, match: <正则>, capture: { route: 1 } } ]
  - via: artifact                 # 原 code 支改名（读仓内文件）
    path: <仓内文件或目录>
    parser: json | sql | properties | router | other
    userPhrase: <parser=other 时必填：一句话说清它是啥、怎么解析>
    map: { id: <键>, name: <键>, path: <键> }

# ── ② hops（跳）：把上游一个键变成下游一个键。条数与顺序由项目形状决定 ──
hops:
  - id: entry-from-route          # 路由 → 代码位置（服务端渲染是 Controller 方法，前端路由表是组件）
    requires: [route]
    produces: [entryCode]
    profile: <可选>
    rules: [ { desc: <必填>, match: <正则>, capture: { file: 1, line: 2 } } ]
  - id: view-name-from-controller # ★ 这一跳只存在于服务端渲染项目
    requires: [route]
    produces: [viewName]
    profile: <可选>
    rules: [ { desc: "Controller 返回语句里的视图名", match: 'return\s+"([^"]+)"', capture: { viewName: 1 } } ]
    onMiss: incomplete            # 机械展开"未命中不许造"：未命中不得猜
  - id: template-from-view-name   # 视图名 → 模板文件路径（前缀/后缀不硬编码进 L1，从项目侧读）
    requires: [viewName]
    produces: [templateFile]
    template: "{codeRoot}/<webapp 目录>/<prefix>/{viewName}/<module>"
    prefixFrom: { profile: <可选>, rules: [ { desc: <必填>, match: <正则> } ] }

# ── ③④ 页内抽取（extract）：形状与 hop 完全一致，只是产物是"页面上的东西" ──
extract:
  actions:                        # 动作（按钮 / 链接 / 批量）
    - desc: "带权限标识的按钮标签"
      requires: [templateFile]
      match: '<某个权限标签 [^>]*name="([^"]+)"[^>]*>([^<]+)<'
      capture: { perms: 1, label: 2 }
  dataCalls:                      # 页面运行时打的数据接口
    - desc: "JS 里以 url 字面量发起的异步请求"
      requires: [templateFile]
      match: "(?:url|\\.post|\\.get)\\s*\\(\\s*['\"]([^'\"]+)"
      capture: { route: 1 }
  drilldowns:                     # 下钻（一期只存，不用于锚点）
    - desc: "跳转型链接"
      requires: [templateFile]
      match: '<a [^>]*href="([^"]+)"'
      capture: { route: 1 }
```

### 4.1 四类介质，至少一项

`via` 只有 `database | driver | code | artifact` 四类**介质**，不含任何产品名或技术栈名。
`code` 这一类是本轮补的：**很多项目根本没有后端菜单表**（前端路由表项目、Android 项目），它们的页面清单只能从代码本身来。

**旧版此处有一条假承诺，必须记住它错在哪**：原文写"`discovery` 可为空数组（= 无发现器，纯靠代码扫路由）"——
但"扫路由"在 schema 里没有落点，实现时只能由 L1 内置一个假设来填，那正是 §1.1 第 2 条所批的病。
现改为：**发现器至少一项**（写 `via: code` 即可），"页面清单从哪来"永远有明确出处。

### 4.2 hops 是 L2 的一等公民

六段固定 ≠ 六跳固定。每跳声明 `requires`（要哪些键）与 `produces`（产出哪些键），L1 据此做**依赖闭合校验**：
某段所需的键没有任何上游产出 → 该段直接 `incomplete` 并报缺哪个键，**不进产物正文**。
这一条把"通用性"从愿望变成可机械校验的判据。

### 4.3 规则的两层写法

- `profile`（剖面）：L1 随仓带的现成规则包，L2 只是**选**。
- `rules`：L2 自己写的正则数组。`profile` 未命中或不符时就写 `rules`，或 `profile: other` + 一句 `userPhrase`。

**两层同时缺省 = 该段为空**，不报错（纯代码模式合法）。L1 对 `rules[].match` 不做语义校验（校验不了），只校验：
能编译、捕获组号不越界、条数有上限（防跑飞）。

### 4.4 `evidence`（证据类别）轴

每段产物必标一个 `evidence`，取值四条。**它是"能不能信、能不能进门禁"的唯一判据**，取代任何"来源类型"枚举：

| 取值 | 含义 | 能否进锚点 / 门禁 |
|---|---|---|
| `static` | 源码里写死，静态可读（JSP / `.vue` / layout XML / 路由表文件） | ✅ 可（还须能反查到 `path:line`） |
| `generated` | 运行期由平台或代码生成（低代码表单 schema、脚手架产物） | ⚠️ 一期语料；落盘须带生成时间与来源指纹 |
| `runtime` | 只有真机点一遍、跑一次才知道（`uiautomator`、埋点日志） | ❌ 永不进门禁（静态无从判定，进了必被 fail-closed） |
| `doc` | 人写的文档（操作手册、权限矩阵） | ❌ 语料，且必然漂移 —— 是 RAG 的主力料，不是锚点 |

**为什么用一条轴而不是新枚举**：以后遇到任何新形态（"接口下发的按钮权限"、"配置中心决定的列"）都**不必往 L1 加值**——
它落进这四类之一。L1 的枚举面从此冻结。

### 4.5 L1 硬性要求（写进 schema 与校验，不靠提示词）

- `discovery` **至少一项**，每项 `via` 必填；`columns.path` / `map.path` 这类"指向页面的那一列/键"必填。
- `hops[]` 与 `extract.*[]` 每项**必须**有 `desc`：说不清它在抓什么，就不配进产物。
- **键依赖必须闭合**（§4.2）：未闭合的段 `incomplete` + 报缺哪个键，禁止由 L1 猜一个上游。
- **未命中不许造**：任何一段抽不出内容 → 该段如实为空并带 `incomplete: true`（沿用 analyzer 已有的
  `sources_incomplete` 纪律），**禁止**为凑完整性猜一个按钮名或接口路径。

---

## 5. 不变式：内置值只能是"可选加速"，不能是"唯一出口"

本文批评 `menu.source` 是"2 值的 L1 封闭名单"，而 §4.3 又要让 L1 随仓带 `profile`（名字里会带技术词，如
"扫注解路由"）。这两件事不矛盾，但**必须写下判据**，否则后来者（含模型自己）会以"便利"为名造出第二个 `menu.source`：

| 判据 | `menu.source`（病，要废） | `profile`（可留） |
|---|---|---|
| 是否唯一路径 | ✅ 不选它就没有别处可走，且无泄压阀 | ❌ 不选 profile、纯写 `rules` 完全合法，且是默认形态 |
| 取值 | 封闭 2 值，第 3 种形态只能改 L1 | 开放命名 + `other`，新形态只加一个文件 |
| 装什么 | 只能装 4 列导航树 | 装**任意段**的规则组合 |

一句话：**L1 可以内置能力，不可以内置唯一出口。** 每个封闭枚举都必须配一个 `other` + `userPhrase` 泄压阀。

可机械检查，落两条测试进 F-15b：
① 存在一条**不用任何 profile**、只靠 `rules` 出得出产物的用例；
② 每个 `profile` 名都必须是**可选键**（去掉它仍能通过 schema 校验）。

**剖面的推进时机（不在本文范围）**：本仓已有决策「剖面归 L1、选择归 L2」，且顺序是 Java SSR → Kotlin/JVM →
Go/TS → **最后才是前端 SPA / Android**。所以 F-15a–d **一律不抽剖面**：内置剖面必须由 **≥2 个真实形态**校准入抽象，
现在抽就是凭一个样本捏抽象。`screens/<code>.yaml` 的 schema 字段名一旦发布就是接口，故本文现在只把**形状**定死。

---

## 6. 产物形状

```
{{CONTEXT_ROOT}}/<code>/screens/gen-<ts>/
  ├── index.md          # 反查表：route / 模板工件 / 动作数 / 数据接口数 / 出处
  ├── batch-NN.md       # 一个页面一段：六段齐全或如实标缺
  └── CURRENT           # 代际指针
```

`batch` 正文的每个页面必须能回答这六个问题（**段名与骨架固定，缺的段如实空**），且**每条都带出处**：

```
## <页面中文名 或 route>
identity:      <来自哪个发现器项>  evidence=<类别>
entry:         <route>  →  <Class#method 或 组件文件>   <file>:<line>
template:      <模板工件仓库内路径>   （解自 hop `<id>`，<file>:<line>；无此跳则写 (no such hop)）
actions:       <按钮名>  perms=<权限标识>   <模板文件>:<line>
               …… 或 `actions: (none found) incomplete: true`
dataSources:   <route>  ← <Class#method>      <模板文件>:<line>
drilldowns:    <route> → 另一个 screen / 弹层   <模板文件>:<line>
```

`index.md` 的 frontmatter `kind: screens`。**权限标识（perms）的价值**：它是这条链上唯一能同时锚住
"前端那个按钮"与"后端那个权限注解"的稳定字符串 —— 有了它，动作段才真能进反查表。

---

## 7. 顺带修掉的三处旧账

| 处 | 问题 | 修法 |
|---|---|---|
| `skills/supperH-driver-contract/SKILL.md` §菜单查询 | 首句"菜单学习复用**数据库通道**"没有前提限定语 —— 它整节讲的是 `via: database` 这一支，但读者（含模型）会读成全局断言。本轮已有人被它带偏一次 | 补限定："当 `discovery[].via == database` 时……"，并明确另一句"接口型来源走该 discovery 项登记的 driver 槽位，`via: code` 型不经任何外部通道" |
| `validate-project.mjs` **不读** `menus/*.yaml` | `source: database` 但项目没有 `role: database` 槽位 → 写盘时无人拦，只有运行期撞上"不得猜一个驱动先跑着"才停。`architecture.md` L470 已认账："这一**跳文件**一致性目前无人机械拦" | v2 落地时把 `screens/<code>.yaml` 纳入 validate：`via: database/driver` 引用了不存在的槽位或未标 `role` 的槽位 → **警告**（纯代码模式合法，不阻断）；`config.sources` 里没声明所引用的逻辑源名 → 同样警告；**键依赖不闭合 → 同样警告** |
| `menu` 与 `screen` 两个词并存 | 迁移期会出现"菜单学习"与"页面学习"两种说法 | 命令层统一说**页面学习**；`--menu` 旗标保留为别名并提示改用 `--screen`；`/supperH-learn` 的模式表里 `menu` 行整行改写 |

---

## 8. `menu` 这五处硬编码怎么处理

早前已定过一条决策：不能简单 rename，因为 `menu` 至少硬编码在五处。逐条落实：

| 处 | 现值 | 处理 |
|---|---|---|
| 保留分区名 `module: "menu"` | `commands/supperH-learn.md` L68 | 新增并列保留分区 `screens`；`menu` 分区**只读兼容**（老产物照样能读），新学习一律写 `screens` |
| 首次注册硬门禁 **22** | `init-project.mjs` 的 `menu-source-required` | 语义放宽为"**发现器至少一项，但可以是 `via: code`**"：一项都没答 → 仍退 22（旧版那句"可为空"已在 §4.1 作废）；答"从代码路由表发现、没有中文名" → 合法通过 |
| driver 保留源名 `menu` | `driver-contract` §菜单查询 | 不变（它仍是 `via: database` 那一类的默认逻辑源名）；只是不再是唯一选项 |
| `CONTEXT_ROOT` 分区 | `resolve-project.mjs` 路径解析 | 加一个 `screens` 子分区，与 `menu` 并列；`paths.*` 覆写与 F-14 清场的 `LEARNING_KINDS` 同步扩（**否则清场会漏搬 `screens/`，那是 F-14 已经踩过一类的坑**）|
| G2 特判 | `fastpath-gate.mjs` L677 `kind === 'menu'` → fail | 一期照搬到 `kind === 'screens'`（**不参与快路径**）；放开它是 F-15e 单独评估，且判据按 §4.4 走 `evidence: static` + 可反查 `path:line`，**不按段名**（按段名会让门禁判据随新增段漂移） |

---

## 9. 分期（可停在任意一期）

| 期 | 范围 | 依赖 | 验收判据 |
|---|---|---|---|
| **F-15a** | 纯文本纠偏：§7 三处旧账的前两处与第三处（契约限定语、命令层说法）。**不动 schema、不动行为** | — | `sync --check` 全绿；无测试变化 |
| **F-15b** | schema v2（`screens.schema.yaml`）+ 渲染器 + `/supperH-init` 采集改造（discovery 数组化含 `via: code`、`hops` 可写、`parser: other` 泄压阀）+ 1→2 迁移器 + validate 纳入该文件 | — | ① 真跑 CLI 用例：老 `menus/<code>.yaml` 能机械升 v2；`parser: other` 无 `userPhrase` 退 2；未被选中的 `via` 整项不写。② **通用性判据：拿两个形状相反的项目（服务端渲染 + 数据库菜单表 / 前端路由表）跑同一个 L1，各自只改 `screens/<code>.yaml`、L1 一行不动，两边都能出产物**；任一边需要 L1 加分支 → 本期不通过。③ §5 那两条 profile 测试 |
| **F-15c** | **② 段**：`entry → 代码位置 → 模板工件` 这几跳的 hop 执行器（含 `prefixFrom` 读取）。纯代码，不碰 DB | b（需要 `hops` 槽位存在） | 在一个真服务端渲染型项目上解出的模板文件**存在率**如实报告（不承诺 100%）；解不出 → `incomplete` 而非猜 |
| **F-15d** | **③④ 段**：按 L2 规则从模板工件里抽 actions / dataSources / drilldowns | c（先有工件才知道去哪抽） | 每条抽取结果带 `path:line`；无规则时该段为空并报"未配置规则"，不报错 |
| **F-15e** | 分区与门禁：`screens` 分区落地 + **评估**是否让 `evidence: static` 且可反查的段进 G2 锚点 | d | 评估结论必须有 jsonl 真实样本支撑，否则维持"不参与"。**默认不放开** —— 放宽锚点门禁是 fail-open 方向，不能用设计漂亮来换 |

b/c/d 各自都要：schema + 校验 + 命令文本 + 走真实命令行的测试 + `architecture.md` 台账一条。**渲染类行为一律要有 `spawnSync` 真实 CLI 用例，只测渲染层等于没测**（这条已在这仓亏过一次）。

---

## 10. 未决事实（实现 F-15c 前需确认；缺了就 fail-closed，不猜）

**分工先说清**：下表第 2、3、4 项的事实**都在代码仓里，应由我自己扫代码判定**，不该问用户；只有第 1 项的值在数据库里、
而当前没有任何可读库通道，必须问。

| # | 要确认的 | 影响 | 缺了会怎样 |
|---|---|---|---|
| 1 | 表里那一列存的**到底是什么形态**：完整路由 / 无斜杠相对路径 / 带 `.do` `.action` 后缀（→ Struts 一代，映射不在注解而在配置文件）/ 视图名 / **模板路径本身** / 带 host 的完整 URL | 决定 ② 段**写哪几条 hop**（`view-name-from-controller` 这类跳是否根本存在），不是配置项而是路线选择 | 猜错 → 反查 **0 命中** → `entry: incomplete`、后面全断；一期白做。（此项只能问，见上）|
| 2 | Controller 到模板是**拼字符串**（`return prefix + "/a/b" + suffix`）、**写死全路径**、还是 `forward:` / 注解 | `template-from-view-name` 这条 hop 的 `rules` 形态，以及 `prefixFrom` 从 Java 常量还是从 XML 配置读 | 规则写不对 → 解出的路径不存在 → 整段 `incomplete`（不会误报，但会白学）|
| 3 | 按钮**带不带权限标识**、以什么形态带（标签属性 / class / JS 判断） | `extract.actions` 规则；并决定它是否真能反查后端注解 | 不带 → actions 只能靠"有 click 绑到某 url"这种弱判据，须如实降级为语料 |
| 4 | "下钻"具体指哪种：新 URL 跳明细页 / 同页另一接口展开子表 / 弹层 | `extract.drilldowns` 与 §6 形态；并决定**弹层算不算一条独立 screen** | 只能按三类各写一条规则，宁可多写也不要猜 |

这四项**只改 L2 规则内容（`hops` / `extract` 的 `rules`），不改本文的分层与形状**。所以命名与形状可以先定稿（即本文件），
不必等它们 —— 这正是本轮把"通用性"提前做掉的原因。

## 11. 明确不做（防范围蔓延）

- **不去自动点**：一期只读学习。触发真机/运行期行为归 `writes[].gate: confirm` 那条既有机制，且不可逆的一律按 R2 拒。
- **不做 runtime 采集**（真机点一遍才知道的那类）：即 §4.4 `evidence: runtime`，静态无从判定，进门禁必被 fail-closed，只配成语料。
- **不把视图技术名做成 L1 枚举**（`jsp` / `thymeleaf` / `vue` …）：那正是把"接口"漏掉的那种做法。技术选择只出现在
  L2 规则的 `desc` 与**可选**剖面名里（区别见 §5 不变式）。
- **不承诺按钮全集完整**：抽取是尽力而为，产物必须带覆盖率自证与 `incomplete` 标记。
- **不在 F-15a~d 里顺手放开 G2**：锚点门禁的放宽要独立评估（F-15e）。
- **不抽通用 hop DSL**：只实现本文列出的这几种 hop 动作（`rules` 匹配、`template` 拼路径、`prefixFrom` 取值），
  **不做图执行器、不做 DSL**。键依赖声明只用于**校验闭合**，不用于自动拓扑排序 —— 后者是过度设计的第一入口。
- **不在 F-15a~d 里预抽任何剖面**：等第二个真实形态落地（§5 末）。

## 12. 代价

- schema 走 `1 → 2` 破坏性变更，需要迁移器 + 一次实跑验证；`menu` 与 `screens` 两个分区会在一段时期内并存（读侧兼容，写侧只写新）。
- **列集合改动 = 代际升级 = 全部存量学习数据出局**（R4 明令禁止"加列不升代际"）。`render` → `template` 这类改名
  **必须与 v2 一次性做完**，不能分两轮 —— 分两轮就是两次清库。
- L2 用户要写正则（`rules[].match`）。这是"把规范权交回用户"的必然对价：不写规则的代价就是回到今天这个装不下按钮、
  进不了接口的模型。规则可以只有一条 `desc` + 一个 `match`，但必须**命名**。`profile` 是后来为削减这项代价准备的，
  不是前置条件。
- ②③④ 段的解析是**新增能力**，不是改造：`supperH-prelearn-analyzer` 要长出"视图方向"的解析（它现在学的是
  Controller→Service→DAO→Mapper 这个数据方向）。
- `resolve-project.mjs` / `init-project.mjs` 的 `LEARNING_KINDS`、writer 的写边界清单、清场清单都要同步扩，
  漏一处就出现"清场搬不干净"或"writer 拒写合法路径"这类静默缺陷。
- **一个剖面字段会触发"六处一致"**（schema / init 扫描 / validate / resolve-project / prompt / tests），多剖面后每处 ×N，
  这是腐化的主入口 —— 所以 §5 末把剖面推迟到第二个形态之后。
