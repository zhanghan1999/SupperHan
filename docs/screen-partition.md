# F-15 · 页面档案模型（screen partition）· 设计定稿

**状态**：设计已定稿，**代码一行未动**。分期计划见 §8。
**起因**：真实使用场景（一个服务端渲染 + 单体页面的老 Java Web 项目）要求"接口 ⊕ 数据库两者结合才能看出菜单和按钮"，
而现有菜单模块在结构上只能表达"单一来源、一棵导航树、四列"。不是配置没配好，是模型装不下。

> **纯度提醒（改本文件前必读）**：本文件在 `L1_SCAN_DIRS` 名单内，`node scripts/sync-assets.mjs --check`
> 会把注册条目的 `identity.code` 等专有值当事实逐字比对（长度 ≥ 3 即参与）。所以全文用 `<code>` / `demo`
> 指代，**不许出现任何真实项目短码、库名、表名、包根、本机路径**。样例里的 `demo:order:add` 这类权限串是
> 编的形态示例，不是任何一个真项目的值。

---

## 1. 现有模型覆盖到哪一段

一条真实的"用户看到一个页面"的链，共四段：

| 段 | 内容 | 介质 | 现有模型 |
|---|---|---|---|
| ① | 页面清单：中文名 + 入口路径 | **数据库表**（或下发菜单的接口） | ✅ 唯一被支持的一段 |
| ② | 入口路径 → Controller 方法 → **视图工件**（那个服务端模板文件） | Java 代码 | ❌ 无 |
| ③ | 视图文件里的**动作**（按钮 / 链接 / 批量）、各自的**权限标识**、以及页面运行时打的**数据接口** | 模板文本 + JS | ❌ 无 |
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

`menu` 保留为 **legacy 别名 + 只发警告**（见 §7）。

## 3. 一个 screen 的六段形状

| 段 | 装什么 | 来源 | 能否机械反查到可改工件 | 进锚点资格 |
|---|---|---|---|---|
| **identity** | 页的中文名、稳定 id | 发现器（① 段） | 否（是名字不是工件） | ❌ |
| **entry** | 入口路径 → Controller 方法 fqn | 发现器给路径 + 代码反查 | ✅ `path:line` | ✅ |
| **render** | 视图工件的仓库内路径（那个模板文件） | 代码解析 + L2 映射规则 | ✅ | ✅ |
| **actions** | 页上动作：按钮 / 链接 / 批量 + 各自的权限标识 + 点了打哪个接口 | 模板抽取（L2 规则） | ✅ | ✅（权限串可反查后端注解与前端指令） |
| **dataSources** | 页面运行时接口（表格、字典、下拉、上传）→ 各自背后的 Controller | 模板抽取 + 代码反查 | ✅ | ✅ |
| **drilldowns** | 下钻目标（另一个 screen 的入口 / 弹层 / 导出） | 模板抽取 | ✅ | 一期 ❌（见 §8 F-15e） |

三条关键转变：

1. **每段独立来源、独立可缺**。不再问"数据库还是代码"—— identity 从库里来，render / actions / dataSources 从代码里来。
   "多来源怎么合成"这个伪问题随之消失：它压根不是同一份数据的多个来源，而是**不同段各有来源**。
2. **只有 identity 一段依赖外部通道**。推论（重要，因为它改变优先级）：**一个驱动都没登记的项目，也能立刻学到
   entry / render / actions / dataSources 四段**（全在代码仓里，纯静态解析），只是少了页面的中文名。
3. **能反查到工件的段才有资格进锚点**。与既有的"按来源类别决定门禁落点"同纪律：反查不到的只成语料，永不进门禁。

---

## 4. L1 / L2 边界：规则归用户，L1 只规定"必须有规则、不许猜"

提一句设计约束的来源：`format: json|sql|properties|router` 这种 L1 内置枚举，就是今天把"接口"漏掉的成因。
所以 ②③ 段的解析能力**一律不做成 L1 枚举**，做成 L2 声明的规则；L1 只保证三件事：规则必须命名、必须带 `desc`、
命中结果必须带 `path:line` 出处。换视图技术只改 L2，L1 一行不动。

`menus/<code>.yaml` → 改名 `screens/<code>.yaml`（与 §7 的兼容策略一并处理）。目标形状（字段名以此为准）：

```yaml
schemaVersion: 2
project: <code>

# ── ① 发现器（discovery）：可 0..N 个，逐项声明它贡献哪几列 ──────────────
discovery:
  - via: database                 # database | driver | artifact（三类介质，不是来源名单）
    slot: <可选>                  # 缺省 = role: database 那个槽位；名字归用户，不得写死
    source: <driver 逻辑源名>      # 须在该槽位 config.sources 里声明
    table: <菜单表名>
    columns:                      # 权限列与类型列在这里才第一次有了位置
      id: <列名>
      parentId: <列名>
      name: <列名>
      path: <列名>                # 必填：页面指向路径
      type: <列名>                # 可选：目录 / 菜单 / 按钮 的区分列
      typeValues: { group: <值>, page: <值>, action: <值> }   # 可选：值 → 语义映射
      perms: <列名>               # 可选：权限标识列（动作段的主料）
      order: <列名>
    rootParentId: <可选>
    extraFilter: <可选，仅 SELECT 的 WHERE 片段>
    limit: 5000
  - via: driver                   # 新增这一类：接口型发现器（旧模型完全不能表达）
    slot: <已登记的槽位名>
    source: <逻辑源名>
    map: { name: <返回体里的键路径>, path: <键路径>, perms: <键路径> }
  - via: artifact                 # 原 code 支改名并保留能力
    path: <仓内文件或目录>
    parser: json | sql | properties | router | other
    userPhrase: <parser=other 时必填：一句话说清它是啥、怎么解析>
    map: { id: <键>, name: <键>, path: <键> }

# ── ② 呈现解析（render）：入口 → 视图工件。这一跳是全新能力 ──────────────
render:
  viewPathRules:                  # 1..N 条；一个仓有多套前缀/后缀就写多条
    - desc: "后台模块：prefix + 视图名 + 后缀"
      from: "{codeRoot}/<webapp 目录>/<prefix>/{viewName}/<module>"   # {viewName} = Controller 返回语句里解出的视图名
    - desc: "前台模块：另一套拼法"
      from: "{codeRoot}/<另一个目录>/{viewName}"

# ── ③④ 页内抽取（extract）：规则全部由 L2 给，L1 不解释其内容 ────────────
extract:
  actions:                        # 动作（按钮 / 链接 / 批量）
    - desc: "带权限标识的按钮标签"
      match: '<某个权限标签 [^>]*name="([^"]+)"[^>]*>([^<]+)<'
      capture: { perms: 1, label: 2 }
  dataCalls:                      # 页面运行时打的数据接口
    - desc: "JS 里以 url 字面量发起的异步请求"
      match: "(?:url|\\.post|\\.get)\\s*\\(\\s*['\"]([^'\"]+)"
      capture: { route: 1 }
  drilldowns:                     # 下钻（一期只存不用于锚点）
    - desc: "跳转型链接"
      match: '<a [^>]*href="([^"]+)"'
      capture: { route: 1 }
```

**L1 硬性要求（写进 schema 与校验，不靠提示词）**：

- `discovery` 可为空数组（= 无发现器，纯靠代码扫路由），但**一旦有项，`via` 必填**；`via` 只有三类**介质**，
  不含任何产品名或技术栈名。
- `render.viewPathRules[]` 与 `extract.*[]` 每项**必须**有 `desc`：说不清它在抓什么，就不配进产物。
- `extract.*[].match` 是 L2 的正则，L1 不校验其语义（校验不了），只校验：能编译、捕获组号不越界、条数有上限（防跑飞）。
- **未命中不许造**：任何一段抽不出内容 → 该段如实为空并带 `incomplete: true`（沿用 analyzer 已有的
  `sources_incomplete` 纪律），**禁止**为凑完整性猜一个按钮名或接口路径。

---

## 5. 产物形状

```
{{CONTEXT_ROOT}}/<code>/screens/gen-<ts>/
  ├── index.md          # 反查表：route / 视图工件 / 动作数 / 数据接口数 / 出处
  ├── batch-NN.md       # 一个页面一段：六项齐全或如实标缺
  └── CURRENT           # 代际指针
```

`batch` 正文的每个页面必须能回答这五个问题，且**每条都带出处**：

```
## <页面中文名 或 route>
entry:       <route>  →  <Class#method>   <file>:<line>
render:      <视图工件仓库内路径>            （解自 <viewPathRules 第几条>，<file>:<line>）
actions:     <按钮名>  perms=<权限标识>      <模板文件>:<line>
             …… 或 `actions: (none found) incomplete: true`
dataSources: <route>  ← <Class#method>      <模板文件>:<line>
drilldowns:  <route> → 另一个 screen / 弹层   <模板文件>:<line>
```

`index.md` 的 frontmatter `kind: screens`。**权限标识（perms）的价值**：它是这条链上唯一能同时锚住
"前端那个按钮"与"后端那个 `@PreAuthorize` / 权限注解"的稳定字符串 —— 有了它，动作段才真能进反查表。

---

## 6. 顺带修掉的三处旧账

| 处 | 问题 | 修法 |
|---|---|---|
| `skills/supperH-driver-contract/SKILL.md` §菜单查询 | 首句"菜单学习复用**数据库通道**"没有前提限定语 —— 它整节讲的是 `source: database` 这一支，但读者（含模型）会读成全局断言。本轮已有人被它带偏一次 | 补限定："当 `discovery[].via == database` 时……"，并明确另一句"接口型来源走该 discovery 项登记的 driver 槽位，不经数据库通道" |
| `validate-project.mjs` **不读** `menus/*.yaml` | `source: database` 但项目没有 `role: database` 槽位 → 写盘时无人拦，只有运行期撞上"不得猜一个驱动先跑着"才停。`architecture.md` L470 已认账："这一**跳文件**一致性目前无人机械拦" | v2 落地时把 `screens/<code>.yaml` 纳入 validate：`via: database/driver` 引用了不存在的槽位或未标 `role` 的槽位 → **警告**（纯代码模式合法，不阻断）；`config.sources` 里没声明所引用的逻辑源名 → 同样警告 |
| `menu` 与 `screen` 两个词并存 | 迁移期会出现"菜单学习"与"页面学习"两种说法 | 命令层统一说**页面学习**；`--menu` 旗标保留为别名并提示改用 `--screen`；`/supperH-learn` 的模式表里 `menu` 行整行改写 |

---

## 7. `menu` 这五处硬编码怎么处理

早前已定过一条决策：不能简单 rename，因为 `menu` 至少硬编码在五处。逐条落实：

| 处 | 现值 | 处理 |
|---|---|---|
| 保留分区名 `module: "menu"` | `commands/supperH-learn.md` L68 | 新增并列保留分区 `screens`；`menu` 分区**只读兼容**（老产物照样能读），新学习一律写 `screens` |
| 首次注册硬门禁 **22** | `init-project.mjs` 的 `menu-source-required` | 语义放宽为"**发现器可为空，但必须显式回答**"：完全没答 → 仍退 22；答"从代码路由表发现、没有中文名" → 合法通过 |
| driver 保留源名 `menu` | `driver-contract` §菜单查询 | 不变（它仍是 `via: database` 那一类的默认逻辑源名）；只是不再是唯一选项 |
| `CONTEXT_ROOT` 分区 | `resolve-project.mjs` 路径解析 | 加一个 `screens` 子分区，与 `menu` 并列；`paths.*` 覆写与 F-14 清场的 `LEARNING_KINDS` 同步扩（**否则清场会漏搬 `screens/`，那是 F-14 已经踩过一类的坑**）|
| G2 特判 | `fastpath-gate.mjs` L677 `kind === 'menu'` → fail | 一期照搬到 `kind === 'screens'`（**不参与快路径**）；放开它是 F-15e 单独评估，不在本设计范围内顺手做 |

---

## 8. 分期（可停在任意一期）

| 期 | 范围 | 依赖 | 验收判据 |
|---|---|---|---|
| **F-15a** | 纯文本纠偏：§6 三处旧账的前两处（契约限定语、命令层说法）。**不动 schema、不动行为** | — | `sync --check` 全绿；无测试变化 |
| **F-15b** | schema v2（`screens.schema.yaml`）+ 渲染器 + `/supperH-init` 采集改造（discovery 数组化、`parser: other` 泄压阀）+ 1→2 迁移器 + validate 纳入该文件 | — | 真跑 CLI 用例：老 `menus/<code>.yaml` 能机械升 v2；`parser: other` 无 `userPhrase` 退 2；未被选中的 `via` 整项不写 |
| **F-15c** | **② 段**：`entry → Controller 方法 → 视图工件` 这一跳。纯代码，不碰 DB | b（需要 `render` 规则槽位存在） | 在一个真 JSP 型项目上解出的视图文件**存在率**如实报告（不承诺 100%）；解不出 → `incomplete` 而非猜 |
| **F-15d** | **③④ 段**：按 L2 规则从视图工件里抽 actions / dataSources / drilldowns | c（先有工件才知道去哪抽） | 每条抽取结果带 `path:line`；无规则时该段为空并报"未配置规则"，不报错 |
| **F-15e** | 分区与门禁：`screens` 分区落地 + **评估**是否让 entry/actions 进 G2 锚点 | d | 评估结论必须有 jsonl 真实样本支撑，否则维持"不参与"。**默认不放开** —— 放宽锚点门禁是 fail-open 方向，不能用设计漂亮来换 |

b/c/d 各自都要：schema + 校验 + 命令文本 + 走真实命令行的测试 + `architecture.md` 台账一条。**渲染类行为一律要有 `spawnSync` 真实 CLI 用例，只测渲染层等于没测**（这条已在这仓亏过一次）。

## 9. 未决事实（实现 F-15c 前必须由用户确认；缺了就 fail-closed，不猜）

| # | 要确认的 | 影响 | 缺了会怎样 |
|---|---|---|---|
| 1 | 表里那一列存的到底是不是最终 URL（还是带 `/xxx` 前缀、还是相对路径） | c 的入口反查 | 反查零命中 → `entry: incomplete`，后面全断 |
| 2 | Controller 到模板是**拼字符串**（`return prefix + "/a/b" + suffix`）、**写死全路径**、还是 `forward:` / 注解 | c 的 `viewPathRules` 形态 | 规则写不对 → 解出的路径不存在 → 整段 `incomplete`（不会误报，但会白学） |
| 3 | 按钮**带不带权限标识**、以什么形态带（标签属性 / class / JS 判断） | d 的 `extract.actions` | 不带 → actions 只能靠"有 click 绑到某 url"这种弱判据，须如实降级为语料 |
| 4 | "下钻"具体指哪种：新 URL 跳明细页 / 同页另一接口展开子表 / 弹层 | d 的 `extract.drilldowns` 与 §5 的形态 | 只能按三类各写一条规则，宁可多写也不要猜 |

这四项**只改 L2 规则内容，不改本文的分层**。所以命名与形状可以先定稿（即本文件），不必等它们。

## 10. 明确不做（防范围蔓延）

- **不去自动点**：一期只读学习。触发真机/运行期行为归 `writes[].gate: confirm` 那条既有机制，且不可逆的一律按 R2 拒。
- **不做 runtime 采集**（真机点一遍才知道的那类）：静态无从判定，进门禁必被 fail-closed，只配成语料。
- **不把视图技术名做成 L1 枚举**（`jsp` / `thymeleaf` / `vue` …）：那正是把"接口"漏掉的那种做法。技术选择只出现在 L2 规则的 `desc` 里。
- **不承诺按钮全集完整**：抽取是尽力而为，产物必须带覆盖率自证与 `incomplete` 标记。
- **不在 F-15a~d 里顺手放开 G2**：锚点门禁的放宽要独立评估（F-15e）。

## 11. 代价

- schema 走 `1 → 2` 破坏性变更，需要迁移器 + 一次实跑验证；`menu` 与 `screens` 两个分区会在一段时期内并存（读侧兼容，写侧只写新）。
- L2 用户要写正则（`extract.*[].match`）。这是"把规范权交回用户"的必然对价：不写规则的代价就是回到今天这个装不下按钮、进不了接口的模型。规则可以只有 `desc` + 一条 `match`，但必须**命名并自带说明**。
- ②③④ 段的解析是**新增能力**，不是改造：`supperH-prelearn-analyzer` 要长出"视图方向"的解析（它现在学的是 Controller→Service→DAO→Mapper 这个数据方向）。
- `resolve-project.mjs` / `init-project.mjs` 的 `LEARNING_KINDS`、writer 的写边界清单、清场清单都要同步扩，漏一处就出现"清场搬不干净"或"writer 拒写合法路径"这类静默缺陷。
