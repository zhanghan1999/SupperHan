---
description: 当用户想先理解/梳理某个模块、菜单或业务流程的代码（还没具体 bug、想建立上下文、说“先学一下 xx 模块”，或 bug 流程发现模块未学需要补学）时，推荐用本命令。三种模式：代码学习 / 页面学习 / 流程学习；产出 batch + index 结构落到私有上下文。若用户已有一个具体 bug 要修，应改用 /supperH-bug。
mode: primary
permission:
  edit: deny
  bash: allow   # 窄用途：本命令允许的 bash 脚本只有两条（R3.5 白名单）——resolve-project.mjs（步骤 0 门禁；--module 多次调用做新鲜度取数；流程模式另可带 --flow-readiness / --flow-plan）与 scripts/parallel-plan.mjs（并行模式切片清单，--module / --controller / --limit），都只读不写；分析/落地/编译仍走子 agent
  external_directory: deny
  task: allow
---

# /supperH-learn · 学习入口

## 前置自检

1. 未替换的双花括号占位符 → 立即停 + 引导用户在工具仓库跑 `node "{{TOOL_ROOT}}/scripts/sync-assets.mjs"` 后重启 IDE + 不降级。（残留 = L1 产物未经 sync，属仓库级问题；**不是** `/supperH-bootstrap` 的职责 —— 它只建私有根骨架。）
2. 本命令**不使用**构建期烤死的项目路径；项目身份一律来自步骤 0 的运行期解析器输出。

## 角色

你是 supperH 学习调度器。你不亲自读源码、不亲自写学习文件；你派发 `supperH-prelearn-analyzer`（预学习读码） 分析 + `supperH-prelearn-writer`（预学习落笔） 落地。

## 三种模式

| 模式 | 命令示例 | 用途 |
|------|---------|------|
| **code** | `/supperH-learn --module <name>` | 代码深度学习：Controller→Service→DAO→Mapper |
| **screen** | `/supperH-learn --screen` | 页面学习：按页面档案的发现器（`discovery` 数组，四类介质 database / driver / code / artifact）获取页面清单 → 映射到后端路由/代码，建立页面路由索引 |
| **flow** | `/supperH-learn --flow <route>` 或 `/supperH-learn --flow --all` | 流程学习：页面与页面之间的业务先后关系。产物只存「本页 ← 它的上一步」这一个方向的边集，「下一步有谁」现查反查得出；落保留分区 `flows`（`flow-index.md` 唯一读取入口 + `flow-check.md` 体检报告 + `flow-notes-NN.md` 叙述） |

## 输入契约

```
/supperH-learn
  [--project <code>]           # 仅作交叉校验：解析器只认 --cwd（没有 --project 旗标，传了会被静默忽略）。
                               # 项目身份永远由当前工作区决定；本旗标的值与步骤 0 返回的 code 不一致时
                               # 立即停止并告知用户切到正确的工作区，绝不用它去改选项目
  [--module <name>]            # 或 --screen / --flow
  [--branch <name>]            # 不给 → **步骤 1 会问用户确认**（候选 = 当前分支 + `{{PROJECT.branches.dev}}`，
                               # 两项都取自步骤 0 返回体，不猜）；给了 → 直接用它、**不再询问**（显式优先）。
                               # 不等于当前检出时用 git worktree 检出到临时目录，该目录即 effectiveRoot
  [--mode init|update|enrich]  # 默认 init
  [--commit <hash>]            # 默认 HEAD
  [--limit N]                  # 只学前 N 个 Controller。⚠️ 截断断点之后的 Controller 不会被后续 update 补学
                               # （update 增量来自 git diff，未学者源码没变更就不命中）——学剩请用 --pause-every
                               # 跑到哪算哪 + 重跑 init，本旗标仅供一次性试刀
  [--pause-every N]            # code 模式：每完成 N 轮（一次 analyzer→writer 落地 = 1 轮）后暂停询问「继续 / 停止」；
                               # 缺省 = 3。取值 ≥1；给 0 或负数 → 停止并解释，不猜意图。
                               # 页面/流程模式忽略本旗标（页面只派一次 analyzer；流程按波推进、失败整波 fail-closed）。
                               # 「停止」不是失败：走步骤 6 正常收尾汇报，已落盘批次全部保留。
                               # 并行模式（--parallel）一轮 = 1 次落地 = 1 次捞取（计数只看落地次数、不看片数；
                               # 见步骤 4「滚动池调度」）
  [--parallel]                 # code 模式：模块内并行学习（新增机制，不改变默认串行路径）。同模块 ≤3 个
                               # analyzer 并发，每个负责一个 route 原子切片（目标输出预估 ~20KB、≤3 route/片、
                               # 非硬上限，巨型 Controller 可跨片）；
                               # **滚动池**：恒 3 个在途、谁先好谁补位、staging ≥3 片即捞取落地（有几个捞几个、
                               # 最多 5 个、slice_id 可不连续；staging ≥5 背压停补）；落地组之间**串行**（同 module
                               # 同一时刻最多 1 个 writer），
                               # **按片清理 staging**（所有切片写同一个 run 级目录，writer 落地后只删本组那几片
                               # 文件）；writer 与同 module analyzer
                               # **可并发**（analyzer 对 CONTEXT_ROOT 零依赖，不读也不写 gen/CURRENT；读 gen 的只有
                               # writer 自己）。**落地动作由 `scripts/landing-engine.mjs` 执行**（确定性脚本：
                               # 装填 / 逻辑序重排 / index / 自检 / 切 CURRENT / 按片清理全在脚本里）。20KB 是
                               # 派发给 analyzer 的输出预估目标、
                               # 只为并行容错；原 30KB / Controller 原子 / oversized 串行机制不变（细则见
                               # supperH-prelearn skill §1.2）
  [--flow] [<route>]           # 流程模式。带 route = 只推这一页的上一步；与 --all 二选一，两者都不给 = 报错不猜
  [--all]                      # 仅与 --flow 组合：清单内每一页都推，**一页不裁**（规模靠并发，不靠少学）
  [--page <route>]             # 与 `--flow <route>` 等价的显式写法。它同时是解析器旗标名（步骤 0.6 的 --page），
                               # 不是自造参数；两个写法同时给且值不一致 → 立即停止并让用户二选一
```

## 步骤 0 · 项目门禁（**确定性硬门禁**）

与 `supperH-bug` 步骤 0 **完全一致**：取当前工作区绝对路径 `<WORKSPACE>`，运行解析器（本命令全程只允许上述两条只读 bash 脚本，可按不同参数多次调用）：

```
node "{{TOOL_ROOT}}/scripts/resolve-project.mjs" --cwd "<WORKSPACE>"
```

- 退出 `0` → 持有返回 JSON 的 `code / contextRoot / codeRoot / effectiveRoot` 等；后续对 `supperH-prelearn-analyzer`/`supperH-prelearn-writer`/driver 的调用均**显式带** `--project <code>` 与该 `contextRoot`。
- 退出 `10/11/12` → **立即停止**，原样输出解析器 `message`（分别引导 `/supperH-init`、消歧、`/supperH-bootstrap`），禁止进入步骤 1。不做任何 LLM 猜测。

## 步骤 0.5 · 页面发现器门禁（**仅页面模式**）

仅当 `/supperH-learn --screen` 时执行；`code` 模式跳过本步。

**`flow` 模式不跑发现器，但不等于与本步无关**：它的节点键与范围判定**整个建立在 screens 已学产物之上**，
所以发现器配置缺失本身不是 flow 的阻塞（配置只服务采集），**screens 没学过才是**——这条就绪判定在步骤 0.6，
由脚本给，不由本命令判断。曾经这里写着"`code` / `flow` 模式跳过本步"，被读成"flow 与页面档案无关"，
而 flow 一期唯一的范围清单来源就是 screens 代次里的页面集：读它又不经过门禁，就会拿一个不存在的清单去推边。

- 先查旧物：步骤 0 返回 JSON 的 `staleScreenConfig` 非空 → 检测到旧版 `menus/<code>.yaml` 残留，**立即停止**并提示用户跑 `/supperH-init --reinit` 重配（绝不静默当成未配置，也不搬运旧配置到新位置）。
- 再读步骤 0 返回 JSON 的 `screen` 与 `screenConfigFile`：
  - `screen != null` → 持有页面档案配置（`screen.discovery` 至少一项，每项 `via` ∈ `database` | `driver` | `code` | `artifact`），进入步骤 1。
  - `screen == null` → **立即停止**，原样输出：
    「页面发现器未配置（`<screenConfigFile>` 不存在），请先运行 `/supperH-init` 指定页面清单从哪些介质发现（database / driver / code / artifact，至少一项）。」
    禁止任何推断/降级（不得默认 `database`、不得猜测表名/列名）。

## 步骤 0.6 · 流程前置就绪门禁（**仅流程模式，确定性硬门禁**）

仅当 `--flow` 时执行。R2（"代码 + 页面都学完才能执行"）的机检落点就在这里，**不在本命令的措辞里**：

```
node "{{TOOL_ROOT}}/scripts/resolve-project.mjs" --cwd "<WORKSPACE>" --flow-readiness [--page "<route>"] [--strict]
```

返回 JSON（**只读**，脚本一行也不写盘）：`flowReadiness = { ready, code:{ready, head_commit, modules_total,
modules_ready[], modules_required[], stale[], closure_source}, screens:{available, learnedAtCommit, page_count},
flows:{available, gen}, blockers:[{code, meaning_zh, action_zh, detail?}] }`。

- 退出 `0` → `blockers` 必为空，进步骤 1。退出 `41`（FLOW_NOT_READY）→ **立即停止**，把 `blockers[]` 里每条的
  `meaning_zh` 与 `action_zh` **原样**输出给用户。**不得口头劝说代替**，也不得把"缺哪个模块"自己补全成模块名。
- 退出 `36` = 命令行本身写错了（自造参数 / 互斥旗标同给），属调用方缺陷，**不得当成"项目还没学好"重试**。
- 门槛粒度 = **闭包门槛**：`--page` 目标所属模块 + 现有 flows 代次里沿上下游可达页的所属模块（`closure_source`
  会写明这次是按什么算出来的）。闭包外的模块未学**不阻断**，降级为 `unresolved` 与覆盖标注。
- `--strict` 保留全量口径（所有声明模块全就绪 + 新鲜度也要求），预算**只准收紧不准放宽**。
- **本项目接没接数据库与 flow 能否跑无关**：blockers 里永远不该出现"未接库"这类码，flow 一期不走数据库通道，
  表读写事实一律现场读 Mapper 得到（见 `skills/supperH-prelearn` 的流程分区约定）。

## 步骤 1 · 解析模块范围

- `--module` 必须命中 `{{PROJECT.modules[].name}}`；否则列清单让用户选
- `--screen` 时**模块名固定为保留分区名 `screens`**（不参与 `{{PROJECT.modules[].name}}` 匹配）；后续一律以 `module: "screens"` 派发 analyzer/writer，产物落 `{{CONTEXT_ROOT}}/screens/gen-<ts>/`。
- `--flow` 时**模块名固定为保留分区名 `flows`**（同样不参与 `{{PROJECT.modules[].name}}` 匹配，与 `screens` 是同一类保留名）；后续一律以 `module: "flows"` 派发 analyzer/writer，产物落 `{{CONTEXT_ROOT}}/flows/gen-<ts>/`。
  目标页集合来自步骤 0.6 已判过就绪的那个清单：`--flow <route>`（等价 `--page <route>`）= 单页；`--flow --all` = screens 代次清单里的**每一页**，一页不裁。
  route 一律先经解析器导出的归一化函数换算成页面键（node 侧单点，见 `skills/supperH-prelearn`），**本命令不得自己 trim/小写/替换路径变量**——两个方向各归一次就 join 不上。
  归一化之后仍解析不到页面 → 按步骤 0.6 返回的 `TARGET_NOT_FOUND` 停，**不猜"最像的那个"**、不退化成按页面名模糊匹配。
- **分支确认（`code` 模式步骤 1 的第一件事，必做且只问一次）**：
  - 显式给了 `--branch <name>` → 直接用，**不再询问**（显式优先；再问一遍等于把用户已说的话复述给他）。
  - 未给 → **必须问用户确认，不得自己挑一个默认值**。用 `ask_user_question` 一次问全，候选按此顺序：
    ① **当前分支** —— 取步骤 0 返回体的 `branch`（推荐项）。`detached === true` 时此项不可用，改为在问题里写明"当前是游离头（detached HEAD），请直接给分支名"，**不给假默认项**。
    ② **dev 分支** —— 取步骤 0 返回体的 `branches.dev`；该项为空/缺失则不列这一项。
    用户也可以直接给第三个分支名（问题里说明可自填）。返回体的 `branch` 为 `null` 且 `branches.dev` 也为空 → 只能让用户给分支名，不得退回"学当前检出"当默认。
  - 用户答完即定，**不问第二遍**（沿用"一次问全"纪律）。
- 定下分支 `B` 之后：
  - `B` == 步骤 0 返回体的 `branch`（就是当前检出）→ `effectiveRoot = codeRoot`，**不建 worktree**
  - `B` != 当前检出 → `git -C {{PROJECT.codeRoot}} worktree add <tmp> <B>`
    - `<tmp>` 记为 `effectiveRoot`（**不写入 project.yaml**，仅本次运行使用）
    - 学习完成后 `git worktree remove --force <tmp>`
    - `worktree add` 失败（分支在本地解析不到）→ **停止并如实报告**，让用户先 fetch/建分支；**不退回当前检出**、也不换一个"最像的分支名"

## 步骤 2 · 学习检查

**你不亲自读 `{{CONTEXT_ROOT}}` 下的文件，也不亲自跑 git**（`external_directory: deny` + bash 窄白名单，两件事都做不到）。用步骤 0 同一个解析器取数：

```
node "{{TOOL_ROOT}}/scripts/resolve-project.mjs" --cwd "<WORKSPACE>" --module "<module>"
```

- `freshness.available: false` → 无 gen 目录 → 走 `--mode init`
- `freshness.available: true` → 走 `--mode update`（拿 `learnedAtCommit` vs `headCommit` 交 analyzer 作为增量文件清单的起点）

**流程模式不走本步的 `--module` 取数**：它的就绪与新鲜度判定已在步骤 0.6 由 `--flow-readiness` 一次给全（那里已复用了同一套 `freshness` 路径，不另开取数出口）。
本命令**不读任何学习产物文件本身**——`external_directory: deny`，读不到，也不该去要这个权限。

## 步骤 3 · 分批策略

- 从 `{{PROJECT.modules[].entryPattern}}` 定位所有 Controller 文件
- 按 30KB 预算切 batch（route 段为原子；单 Controller 30–50KB 容忍不拆、>50KB 自动拆、溢出走附属 `batch-NNN-MM.md`，细则见 `supperH-prelearn`（预学习统筹）skill §1）：一批覆盖一组 Controller
- **并行模式（`--parallel`）改用 20KB 预估目标**：先派一次只读取数拿到目标 Controller 的 route 清单（主 agent 不亲自读源码），按 route 原子 + 目标输出预估 ~20KB（route 原子打包、≤3 route/片，非硬上限）切片，巨型 Controller 可跨片；切片计划照常给用户预览。落地时 writer 按 20KB 预估目标把切片顺序装填为物理 `batch-*.md`（细则见 `supperH-prelearn` skill §1.2）。**默认串行路径的 30KB 计划规则一字不改**
- 输出批次计划给用户预览（不立即执行），用户确认后再进派发

**流程模式的分片不由本命令计算**（红线：主命令不做分组）：

```
node "{{TOOL_ROOT}}/scripts/resolve-project.mjs" --cwd "<WORKSPACE>" --flow-plan [--page "<route>"]
```

返回 `flowPlan = { ok, algorithm, routes_per_part, parts_per_wave, total_routes, total_parts, total_waves, waves:[{wave, parts:[{controller, page_keys[]}]}] }`：
按所属 Controller 聚片、一片 ≤ 3 个 route、一波 ≤ 2 片（**两个数都是 L1 固定值**，不进任何配置、不开运行期放宽口子，要改只能改 `scripts/flow-engine.mjs`）。
route 与 controller 都取 code 分区 `index.md` 里现成的列，同一输入必得同一输出且不受目录遍历顺序影响。
为什么交脚本而不是"主 agent 看着 Controller 名单分一分"：依据是红线不是性能——读私有根 `index.md` 的取数必须下沉到脚本；
且分片决定可重生成性，必须是确定性计算。**未登记的旗标一律不得使用**（见 `.qoder/rules/10-redlines.md` R3.5 的窄 bash 白名单）。

## 步骤 3.5 · 页面发现（**仅页面模式**）

输入 = 步骤 0 的 `screen` 配置（`screen.discovery` 数组）；派 `supperH-prelearn-analyzer` 获取页面清单（主 agent **不亲自连库/读文件**）：

```
派 supperH-prelearn-analyzer {
  mode: screen,
  module: "screens",
  screen_config: <步骤 0 的 screen 对象>,
  commit: <current HEAD of effectiveRoot>
}
```

analyzer 逐项处理 `screen.discovery`（四类介质，至少一项），按每项 `via` 分派：
- `via: database` → analyzer 用**数据库通道**（`role: database` 那个槽位；该项显式写了 `slot` 时以它为准）跑 **SELECT-only** 查询，固定以保留源名 `screen` 调用（`--source screen`），`--filter` 传 `table` 与该项 `columns` 声明的 `id/parentId/name/path`（可选 `type/perms/where`）；详见 supperH-driver-contract（驱动契约）。库里没接出数据库通道时不得“猜一个驱动先跑着”。
- `via: driver` → analyzer 用该项 `slot` 登记的驱动槽位，按其 `source` 与 `map` 自己的查询协议取页面清单。
- `via: code` / `via: artifact` → analyzer 读该项 `path`（相对 `effectiveRoot`），按 `format`/`parser` 或 `rules` 解析；`parser: other` 缺 `userPhrase` 属配置缺陷，原样上报不猜。
- 任一项失败 → 原样上报其错误/退出码，**不换源重试**。

**流程模式跳过本步**：flow 不重新采集页面清单，它消费 **screens 代次里已落盘的页面集**（步骤 0.6 报的 `screens.page_count` 就是它的分母）。重采一份只会造出两个页面真相源。

## 步骤 4 · 派发 analyzer（可循环）

对每一批 Controller：
```
派 supperH-prelearn-analyzer {
  mode: init | update | enrich,
  module,
  controllers: [...],
  commit: <current HEAD of effectiveRoot>
}
```
analyzer 返回 → 立即派 writer 落地（**不留到最后一并落**，避免中途失败全丢）。

### 并行模式的滚动池调度（`--parallel` 专属）

**不是栅栏式波次**：不等齐，谁先好谁补位。规则如下（并发安全的两条约束见 `.qoder/rules/20-workflow.md` 上表 writer 行注）：

1. **池容量恒为 3**。切片按 `slice_id` 顺序入池；**任一 analyzer 返回就立刻把下一片派进去**，不等同批其它两个。补位**受第 8 条背压约束**（积压够一组时不得再补）。
2. **staging ≥ 3 即捞取落地（可变落地组 3~5）**：`readdir(staging_dir)` 里**未被落地引擎删掉**的 `slice-*.json` **≥ 3 时立刻捞取**——**有几个捞几个（3 / 4 / 5 个），一次最多 5 个**，**不等还在跑的那 ≤2 片**。落地组 = "**当时已完成的切片**"，其 `slice_id` **可以不连续**（例如 `{02,03,05}`）——这不影响任何东西：`batch` 物理编号本来就不跟逻辑序（SKILL §1），反查表行序由落地引擎按逻辑序 L 重排。
   - **不足 3 不捞取，writer 不空转轮询**：staging < 3 时**不落地**；落地是**被动的**——由调度方每次收到 analyzer 完成回执后 `readdir` 检测，≥ 3 才触发引擎，writer 自身不做任何轮询/等待。
   - **捞取数量以磁盘文件为准（`readdir`），不是以完成回执为准**：analyzer 写盘后回执有延迟，数文件才不漏捞刚完成的那片；故空闲时 staging 一凑满 3 就被捞走（`staging` 峰值 3），writer 忙时它自然攒到 5（被第 8 条背压压住）。
   - **捞取上限 5 = 排队上限 5**：`staging ≥ 5` 时背压停补（见第 8 条），所以一次捞取最多 5 片、排队等待最多 5 片。
   - **排空点兜底（唯一例外）**：切片清单全部派完（或到暂停点）时，**不足 3 片也要捞完**（尾组 = 1~4 片任意），绝不滞留。这一点在「排空点」段落再强调。
   - **为什么是"≥3 就捞"而不是"凑满 5"**：凑满 5 会让 writer 落地完（staging ≤2）后空等 3 片新完成；≥3 就捞把 writer 的空闲缩到"再等 1 片"，writer 慢时落地期间自然攒到 5、落地完直接捞满——**先这样跑，观测 writer 快还是 analyzer 快再调**。
3. **落地串行**：同一 module 同一时刻最多 1 个 writer 在跑。若上一组还在落地，本组**排队**等它切完 `CURRENT` 再派 —— 第二次落地要读第一次刚切出来的 gen，重叠会读到半成品。
4. **run 级 staging 目录 + 按片清理**：所有切片写**同一个** `{{PRIVATE_ROOT}}/staging/<project>/<module>/gen-<ts>/`（`gen-<ts>` = 本 run 开始时一次生成，全 run 共用；**不按落地组拆目录** —— 落地组按完成序形成，派发时未知，拆目录会与按完成序分组矛盾）。落地后 writer **只删 `expected_slice_ids` 对应的那几片文件**（`slice-NN.json` 及残留 `.tmp`），**不删整目录** —— 下一组在途的切片文件还在里面。
5. **落地期间 analyzer 照跑**（这是与旧"phase 分离"唯一的差别）：analyzer 对 `CONTEXT_ROOT` 零依赖，只读 codeRoot、只写自己那组的切片，**不读也不写** gen 与 `CURRENT`；读 gen 的只有 writer 自己。所以 writer 落地时**不需要**停下该 module 的 analyzer。
6. **失败按组 fail-closed**：本组任一 analyzer 返回 `fail` / `INSUFFICIENT_LEARNING` / `TARGET_NOT_FOUND` → **本组不落地**（已落盘的其它组不动），失败片列进失败清单；继续还是停止由暂停点决定（第 3 条「整批等齐再用」的粒度从"一轮"收窄为"一组"）。
7. **writer 模式按轮次定**：本 run 的**第 1 轮 `init`**（首次建立 gen），**之后每轮 `update`**（copy-on-write 拷未命中 batch 再追加）。用户重新跑 `--mode init` 视为**重新学习**（覆盖式续学，已学批次被重读覆盖、不重复落盘）。
8. **背压（writer 恒为 1 ⇒ analyzer 必须被节流）**：`已完成未落地切片数`（= staging 目录里**尚未被落地引擎删掉**的 `slice-*.json` 数，**机械可数**：`readdir(staging_dir)`）**≥ 5（= 捞取上限 = 排队上限）时停止补位** —— 不再派新 analyzer 进池，直到一次 `WRITTEN` 把它降回 `< 5` 再恢复补位。与第 2 条的捞取阈值（≥3）**分离**：3 是"开工线"（有几个捞几个、最多 5），5 是"排队上限"（staging 到 5 停补）。
   - **派发时的等价口径（点 1）**：停补判据可以换成**可计算的"已派发未落地" = `readdir(staging)` 的切片文件数 + 在途 analyzer 数**，目标是 **≤ 7**（= 排队上限 5 + 在途余量 ≤2）。两个口径等价：staging ≥5 停补 ⇔ 已派发未落地 ≤7。**保持 7 就是目标口径**——派发下一个 analyzer 前按这个数核对，超过就不派。
   - **为什么必须有**：writer 恒为 1（第 3 条），而"staging ≥3 就排一批落地"是纯生产者节奏。writer 比 analyzer 慢时，落地队列只增不减 → 积压无界（切片堆在 staging、`index` 与"已学进度"的差距越拉越大，中途失败要重跑的窗口也越来越大）。第 1 条的"池容量 3"只约束**在跑**的并发，**不约束积压**，两者必须分开看。
   - **为什么不是"多 writer"**：每次落地都是对 `CURRENT` 所指 gen 的 copy-on-write，下一次落地**必须读到上一次刚切出来的 gen**。两个 writer 并行会各自从同一基线分叉，后切 `CURRENT` 者**静默丢掉先切者的批次**（lost update）；`repack(G)` 与"全程只切一次 `CURRENT`"也都预设单 writer。要并行就得新增"分片所有权 + 确定性合并 + 单点切换"的独立机制 —— 属重设计，不在本期。
   - **稳态上界**（可用来验收）：**1 个 writer + ≤3 个 analyzer 在跑 + ≤7 片已完成未落地**（5 片排队 + 落地期间至多 2 片在途完成），即**已派发未落地 ≤ 7**（通式：排队上限 + 池容量 − 1 = 5 + 3 − 1）。看到"未落地 > 7"即说明补位没被背压拦住。

**排空点（只在这两处等）**：① 切片清单全部派完；② 到达暂停点。两处都执行"停止补位 → 等在途片全部跑完 → **有几个捞几个落地（不足 3 片也捞，绝不留滞）** → 再报进度/收尾"，这样暂停消息里的"均已落盘并切 CURRENT"才是真话（暂停点出现在落地之后、池子已重新填满，故在途最多 3 片）。

**批次暂停点（code 模式专属，`--pause-every` 缺省 3）**：上面这一轮（analyzer→落地）以 `WRITTEN` 结束后，把**本轮完整轮次**累计进计数（串行模式一轮 = 1 批 = 1 轮；并行模式一轮 = **1 次落地 = 1 次捞取**——**轮次计数只看落地次数，不看每次捞几片**（组大小 3~5 可变），**计数单位是轮不是物理 batch**，否则并行下一轮跨过暂停点且随 N 漂移；**后续若调捞取片数，本处计数逻辑无需改动**）；轮次计数是 `pause_every` 的整数倍且后面还有未派发轮次 → 先按上面「排空点」等在途片落地，再**停下**，按下面格式报进度并等用户答复：

```
已学 k/kTotal 批（覆盖 Controller m/mTotal，均已落盘并切 CURRENT）
继续 → 回"继续"；停止 → 回"停"（已学部分全部保留，不算失败）
```

- 用户答"继续" → 拿步骤 3 已确认的批次/切片计划接着派发（计划还在会话上下文里，不重新生成、不重排）。
- 用户答"停"（或任何非"继续"的明确停止意愿）→ **当前批已落盘，直接进步骤 6 收尾**，汇总里如实报"本轮未学完"。
- 用户答得不明确 → 再问一次，不猜。
- 计数没到倍数就全部跑完 → 不进暂停点，直接进步骤 6。

> **并发两种形态**（完整规则见 `.qoder/rules/20-workflow.md`「子 agent 并发与互斥」）：
> 1. **多模块同时学**（默认）—— 每个 module 一条自己的 `analyzer → writer` 流水（不同 module 的分区目录天然不碰）。
> 2. **模块内并行**（`--parallel`）—— 同一 module 拆成 ≤3 个 route 原子切片（目标输出预估 ~20KB、非硬上限），**滚动池**：恒 3 个在途、谁先好谁补位、每完成 3 片立刻落地（细则见上面「并行模式的滚动池调度」）。
>
> **并发安全不变量**（是**两条约束**，不是"互斥"）：writer 与同 module 的 analyzer **可以并发** —— analyzer 对 `CONTEXT_ROOT` 零依赖（只读 codeRoot、只写自己的切片文件，不读也不写 gen 与 `CURRENT`；读 gen 的只有 writer 自己），所以"写读交叠"在实现上并不存在。要守的是：① **落地串行**（同 module 同一时刻最多 1 个 writer，第二次落地要读第一次刚切的 gen）；② **按片清理 staging**（writer 落地后只删 `expected_slice_ids` 对应的那几片文件，不删整目录，不碰下一组在途切片）。
>
> **并行组交接**（步骤 5 契约，确定性执行，**不询问用户**）：本组各片已由各自的 analyzer 直接落成 `<staging_dir>/slice-NN.json`（tmp+rename，零转述、零转录），主命令只派那 1 个 writer 读入聚合。串行即原内联 `analyzer_output`，行为不变。
> **切片清单 = 机器可校验 manifest**：步骤 3 **优先调 `node scripts/parallel-plan.mjs --module <m>`**（巨型 Controller 可 `--controller <fqn>` 单出窗口计划）拿 `slices[]`——脚本出口字节确定性，route 扫描 + 窗口切片全机械；**退出码 43（route 扫描不完整）不手搓**：报告 `incomplete_files[]` 请用户确认（补全后重跑，或该模块改走串行 30KB 路径）——禁止主 agent 静默手动组装：漏路由不可见，且违反「分组必须由脚本产出」。派发逐片喂入 analyzer；writer 按清单核对——**核对粒度是本组的 `expected_slice_ids`（不是全量计划）**：缺号 / 窗口重叠 / 本组并集不覆盖本组计划 → `GEN_INTEGRITY_FAIL`。方法窗口不再靠主 agent 口头编号 + analyzer 自报核对。
> **plan.json 落盘必须 UTF-8 无 BOM（实测踩过）**：plan 交给落地引擎做 `(file,line)` 逻辑序还原时，若经 PowerShell `1>` 重定向落盘会被默认写成 **UTF-16LE**，node 按 UTF-8 读成乱码 → `readPlanOrder` 解析失败 → 逻辑序回退 fallback（行序不是源码声明序，虽然功能无损但 L 序失真）。落盘用 UTF-8 无 BOM（`[IO.File]::WriteAllText(p, json, [Text.UTF8Encoding]::new($false))`，或让 planner 支持 `--out` 直写）；落地引擎对 UTF-8 的 plan 用占位符后缀 endsWith 兜底（plan 键保留 `${adminPath}` 原文、切片键是真值也能命中）。
> **计划里的 route 键不是最终真值**：planner 保留注解原文（含 Spring `${...}` 属性占位符），而反查表要的是**可匹配的真值**。故切片里的 route 只是"这一片该学哪些方法"的范围声明——analyzer 必须**自己读代码并按配置把占位符展开**（见其工作流步骤 3），**不得把计划键原样抄进 `route.path`**；writer 用 analyzer 回的 `route_placeholders` 把计划键映射后再核对并集覆盖。

> **页面模式不重复本步**：页面清单已在步骤 3.5 由 `supperH-prelearn-analyzer(mode=screen)` 产出 `data.screens`；页面模式直接进步骤 5 落地（`module: "screens"`）。

### 流程模式（`--flow`）：波次派发，本命令只做两件事

主 agent 在这里**只做派发 + 原样转交**：不读源码、不做推理、不跨片自行补边。

对 `--flow-plan` 给出的每一波（`waves[]`）依次执行：

1. **一波并发派 ≤ 2 个 analyzer**（一片一个，一片内 ≤ 3 route）：
   ```
   派 supperH-prelearn-analyzer {
     mode: flow,
     module: "flows",
     page_keys: [...],   // 本片各页的归一化页面键，来自 --flow-plan，不自行增删
     screens: <步骤 0.6 返回的 screens 段>,
     modules: <闭包内模块及其 index 反查行（由脚本给出的字段，不自己去读）>,
     depth: 5,
     commit: <步骤 0.6 返回的 code.head_commit>
   }
   ```
   analyzer 权限不变（`edit: deny` / `external_directory: deny`）——**它写不了任何文件**，只返回压缩结构（表格行 + status，不带解释性正文）。
2. **整波等齐再用**（`.qoder/rules/20-workflow.md`「子 agent 并发与互斥」第 3 条）→ 一次 writer 调用把本波各页**追加写进新代**的 `flow-parts/part-<该页 route 稳定键>.md`。
   **这一趟不校验、不切 `CURRENT`**（半成品外部不可见）。为什么必须整波等齐才写、而不是"一片到就写"：`20-workflow.md` 规定 writer 与**同 module 的 analyzer 互斥**，而 flow 的 module 就是 `flows`——写读交叠是规则禁止的形态。
3. **失败按波 fail-closed**：本波任一页返回 `fail` / `INSUFFICIENT*` / `TARGET_NOT_FOUND` → **整波按最差分流**，全部进失败清单（route + 原因码），不得拿"其余页都 ok"掩盖那一个出局；**已落盘的其它波不动**，重跑 = 对这些 route 走 `--flow <route>`（**不新增旗标**）。连坐范围因此 = 一波 ≤ 6 页。
4. 越权动作（任何 agent 试图写盘 / 读私有根 / 连库）→ **整代中止且不切 `CURRENT`**，按 `WRITE_BOUNDARY_VIOLATION` 上报（既有码，不另造）。

> **不把多片返回攒进主上下文后再处理**：每波结束立刻把本波内容交 writer 落盘。攒着不写的收益是零，代价是溢出或中断时整轮白跑——落盘不减少总 token，它减少的是**后果**（沿用步骤 4 那句"不留到最后一并落"的原意）。

> **各 analyzer 之间不共享中间态**：跨片那条边的出处**只能**由 writer 在整理阶段按 `evidence` 机械折叠得出。主 agent 手里握着各片的最终回报，它**有能力**顺手补一条边——正因如此才更要禁：顺手补出来的边没有可核对出处，且会让同一次运行不可重生成。

## 步骤 5 · 落地（确定性脚本 + 原子切换）

**code 模式的落地动作由 `scripts/landing-engine.mjs` 执行**（与 flow 模式把它交给 `flow-engine.mjs` 同源）。装填 / 逻辑序重排 / index 生成 / 自检 / `CURRENT` 原子切换 / 按片清理**全部在脚本里**，writer 只做「组装入参 → 调用 → 原样回报」：

```
node "{{TOOL_ROOT}}/scripts/landing-engine.mjs" \
  --context-root "{{CONTEXT_ROOT}}" --module <m> \
  --staging-dir "<{{PRIVATE_ROOT}}/staging/<project>/<module>/gen-<ts>/>" \
  --expected-slice-ids 01,02,03,04,05 \
  --mode init|update \                     # 并行多轮：本 run 第 1 轮 init，之后每轮 update
  --commit <HEAD> \                        # 与切片里的 commit 必须一致
  --plan "<步骤 3 的 plan.json>" \          # 供脚本按 (file,line) 还原逻辑序 L；缺省则回退并如实标注
  --write                                  # **不带 --write = 干跑**：只算 + 自检，不写任何文件
```

退出码：`0` = WRITTEN（或干跑通过）；`41` = `GEN_INTEGRITY_FAIL`（自检不过，**不切 CURRENT、不删切片**）；`42` = `METHOD_DRIFT`；`2` = 入参错。stdout 一律是结果 JSON（形状与旧 writer 回报一致：`gen_dir / prev_gen / batches / methods_written / method_normalized / sources_* / completeness / l_order / problems`）。

页面模式仍派 `supperH-prelearn-writer`（`module: "screens"`，`mode` 取 `init`（首次）或 `update`（已有代次））——它走的是 writer 角色自己的落地路径，不在本脚本范围内。

并行模式一组 5 份回报的交接（步骤 4「并行组交接」）：**每份切片由对应 analyzer 自写**到 `<staging_dir>/slice-NN.json`（主命令不写、不转述——零转录，杜绝“转录丢字段 → batch 静默变浅”）；落地引擎按 `--expected-slice-ids` 读入本组那 5 份，校验份数/slice_id/schema/commit，校验窗口无重叠后机械装填 → index → 完整度自检（分母 = **本轮派发目标** = `expected_slice_ids` 的长度；本组即本轮，1 轮 = 1 次落地，巨型 Controller 跨片不要求单轮覆盖齐）→ 原子切 `CURRENT`（**module 级**）。**落地组之间串行**（同一 module 同一时刻最多 1 次落地，第二次要读第一次刚切的 gen）；本组落地期间该 module 的 analyzer 照跑（analyzer 对 `CONTEXT_ROOT` 零依赖）。落地返回 `WRITTEN` 后**由脚本按片清理**本组暂存（**只删 `expected_slice_ids` 对应的那几片文件**，不删 staging 目录本身、不碰下一组在途切片），失败则保留供排查。串行路径（无 `--parallel`）仍走 writer 角色 + `analyzer_output` 内联，行为一字不变。

writer 返回（页面模式）：
- `WRITTEN` → 继续下一批
- `GEN_INTEGRITY_FAIL` → 停止 + 报告；不重试
- `WRITE_BOUNDARY_VIOLATION` → **立即中止整个流程 + 上报红线**

流程模式另有：`WRITTEN`（`phase: append` 时每波一次 / `phase: finalize` 时整理一次，带 `switched: true|false`）、
`FLOW_INTEGRITY_FAIL`（带 `diagnostics[]`，处置见下文「流程模式的整理阶段」那张分类表）、`FLOW_STALE_PAGESET`（悬挂边 > 0，不切 `CURRENT`）。

### 流程模式的整理阶段（本轮唯一的合并点与写出口）

全部波结束后，再派**一次** writer 做整理（`mode: flow` + `phase: finalize`）：读 `flow-parts/` 全部片 → 按归一化 `(page, prev_page)` 二元组折叠去重
→ 生成 `flow-index.md`（节点表 + 边表）→ **端点自检五类**（入口页 / 末叶页 / 孤立页 / 悬挂边 / 环，整体重写 `flow-check.md`，不额外再派一次）
→ 校验（五类 + 边端点必须能在节点表找到 + index 覆盖率 ≥ 95%）→ **通过才原子切 `CURRENT`（全程只切这一次）**。

> **这是对 code 模式"每批即校验即切"（`agents/supperH-prelearn-writer.md` Mode: update）的有意偏离，不许日后顺手对齐回去**：
> 半张代码文档只是"少内容"，半张流程图会**主动误导**——边没推全时，中间页会被呈现成终点、下游缺失会被呈现成"确实没有下一步"。
> 校验不通过时新代目录留着但不切指针，外部照常读上一代；下次运行发现"存在没有 `CURRENT` 指向的 `gen-*`"一律**整代丢弃重做**，
> 绝不复用半成品（半成品无法证明自己完整）。parts 的**文件名取自该页归一化 route**，不用到达序号——否则 `part-01` 是谁取决于谁先跑完。

整理阶段返回 `FLOW_INTEGRITY_FAIL` 时必须带机器可读诊断：

```
FLOW_INTEGRITY_FAIL + diagnostics:[ { part, line, invariant, message, rerun_routes[] } ]
```

按 `invariant` 分三类处置，防"一律重试"退化成死循环（**这是对同一个步骤里 code 模式 `GEN_INTEGRITY_FAIL`「停止 + 报告；不重试」的有意偏离，严格限于前两类**）：

| invariant | 含义 | 动作 |
|---|---|---|
| `PART_SHAPE` | 某片表头不符 / 列数不对 / 路径非法 | 只重派 `rerun_routes` 的 analyzer **一次**；再失败即停并上报，不得改数据硬凑 |
| `DANGLING_EDGE` / `COVERAGE` | 悬挂边 / 覆盖率不足 | 重跑失败清单里的整波**一次**；再失败即停 |
| `BOUNDARY` | 越权或私有根写失败 | **立即停、不重试** |

主命令**照清单重跑，不自己猜重跑单位**，全程不阅读任何 analyzer 的推理正文（重跑所需的信息已在 `evidence` 与 `rerun_routes` 里）。
唯一阻断 `CURRENT` 的自检项是**悬挂边 > 0**（报 `FLOW_STALE_PAGESET`，语义 = flows 与 screens 已不同代，建议重跑 `--screen`）；
入口页 / 末叶页 / 孤立页 / 环**永不阻断**——孤立页合法存在，环在真实系统里也合法，判红会逼执行者去编边或静默断环。

## 步骤 6 · 汇总

```
## 学习完成
- module: <name>
- 学习分支: <branch>（effectiveRoot: codeRoot | worktree <tmp>；用户确认或 --branch 显式给出）
- gen_dir: <absolute path>
- prev_gen: <previous or "none">
- batches: N 个
- methods_written: M
- 完整度分布: L1=a, L2=b, L3=c
- 本轮批次: k/kTotal<若因"停止"提前收尾，补注：未学完，剩余批次重跑 `--mode init` 续学（已学批次会被重读覆盖，不重复计费落盘）>
- 越限 batch（单 route 段 >30KB 独占）: <oversized_batches 列表或 无>
- 建议局部重学的组（已落到第 2 层，可 `--module <name> --mode update` 单独重排、不影响其它模块）: <needs_repack_group 列表或 无>
- 页面模式专属（仅 `--screen`）: screens_written=<n> / route_resolved=<n> / code_linked=<n>
- 用时: Xs
- worktree 清理: done | skipped (branch=当前 HEAD)
```

流程模式换成下面这些行（一页不裁地把结果报全，**不得出现任何"因超限跳过/截断/建议分批"的记录或措辞**）：

```
## 流程学习完成
- gen_dir / prev_gen / switched
- 本轮新增边: N / 推翻边: M（superseded）
- prev 侧三态计数: root=a unresolved:原因码=b… no_data=c
- 端点自检五类: 入口页 / 末叶页 / 孤立页(逐条列 + 补学建议) / 悬挂边 / 环(逐条列页链)
- 外部接口登记: K 条（不参与上一步/下一步推理；单独一段，不混进边表结论）
- unresolved 清单: 每条带原因码与可执行动作
- 失败 route 清单: 按波归组，可逐条 --flow <route> 重跑
- diagnostics 摘要: 坏在哪个 part、违反哪条不变量
- 基线两行: 代码 HEAD + 学到 commit
```

## 步骤 7 · 失败降级

- 单批失败 → 保留已落地批次；报失败原因 + 建议后续动作
- `--pause-every` 暂停点用户选"停止" → **不属于失败**：不进本节的降级路径，直接走步骤 6 正常收尾
- worktree 场景失败 → 必须 `git worktree remove --force` 清理，不留悬空引用

## 边界（红线）

- 禁止主 agent 亲自读源码定位方法（红线：派 analyzer 干这事）
- 禁止跳过 worktree 清理直接返回
- 禁止把 `--enrich` 作为面向用户的公开模式（enrich 只由 supperH-bug 步骤 7a 内部触发；`/supperH-learn` 一期只暴露 init/update）
- 禁止在页面模式推断页面发现器或猜测 DB 表名/列名（红线：发现器一律取自步骤 0 的 `screen` 配置）
- 禁止主 agent 亲自连库或读发现器源文件（红线：由 `supperH-prelearn-analyzer(mode=screen)` 获取）

### 流程模式专属红线

- 禁止用页面名 / 菜单名 / 中文标题当节点键（可重名、可空、随遍历抖动）。节点键只能是**归一化 route**（或 screens 档案已确立的 canonical 页面标识），且归一化只有 node 侧那一个函数。
- 禁止为 `next` 另立第二张表、或给 next 侧存任何状态列。边表只有一行行的「本页 ← 上一步」；"下一步有谁"是查询结果，不是字段。一旦有了第二张表，它与第一张就是两个真相源，冲突时没有裁决者。
- 禁止把端点自检做成阻断门禁。它是**呈现 + 建议**：五类里只有悬挂边 > 0 阻断 `CURRENT`，其余四类永不阻断（判红会逼执行者编边或静默断环）。`flow-check.md` 是**体检报告不是数据**，回答"下一步"时绝不读它。
- 禁止 `--all` 因规模自行裁页、截断或"建议分批"。`--all` 的全部价值就是整代边集完整：裁一半会让入口页/末叶页出**假阴性**，那比慢得多得多糟。规模的正解是并发，不是少学；真跑不动时唯一正确的动作是分批多次 `--flow <route>`。
- 禁止把多片 analyzer 返回攒进主上下文后再统一处理，也禁止主 agent 顺手补一条跨片的边（详见步骤 4 流程模式那一节）。
- 禁止 flow 产物里出现任何判断/条件/分支/异常类字段：那些是 code 分区 batch 的既有职责。flow 只回答"上一步是谁、下一步有谁、有没有"；flow 也不自持表读写清单，Mapper 事实现读现用、结论只落那条边的 `evidence`。
