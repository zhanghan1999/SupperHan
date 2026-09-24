# 通用工作流约定

本文件加载路径：`.qoder/rules/20-workflow.md`  
**约束**：本文件不得包含双花括号占位符与真实项目专有词。

## 主 agent 派发协议

主 agent（`/supperH-bug` 或 `/supperH-learn`）在派 subagent 之前，必须：

1. 首行回显 `target project: <code>`（值来自步骤 0 解析器命中的注册条目 `projects/<code>.yaml` 的 `identity.code`）
2. 明确列出要派的 subagent 名与传入参数
3. 声明"若 subagent 返回 fail 则走降级路径 X"（不允许无兜底派发）

subagent 返回必须是**结构化 JSON**，字段：
```
{
  "status": "ok" | "partial" | "fail",
  "code": "<machine-readable short code>",
  "message": "<human-readable summary>",
  "data": { ... },           // 由具体 agent 定义
  "artifacts": [ ... ]       // **写类 agent 必填，不得留空**：本次真实落地/改动的全部文件，含**新建**的（新建的只存在于这里）。
                             // 路径 repo-relative、POSIX 分隔；它是交付对账门禁的输入（见下节），不是可选项
}
```

## 子 agent 并发与互斥

一句话：**只读的并发，写工作区的互斥**。

### 写类为何必须串行（不是性能考虑，是正确性考虑）

回滚锚点本身会拆台：`git stash create` 抓的是“执行那一刻的工作区全量状态”。两个写类重叠时，A 的快照里含着 B 的半成品 → 按 A 的 `snapshot_sha` 逐文件回滚会**把 B 的改动一并吃掉**；`--preflight` 记的 `dirty_files` 同样会被对方污染，“命中 plan 才停问”那条硬清单判据随之失真。没有任何“小心一点”的写法能避开这两个后果，所以只能互斥。

### 分类（逐 agent，不靠推断）

| 并发属性 | agent | 依据 |
|---|---|---|
| **只读，可并发** | `supperH-bug-analyzer`（代码分析） | 不改仓内任何文件；取数只读 |
| **只读 + 只写自己的切片，可并发** | `supperH-prelearn-analyzer`（预学习读码，`--parallel`） | 只读 codeRoot；并行时仅写 `PRIVATE_ROOT/staging/<project>/<module>/gen-<ts>/` 下自己的 `slice-NN.json`（tmp+rename；run 级目录按文件名隔离）；**不读也不写** `CONTEXT_ROOT`（读 gen 是 writer 的事）、不写工作区、不写私有根其它位置 |
| **写工作区，互斥** | `supperH-bug-dev`（开发）、`supperH-bug-refactor`（重构）、`supperH-bug-code-generator`（代码生成）、`supperH-bug-code-optimizer`（代码优化）、`supperH-bug-mybatis-optimizer`（Mapper 优化）、`supperH-bug-test-writer`（测试编写） | 改代码 / 新增文件 |
| **等同写类** | `supperH-bug-tester`（测试执行） | 跑编译与单测会写 `target/`、能触 `install`；两个 maven 同仓并行会相争产物目录与本地仓库 |
| **只写私有根，可与代码写类并发** | `supperH-prelearn-writer`（预学习落笔） | 不碰 `codeRoot`；**可与同 module 的 `supperH-prelearn-analyzer` 并发** —— analyzer 对 `CONTEXT_ROOT` **零依赖**（只读 codeRoot、只写自己的切片文件，既不读也不写 gen 目录与 `CURRENT`；读 gen 的只有 writer 自己），故"写读交叠"在实现上并不存在。并发必须同时满足两条：① **落地串行** —— 同一 module 同一时刻最多 1 个 writer 在跑（第二次落地要读第一次刚切出来的 gen，重叠会读到半成品）；② **按片清理 staging** —— 所有切片写同一个 run 级 `staging_dir`，每次落地**只删 `expected_slice_ids` 对应的那几片文件**（不删目录本身、不碰下一组在途切片）。串行模式（无 `--parallel`）不受本条影响，仍是"同一 module 流水内串行" |

### 并发约束

1. **同批最多 3 个只读子 agent**。理由不是算力而是汇聚面：主 agent 拿到四份长回报后会把关键的那条 `external_refs` 挤到看不见的地方，而它看上去“已读”。
1.5. **子 agent 回执瘦身 + 主 agent 不逐条转述（汇聚面的另一半）**：子 agent 的整条回执（含 closing message）只含**本仓契约未固化的新事实**——正常路径一个结构化 JSON，正文禁止重述契约已知事实（顶层形状、commit 写法、原子写机制等，那些在契约与产物里）；只允许附一行异常/新信息（`route_unresolved` 原因、`sources_incomplete` 原因、`l_order` 回退原因等）。主 agent 收到并发回执**不逐条写成对话**：攒批，在排空/暂停/落地节点一次性汇总（"3/6 完成、1 失败"）；**异常回执（fail / INSUFFICIENT* / TARGET_NOT_FOUND / WRITE_BOUNDARY_VIOLATION）除外，必须立即原样转述**（fail-closed，不攒批掩盖）。理由与第 1 条同源：多写一个字就多占一次汇聚面，而"已读"往往只是"看过"。
2. **同一 driver 槽位同时最多 1 个在途取数**。多个并行探活/查询叠在同一内网端点上，叠不出新信息，只会把本来健康的端点测成超时。
3. **整批等齐再用**：任一返回 `fail` / `INSUFFICIENT_LEARNING` / `TARGET_NOT_FOUND` → **全批按最差的那个分流**（fail-closed）。不得拿“其余三个都 ok”掩盖那一个出局。
4. **回灌脚本一次只装一份回报**：`--impact-json` / `--intent-json` 的输入都是一份对象，把两份 analyzer 回报合并成一份喂给脚本 = 稀释 `external_refs`，那比不验收更糟。
5. **快路径 F3 不并发**：它只有一个 `supperH-bug-analyzer(lite)`，且回报要回灌 G5；并发收益只存在于**完整路径步骤 4**（把 `dimensions` 拆成多个只读 analyzer 同时派）、**多模块同时学习**（每模块一个 analyzer → writer 流水）与**模块内并行**（`/supperH-learn --parallel`，同 module ≤3 个 route 原子切片，并发由下表 `supperH-prelearn-writer` 行注的两条约束兜住：**落地串行** + **按片清理 staging**，并由第 9 条的**背压**节流补位）。
6. 每个并发派发仍须逐条满足上面三条前置（首行回显 `target project: <code>` + 列参数 + 声明兜底），并发不免除任何一项；派发参数里永远显式带 `--project <code>`（既有红线）。
7. **流程学习（`/supperH-learn --flow`）在此之上再收紧两条**：① **一波 ≤ 2 片**（比第 1 条的 ≤3 更严 —— writer 每波只被派一次，各波回执要汇进主 agent 的同一个上下文，瓶颈是汇聚面不是算力）；② **整波等齐才派 writer**。第 ② 条与上表的并发判据**无关**（flow 的 analyzer 写不了任何文件，不存在写读交叠），它是第 3 条 fail-closed 的另一面：本波任一页出局即整波按最差分流，半波落盘会让"哪些页已定"变成第二个真相源。

> 真误并发了（写类重叠）不自行收拾：也不新增一个“并发冲突检测”去自壮（那会成了第三个真相源）。下一次 `supperH-bug-dev` 进它的步骤 4 时，`git status` 与 `dirty_files` 一比就露馅，落回“允许停下来问用户”硬清单第 1 条。
8. **并行切片写（`--parallel`）文件不相交**：各 analyzer 只写自己的 `slice-NN.json`（`slice_id` 预分配，run 级 staging 目录按文件名隔离），不共享文件、不合并；落地引擎按 `expected_slice_ids` 读入**本组**那几片聚合，落地后只删本组那几片文件。
9. **写类串行 ⇒ 读类必须背压**：只要某个写类被钉成"同一时刻 1 个"（`--parallel` 的落地、`supperH-prelearn-writer` 就是），生产它的读类**必须带节流**，否则落地队列无界增长。`/supperH-learn --parallel` 的判据：**staging 里尚未被删掉的 `slice-*.json` ≥ 5（= 捞取上限 = 排队上限）时停止补位**，等一次 `WRITTEN` 降回 `< 5` 再补；**捞取（落地触发）在 ≥ 3 时进行，有几个捞几个、一次最多 5 个**（3 = 开工线，5 = 排队线，两个数独立）。**"并发 ≤3"只约束在跑数、不约束积压**，两者必须分开表述。反过来，"多 writer"不是可选项：落地是 `CURRENT` 所指 gen 的 copy-on-write，下一次必须读到上一次刚切出的 gen，并行会从同一基线分叉并由后切者静默丢先切者批次。**落地动作本体是确定性脚本**（`scripts/landing-engine.mjs`，与 flow 的 `flow-engine.mjs` 同源）——装填/索引/自检/切 `CURRENT` 是纯机械计算，不该让模型逐格誊 markdown。


## 提交 / 推送前的交付对账（硬门禁）

本仓**从不自动 commit、从不自动 push**：只有用户明示下达提交/推送指令时才执行。而指令一落地，第一件事不是 `git add`，是跑一次对账：

```
node "<TOOL_ROOT>/scripts/git-deliver-check.mjs" --cwd "<WORKSPACE>" \
     [--task-id <task_id>] --declared <开发 agent 回报的 artifacts 清单.json>
```

它拿**两侧**事实比对，按退出码裁决：

| 退出码 | 含义 | 必须做什么 |
|---|---|---|
| `0` | 两侧对齐、无待裁决未跟踪文件 | 才可以 add / commit / push |
| `10` | 有未跟踪文件还没进暂存区 | **逐个问用户「要不要纳入 VCS」**，得到明示后才继续；不得替用户默认「不提」 |
| `11` | git 侧改了、但覆盖清单里没有 | 让开发 agent 补清单或说明为何不属于本次交付，补齐后重跑 |
| `12` | 清单里有、git 侧却没动 | 虚报或根本没落盘，逐个核实路径存在性 |
| `2` | 不是 git 仓 / 清单不可解析 / 无 commit | 报给用户。**「没校过」永远不等于「校过了且通过」** |

为什么两侧都要、而不是只信 agent 的清单：清单里的信息存在 agent 自己看不见的地方 —— 一次派发跑完，新建了哪些文件只留在它的记忆里，而记忆会被上下文压缩掉。git 侧不会忘事，但它不知道哪些文件算「本次交付」。**所以清单必须落盘成文件**（`--declared` 收文件路径，不收口头），再由脚本与 git 实况对账。

三条禁止：

- 禁止把 `git commit -a` 或 `git add <显式文件列表>` 当「顺手一提」。`-a` 只收**已跟踪**文件，新建的永远收不进去 —— 那正是「4 个新文件没提交进去」的标准成因，而且漏掉的痕迹不存在于任何地方。
- 禁止凭记忆现写覆盖清单。清单的来源只能是开发 agent 回报里落盘的 `artifacts`。
- 禁止让门禁脚本代为裁决。它只读，不 `add` 也不 `commit`；`10` 的那一问必须由人回答。

基线优先取 `--task-id` 对应的 `refs/supperh/snap/<task_id>`（`supperH-bug-dev` 步骤 4 钉的锚点）；取不到则回落 `HEAD`，并在输出的 `baseline.kind` 里如实标注。回落时「相对基线的改动」退化为「工作区状态」，仍能抓出未跟踪文件，只是不再能识别「任务开始时就已脏」的那部分。


## 分批学习算法

`supperH-prelearn-analyzer`（预学习读码）每个 HTTP 入口方法输出一段（`--- route: <method> ---` 锚点为切分/合并原子）；切批与落位由 `supperH-prelearn-writer`（预学习落笔）按 `supperH-prelearn`（预学习统筹） skill §1 执行，遵守：

- **目标预算**：每个物理 `batch-*.md` ≤ 30KB（含 frontmatter 与路由锚点）；单 route 段自身 > 30KB 不可再分 → 独占一个文件并 `oversized: true`（绝对下限兜底）。**并行模式（`--parallel`）把切片与装填预算设为预估目标 ~20KB（route 原子打包、≤3 route/片，非硬上限；实际文件大概率落在 20KB 上下）**，细则见 skill §1.2；本节其余规则（repack / 命名 / index 契约）两种模式通用
- **单 Controller 容忍带 30–50KB（不拆）**：独占一批时允许越 30KB 至多到 50KB，打 `oversized: true`（记入 index，不进文件名）
- **单 Controller > 50KB → 自动拆**：按 route 段声明序连续装填成每件 ≤ 30KB 的父 `batch-NNN.md` + 附属 `batch-NNN-MM.md`（第 2 层 `batch-NNN-MM-KK.md` 封顶并建议单独重学该模块；第 3 层禁止，改触发送模块级线性全重排）；拆点在 route 边界，绝不切断单个方法
- **落位变化只走整组重排 `repack(G)`**（update/supplement 唯一改 batch 文件的方式，细则见 skill §1.1）：禁止就地插文件与单文件编辑；抖动锁在被改的那一组，其它批次跨代不动；查找走 `index.md` 的 `batch` 列（不透明字符串），改名不断链
- **batch 命名**：编号固定 3 位 `batch-001 … batch-999`，附属后缀同为 3 位，不设自动扩位；历史 2 位命名（`batch-01`）仍可解析，无需迁移
- **`index.md` 必带**：路由名 → batch 文件 + 行号范围 + 完整度标记；格式按 `supperH-prelearn`（预学习统筹） skill 的「index.md 规范格式」节（首张表以 `| route |` 开列，七列 `route/controller/method/batch/lines/level/sources` **缺一不可** —— 这是机器契约，缺列 = 格式漂移 = 快路径门禁判 32 出局）。`sources` 列 = 该 batch 调用链可达文件全集（含 Controller 自身，repo-relative POSIX，`;` 分隔，追不全写 `-`），供快路径门禁 G4b 与 `git diff` 求交集做 batch 级新鲜度复核。**`route` 列必须是可匹配的真值**：注解里的 Spring 属性占位符要在 analyzer 侧按配置展开后再写（原文形态永远匹配不上用户报的 URL）；`method` 必须落在规范集 `GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|ALL` 内，`ANY` / `*` 一类非规范拼写由装填期归一为 `ALL`，装填后自检发现规范集之外的 method 即 `METHOD_DRIFT` 拒绝切 `CURRENT`
- **流程学习不走上面这套 batch 切分**：它按 `--flow-plan` 的确定性聚片切分（同一个 Controller 的 route 聚成一片、**一片 ≤ 3 个 route**、**一波 ≤ 2 片**；两个数值都是 L1 固定值，不进配置、不开运行期放宽口子），落盘单位是 `flow-parts/part-<route 稳定键>.md` 而不是 `batch-NN.md`。分组**必须由脚本产出、不得由主 agent 现场分组**：`route → Controller` 是 `index.md` 里现成的列，读它是解析器的活（见 `10-redlines.md` 的只读取数下沉条）。

## CURRENT 原子切换

学习数据每次落地必须走：

1. 创建新代目录 `<module>/gen-<yyyymmddHHMMSS>/`
2. 全部 batch + index 写入新代；**不 touch** 旧代
3. 校验新代完整性（route 行数与 Controller 覆盖率、index 覆盖率、锚点存在性；附属文件不计入"批次数期望"）
4. 通过后原子更新 `CURRENT` 指向新代目录名
5. 保留最近 2 代（N、N-1）；N-2 及更早标为 stale，24 小时后 GC

`CURRENT` 文件本身用 tmp + rename 更新（同目录、同文件系统，保证 rename 原子性）。**禁止**直接 truncate + write。

> **`flows` 分区是一次有意偏离**：上面 1–5 步在它身上**全程只走一次**，不是每批一次 —— 各波只做 `flow-parts/` 追加（不校验、不切），全部波结束后由整理阶段一次完成「折叠去重 → 生成 `flow-index.md` → 五类端点自检 → 校验 → 切 `CURRENT`」。**禁止日后顺手把它对齐回每批即切**：半张流程图会主动误导下游问答，而半份 batch 不会。此点已在 `commands/supperH-learn.md`（整理阶段）与 `agents/supperH-prelearn-writer.md`（Mode: flow）正文里各写明一次。

## copy-on-write 语义

任何对已有 batch 的修改（supplement 模式）必须：

1. 在**新代目录**里完整拷贝一份旧 batch（命中组拷父+附属整组）
2. 拷贝上再合并新内容（组内落位经整组重排 `repack(G)`，见「分批学习算法」节）
3. 原子切 CURRENT  
不允许在原 batch 文件上 in-place 编辑。

## 完成判定（Definition of Done）

`/supperH-bug` 修复完成的**必要条件**：

- [ ] 编译通过（跑 `build.compileCmd`，非零退出即 fail）
- [ ] 相关单元测试通过（跑 `build.testCmd`，仅跑受影响模块）
- [ ] DB 边界成立（本次没有执行任何写库 SQL；需要改数据则已产出六段齐全的 SQL 工件并把路径交给用户，终判记 `DB_WRITE_OUT_OF_SCOPE`）。未接入数据库 → 记 `DB_GATE_SKIPPED_NO_DB` 缺口，不猜库名、也不把"没有清单"读成"没有限制"
- [ ] 学习记录更新（若修复过程中新增了源码阅读，writer 必须落 supplement 或回报缺口；**快路径下此项恒 N/A** —— 快路径要求分析子 agent 回报 `reads: []`，一旦回报了新增阅读就已触发升格，而不是在快路径里补学）
- [ ] 无残留双花括号占位符字面量在最终 diff 里

## 快路径完成判定

走快路径（F2–F6）时，上述五项**一项不少**，额外再加：

- [ ] 准入由脚本退出码 0 得出，不是由主 agent 判断；且 `fastPath.eligible === true` 与 `fastPath.anchorResolved` 非空（二者与退出码 0 是同一个命题）
- [ ] 退出码 36（门禁未求值：入参不成对 / 脚本内部异常）已当出局处理并记 `gate_incomplete`，**没有**被当成通过
- [ ] 编译 + 单测验证未被省略（这两项是快路径唯一保留的正确性证据，绝不可跳）
- [ ] 被省掉的动作对应的信息已转记：`content_gaps` → `learning_gaps`，未生成测试 → `test_advice`
- [ ] 终判带 `fast_path` 段（含 gates 结果与是否升格）

省掉动作可以，省掉信息不行 —— 后者是快路径唯一可观测的退化通道。

## 失败降级策略

subagent 返回 `status: fail` 时：

1. **不允许换 agent 重试**（见 10-redlines R5）
2. 主 agent 汇总错误上下文 → 报告给用户 → 明确列出下一步可选人工动作
3. 若已产生副作用（例如写了 DB / 改了文件）→ 提供回滚指令，不自动执行

## 学习模块新鲜度检测

主入口与多数子 agent 都 `external_directory: deny`，**读不到私有根下的 `index.md`，也无权跑 git**。因此这一检测只能由确定性脚本在自身进程内完成，不得要求放开权限：

1. 调 `node "<TOOL_ROOT>/scripts/resolve-project.mjs" --cwd <workspace> --module <m>`
2. 读返回体 `freshness`：脚本已在 `effectiveRoot` 里取到 HEAD，并解析了 `CURRENT` 指向的 `index.md` frontmatter
3. `available: false` → 该模块从未学习 → 先走 init 学习
4. `stale: true` → 不一致 → 标记 STALE → 派 analyzer 定向重学受影响 Controller 后再继续
5. `stale: false` → 直接使用

禁止：为了做这个检测而给任何新 agent 放开 `external_directory`；或让主 agent 自己猜一个 commit 串、“记得上次学到的版本”。

> **粒度差异是故意的**：上面这条检测是**仓库级**（`learnedAtCommit == HEAD`），而快路径门禁的 G4b 是**batch 级**（`sources ∩ git diff` 交集）。两者不同判据、不得“顺手对齐”：检测驱动“要不要重学”，错一次只多花几十秒；门禁驱动“能不能走快路径”，错一次是线上回归。把 `readFreshness` 改成与 G4b 同判据 = 作废已学覆盖率。

## 内容级补学（supplement 模式）

触发路径**只允许**：`supperH-bug-dev` 在修复过程中读了某方法的源码 → 修复摘要里输出"内容缺口清单"→ 主 agent 派 `supperH-prelearn-analyzer` 定向深挖 → 派 `supperH-prelearn-writer` copy-on-write 合并。

禁止：
- 用户手动 `/supperH-learn --enrich`（污染上下文；一期不开放）
- 无 supperH-bug-dev 回报的"整模块预补学"
