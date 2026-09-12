# supperH 占位符清单（唯一真相源）

本文件列出 L1 仓库里所有**合法**的占位符。sync 阶段 `substitute()` 会按此表把 `{{...}}` 展开为真实值；未列入本表的 `{{...}}` 若在扫描中命中 → **exit 3 阻断**。

> 本文件放在 `docs/`，不在 `sync-assets.mjs` 的 `COPY_DIRS` 里，因此不会被替换扫描 —— 你可以放心在下面写原始 `{{...}}` 字面量作为示例。

## 1. 语法约定

- 双花括号 `{{` + `}}`，中间不允许出现换行、嵌套 `{` 或未闭合的 `}`
- 正则（sync 端）：`\{\{[^{}\n]+\}\}`
- 大小写敏感：`{{PROJECT.db.host}}` ≠ `{{project.db.host}}`
- 前后不允许有空格：`{{ PROJECT.db.host }}` 是**错的**（会命中残留但无法替换）

## 2. 根路径类（sync 时按当前机器解析）

| 占位符 | 展开为 | 来源 |
|--------|-------|------|
| `{{TOOL_ROOT}}` | 本仓库绝对路径 | sync 计算：`path.resolve(__dirname, '..')` |
| `{{PRIVATE_ROOT}}` | `<TOOL_ROOT>/../supper-Han-private` 绝对路径 | `scripts/resolve-private-root.mjs` |
| `{{DRIVERS_ROOT}}` | `{{PRIVATE_ROOT}}/drivers` | 由 PRIVATE_ROOT 拼接 |
| `{{CONTEXT_ROOT}}` | `{{PRIVATE_ROOT}}/context/{{PROJECT.identity.code}}` | 由 PRIVATE_ROOT + 注册条目拼接 |
| `{{TASKS_ROOT}}` | `{{PRIVATE_ROOT}}/tasks/{{PROJECT.identity.code}}` | 同上 |
| `{{SYNC_TIMESTAMP}}` | sync 运行时刻（ISO 8601） | sync 现取 |

**注意**：`{{CONTEXT_ROOT}}` / `{{TASKS_ROOT}}` 里内嵌了 `{{PROJECT.identity.code}}`；substitute() 会做**二级递归**（先解析 PROJECT.identity.code 再拼最终绝对路径），一次 sync 即可完成。

## 3. 项目字段类（`{{PROJECT.<dot.path>}}`）

来源：`{{PRIVATE_ROOT}}/projects/<code>.yaml`（`<code>` 由步骤 0 解析器按 cwd 选定；迁移期兼容单一 `{{PRIVATE_ROOT}}/project.yaml`），dot 路径按 `schemas/project.schema.yaml` 定位。

### 3.1 标量

| 占位符 | 对应注册条目路径 | 类型 |
|--------|----------------------|------|
| `{{PROJECT.schemaVersion}}` | `schemaVersion` | int |
| `{{PROJECT.identity.code}}` | `identity.code` | string |
| `{{PROJECT.identity.displayName}}` | `identity.displayName` | string |
| `{{PROJECT.codeRoot}}` | `codeRoot` | string (abs path) |
| `{{PROJECT.effectiveRoot}}` | `effectiveRoot` (可选；缺省 = codeRoot) | string |
| `{{PROJECT.packageRoot}}` | `packageRoot` | string |
| `{{PROJECT.build.tool}}` | `build.tool` | enum |
| `{{PROJECT.build.jdk}}` | `build.jdk` | string |
| `{{PROJECT.build.compileCmd}}` | `build.compileCmd` | string |
| `{{PROJECT.build.testCmd}}` | `build.testCmd` | string |
| `{{PROJECT.build.packageCmd}}` | `build.packageCmd` (可选) | string |
| `{{PROJECT.db.host}}` | `db.host` | string |
| `{{PROJECT.db.port}}` | `db.port` | int |
| `{{PROJECT.db.schemas.prod}}` | `db.schemas.prod` | string |
| `{{PROJECT.db.schemas.uat}}` | `db.schemas.uat` | string |
| `{{PROJECT.db.schemas.test}}` | `db.schemas.test` | string |
| `{{PROJECT.db.readonlyUser}}` | `db.readonlyUser` | string |
| `{{PROJECT.db.writableUser}}` | `db.writableUser` | string |
| `{{PROJECT.branches.prod}}` | `branches.prod` | string |
| `{{PROJECT.branches.uat}}` | `branches.uat` | string |
| `{{PROJECT.branches.dev}}` | `branches.dev` | string |
| `{{PROJECT.naming.commandPrefix}}` | `naming.commandPrefix` | string |
| `{{PROJECT.naming.logPrefix}}` | `naming.logPrefix` (可选) | string |

### 3.2 数组与 `[]` 展开

数组字段用 `[]` 后缀访问每个元素的对应字段，展开为逗号分隔字符串：

| 占位符 | 展开为 | 示例 |
|--------|-------|------|
| `{{PROJECT.identity.aliases[]}}` | 全部 alias 逗号拼接 | `myapp,myapp-legacy,mal` |
| `{{PROJECT.identity.workspaces[]}}` | 全部绑定工作区路径逗号拼接（解析器用它 + `codeRoot` 匹配 cwd；一般不在 prompt 里引用） | `D:/ws/a,E:/ws/b` |
| `{{PROJECT.modules[].name}}` | 全部 module 名逗号拼接 | `order,payment,user` |
| `{{PROJECT.db.forbidWriteSchemas[]}}` | 全部禁止写的 schema 逗号拼接 | `prod_schema,uat_schema` |
| `{{PROJECT.modules[].entryPattern}}` | 全部 entryPattern 逗号拼接 | `**/order/controller/*.java,**/pay/...` |

**按下标访问**（如需）：`{{PROJECT.modules[0].name}}` — 一期不启用（下标语义太脆弱）；如需请按 module 名显式列出。

### 3.3 驱动槽位

驱动槽位对象作为整体出现时（少见，多用于示例），展开为 JSON 字符串；常用的是 `.impl` / `.healthCheck` 子字段：

| 占位符 | 对应注册条目路径 |
|--------|----------------------|
| `{{PROJECT.drivers.database.impl}}` | `drivers.database.impl` |
| `{{PROJECT.drivers.database.healthCheck}}` | `drivers.database.healthCheck` |
| `{{PROJECT.drivers.logs.impl}}` | `drivers.logs.impl` |
| `{{PROJECT.drivers.tickets.impl}}` | `drivers.tickets.impl` |
| `{{PROJECT.drivers.efficiency.impl}}` | `drivers.efficiency.impl` |

其它槽位同理。`db` 与 `drivers` 两段（含 `drivers.database`）**都是可选的**：接不接外部数据源由用户决定，所以 L1 里引用 `{{PROJECT.drivers.logs.impl}}` 而某个项目没接 logs 时，**sync 不会报错**（它只把 `{{PROJECT.<dot.path>}}` 语法性地改写成 `${SUPPERH.PROJECT.<dot.path>}`，不看字段存在与否），事情在运行期才暴露：步骤 0 拿不到对应值 → 该处无内容可填，就得按“本项目未接入该源”报告而不是编一个值。**写 L1 时的纪律**：引用可选字段先想想纯代码模式该怎么办，并在同一段里写清“无此字段 = 未接入”的读法（参考 `commands/supperH-bug.md` 步骤 2）。

真正会被 sync 拦下（exit 3）的是**没被登记的任何 `{{...}}` 字面量**：写错大小写、带了空格（`{{ PROJECT.db.host }}`）、或用了不存在的裸 token。它们不会被第 2 步的 runtimeify 命中，于是作为残留被阻断。

**没有预检槽位**：`drivers` 下可用的槽位就是上表那四个（+ schema 为向后兼容而保留、但 L1 不得引用的废弃键 `vpnPreCheck`）。连通性只由各槽位自己的 `healthCheck` 退出码事后判定，所以 L1 也不存在「先探一次网络再决定跑不跑」的占位符需求（见 `docs/architecture.md` §10.8）。

**已展开的impl 就是绝对路径**：用户在 L2 里写 `impl: "{{DRIVERS_ROOT}}/x.py"`，解析器/ sync 会先把 `{{DRIVERS_ROOT}}` 深度展开（含 `healthCheck` / `config`）后才交给产物 —— 所以 L1 侧只能写 `{{PROJECT.drivers.<slot>.impl}}` 整体，**绝不能再拼一层 `drivers/` 前缀**（历史上拼过 → `.../supper-Han-private/drivers/{{DRIVERS_ROOT}}/x.py` 双前缀 + 未替换 token，只因 `drivers/` 为空目录而没炸）。

**不进入 L1 占位符的字段**：`kind` / `fallback` / `mcp.server` / `mcp.sources` 是运行期通道判定输入，由 `data-fetch` 的 resolve 段直接读解析器输出选定，**不烤进 prompt**（烤进去 = 把注册期的探测结论冻结在产物里，重探一次也改不动）。L1 里写 `{{PROJECT.drivers.<slot>.kind}}` 会被残留扫描拦下（本表未登记）。

**诊断基线也不是占位符**：`--env` 的返回体 `diagnoseBaseline = {declared, env, branch, schema, codeSide}` 每次调用现取 —— 环境来自用户当次的描述，不来自注册表（同一个项目今天查 uat、明天查 prod）。所以 L1 里**不存在也不得新增** `{{PROJECT.env}}` 这类占位符；`branches.*` / `db.schemas.*` 本身仍可按 §3.1 登记使用（它们是注册值）。两个基线的分界见 `docs/architecture.md` §10.9。

### 3.4 路径 override（可选）

| 占位符 | 对应注册条目路径 | 缺省行为 |
|--------|----------------------|---------|
| `{{PROJECT.paths.contextRoot}}` | `paths.contextRoot` | 缺省 = `{{PRIVATE_ROOT}}/context/{{PROJECT.identity.code}}` |
| `{{PROJECT.paths.tasksRoot}}` | `paths.tasksRoot` | 缺省 = `{{PRIVATE_ROOT}}/tasks/{{PROJECT.identity.code}}` |

L1 一般写 `{{CONTEXT_ROOT}}` / `{{TASKS_ROOT}}`（走 override 逻辑），不直接引用 `{{PROJECT.paths.*}}`。

## 4. 展开优先级

`substitute()` 内部按下列顺序处理，避免二级占位符嵌套失效：

1. 时间戳类：`{{SYNC_TIMESTAMP}}`
2. 根路径类：`{{TOOL_ROOT}}` → `{{PRIVATE_ROOT}}` → `{{DRIVERS_ROOT}}` → `{{CONTEXT_ROOT}}` → `{{TASKS_ROOT}}`（后两者内嵌了 `{{PROJECT.identity.code}}`，第 3 步会兜住）
3. 项目字段类：`{{PROJECT.<dot.path>}}` 全部；数组字段用 `[]` 展开
4. 若某个 `{{CONTEXT_ROOT}}` 内嵌的 `{{PROJECT.identity.code}}` 在第 2 步展开成中间态（`{{PRIVATE_ROOT}}/context/{{PROJECT.identity.code}}`），第 3 步会二次扫描完成最终化

**结果要求**：`substitute()` 返回时字符串里**不允许**再出现 `{{` 或 `}}`；否则 findResiduals 会命中并阻断。

## 5. 常见错误与修法

| 现象 | 原因 | 修法 |
|------|------|------|
| `sync: exit 3` + 残留 `{{PROJECT.db.host}}` 这类字面量 | 写法不合 runtimeify 规则：带了空格、大小写错、或 token 本身不存在 | 改成无空格、全大写的 `{{PROJECT.db.host}}`。**已正确写出的 `{{PROJECT.<path>}}` 不会造成残留**：它会被改写成 `${SUPPERH.PROJECT.<path>}`，字段存不存在是运行期的事 |
| 运行期 `${SUPPERH.PROJECT.drivers.logs.impl}` 无值可填 | 该项目未接入这个外部源（纯代码模式） | 不是错误：按“未登记”报告该步骤，不编造替代值（要接就走 `/supperH-init`） |
| 残留 `{{ CONTEXT_ROOT }}`（带空格） | 语法错误 | 改成 `{{CONTEXT_ROOT}}`（无空格） |
| 残留 `{{project.db.host}}` | 大小写错 | 改成 `{{PROJECT.db.host}}` |
| L1 里出现 `{{TOOL_ROOT}}/../supper-Han-private` | 用了相对路径 | 用 `{{PRIVATE_ROOT}}` 单一变量，别用 `..` |
| 展开后是空字符串（例 `modules[].name` 值为空数组） | 注册条目里数组为空 | schema 已 `minItems: 1`，理论上不会走到；如果发生说明校验绕过 → 报 bug |
| 运行期 `${SUPPERH.PROJECT.branches.uat}` 无值可填 | 该环境未登记分支映射（`git branch` 里没出现，用户也没答）| 不是错误： schema 已把 `branches` 改为可选（写了则 `required: [prod]`），未检出的键**不写盘**。按“未登记”报告，不得拿模板里的 `release-main`/`staging`/`develop` 当真值填（F-8）|

## 6. `.qoder/rules/**` 与 docs/** 特例

- `.qoder/rules/**` **不走 sync 替换**（clone 即生效，作为零配置通道）；因此 rules 文件里**严禁**任何 `{{` 字面量（写了也不会被展开，会作为字面 `{{` 进入 agent prompt，破坏语义）。描述项目字段时用自然语言："目标项目 code" 而不是 `{{PROJECT.identity.code}}`。
- `docs/**` 也不走 sync 替换（不在 `COPY_DIRS` 里）；本文件就是靠这个特例才能直接列出 `{{PROJECT.xxx}}` 作为示例。
- 同理 `scripts/**` 不进入替换 —— sync 脚本自身不能有占位符（写了也是字面字符串；`substitute()` 里出现的 `{{` 是**代码字面量**，会被正则匹配但因为没有对应 project 字段而不会替换，也不会被扫描）。**修改 sync 脚本时**要小心：脚本本身不在 COPY_DIRS 里，findResiduals 不会扫它，所以脚本里出现 `{{` 不会阻断。
- `mcp-skeleton/**` **在 COPY_DIRS 里**（要被拷进 dist 才能按插件相对路径启动），因此同样受替换 + 残留扫描约束；但它几乎全由 `.py` 构成 —— `.py` 里写 `{{TOKEN}}` 是**直接阻断级**地雷（不像 markdown 只坏语义：烤成绝对路径后 Windows 反斜杠在字符串字面量里是转义序列，`C:\Users\...\U` 会直接报 unicodeescape 错）。壳需要的私有根靠 `mcp-skeleton/private-root.txt` 指针文件带外拿，路径推导全在 `supperh_contract/private_root.py` 里用 env + `os.path` 完成。

## 7. 添加新占位符的流程

如果 L1 需要一个新的项目字段（例：`{{PROJECT.deploymentRegions[]}}`）：

1. **改 schema**：`schemas/project.schema.yaml` 里加 `deploymentRegions: { type: array, items: {...} }`
2. **改 example**：`schemas/project.example.yaml` 里加对应假数据
3. **改本表**：`docs/placeholders.md` § 3 里登记
4. **改 sync**（如果需要新语义）：`scripts/sync-assets.mjs` 的 `substitute()` 已通用地读 `getPath(project, dotPath)`，一般不用改；只有涉及二级递归或数组展开规则变化才动
5. **在 L1 agent/command 里使用**：`{{PROJECT.deploymentRegions[]}}`
6. 跑 `node scripts/sync-assets.mjs --check` → 确认展开符合预期
7. `node scripts/sync-assets.mjs` → 落 dist

**破坏性**变更（删字段 / 改语义）：升 `schemas/project.schema.yaml` 的 `schemaVersion.const` +1；sync 阶段会做兼容检查，老注册条目会阻断要求用户改。

## 8. 反查：L1 文件里所有占位符使用位置

```bash
# 查看仓库里所有 {{...}} 出现位置（用于评审变更范围）
grep -REo "\{\{[^{}]+\}\}" agents commands skills schemas drivers-skeleton mcp-skeleton | sort -u
```

结果按类别汇总：

- **根路径类**（`TOOL_ROOT` / `PRIVATE_ROOT` / `DRIVERS_ROOT` / `CONTEXT_ROOT` / `TASKS_ROOT` / `SYNC_TIMESTAMP`）：出现在所有 `agents/*`（前置自检里的 `node "{{TOOL_ROOT}}/scripts/sync-assets.mjs"` 引导行）、5 个 `commands/*`、`skills/*/SKILL.md`、`drivers-skeleton/*`；`mcp-skeleton/*` 应该 **0 命中**（见 §6 的 `.py` 地雷）
- **项目字段类**（`PROJECT.<dot.path>`）：出现在所有 agents / commands / skills；具体路径见 §3；`grep -REo "\{\{PROJECT\.[^{}]+\}\}" agents commands skills` 可直接列出

## 9. 纯度扫描（与占位符无关，但同在 sync 里拦）

替换只保证“该展开的展开了”，保证不了“不该写的没写”。于是 `sync` / `sync --check` 额外跑一道
`checkL1Purity()`（**退 5，两侧都阻断：`--check` 与实际构建 dist 之前**）：

| 判据 | 来源 | 命中例子 |
|------|------|---------|
| 上传物里出现注册条目的**专有值** | 递归 `<PRIVATE_ROOT>/projects/*.yaml`（+ legacy `project.yaml`）的 `identity.code` / `displayName` / `aliases[]` / `packageRoot` / `codeRoot` / `db.host` / 三个库名 / 两个账号 / `forbidWriteSchemas[]` | 项目叫 `acme` 则 `acme`、`acme-base`、`acme_order`、`ACME` 均拦（边界只看字母数字，大小写不敏感） |
| 上传物里出现**本机绝对路径** | `PRIVATE_ROOT`、仓库父目录、家目录，两边先做斜杠展平 | `C:\a\b` / `C:/a/b` / 源码字面量里的 `C:\\a\\b` 同判 |

三条会让门禁变成噪声的东西被故意排除：

- **不写硬黑名单**：把“某公司名”抄进 deny 列表等于把该公司名再公开一遍；值只能从 L2 运行期取。
- **不拿模块名/分支名当事实**：`order` / `dev` 这类高复用词会淹没信号（schema 名不带环境后缀时才参与比对）。
- **不拿示例形态值当事实**：按**段**过滤 `example` / `demo` / `sample` / `<占位符>` 这类，否则 `schemas/project.example.yaml` 自己就会天天误报。

确实撞车（注册项目的某个值与 L1 用词相碰）时用 `--allow-l1-fact <值>`（可重复）显式放行；
该旗标缺值 → 退 2（参数缺失不得被当成“没请求”而静默放行）。

历史注脚：`drivers-skeleton/README.md` 与本仓红线一直宣称“sync 阶段的敏感字扫描会拦下”，
而这条扫描在此前**从未存在** —— 真实项目短码、真实包根、真实工作区路径因此成片躺在测试夹具
与示例里，直到一次对外发布前的全量人工扫描才被发现。现在它是退 5。

## 10. 一句话总结

**只有 3 类占位符**：根路径 + 项目字段 + 时间戳；**只有 1 种语法**：双花括号无空格；
**两道防线**：sync 阶段的残留阻断（管“该展开的没展开”）+ 纯度扫描（管“不该写的写了”，退 5）；
agent 自检只是二级兜底，不是主防线。
