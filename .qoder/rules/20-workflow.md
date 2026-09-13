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
  "artifacts": [ ... ]       // 落地文件绝对路径列表（若产生写操作）
}
```

## 子 agent 并发与互斥

一句话：**只读的并发，写工作区的互斥**。

### 写类为何必须串行（不是性能考虑，是正确性考虑）

回滚锚点本身会拆台：`git stash create` 抓的是“执行那一刻的工作区全量状态”。两个写类重叠时，A 的快照里含着 B 的半成品 → 按 A 的 `snapshot_sha` 逐文件回滚会**把 B 的改动一并吃掉**；`--preflight` 记的 `dirty_files` 同样会被对方污染，“命中 plan 才停问”那条硬清单判据随之失真。没有任何“小心一点”的写法能避开这两个后果，所以只能互斥。

### 分类（逐 agent，不靠推断）

| 并发属性 | agent | 依据 |
|---|---|---|
| **只读，可并发** | `bug-analyzer`、`prelearn-analyzer` | 不改仓内任何文件；取数只读 |
| **写工作区，互斥** | `bug-dev`、`bug-refactor`、`bug-code-generator`、`bug-code-optimizer`、`bug-mybatis-optimizer`、`bug-test-writer` | 改代码 / 新增文件 |
| **等同写类** | `bug-tester` | 跑编译与单测会写 `target/`、能触 `install`；两个 maven 同仓并行会相争产物目录与本地仓库 |
| **只写私有根，与代码写类可并发** | `prelearn-writer` | 不碰 `codeRoot`；但**与同 module 的 `prelearn-analyzer` 互斥**（一边写 CURRENT/新代目录一边读它，拿到的批次的集合不是任何一瞬间的真实状态） |

### 并发约束

1. **同批最多 3 个只读子 agent**。理由不是算力而是汇聚面：主 agent 拿到四份长回报后会把关键的那条 `external_refs` 挤到看不见的地方，而它看上去“已读”。
2. **同一 driver 槽位同时最多 1 个在途取数**。多个并行探活/查询叠在同一内网端点上，叠不出新信息，只会把本来健康的端点测成超时。
3. **整批等齐再用**：任一返回 `fail` / `INSUFFICIENT_LEARNING` / `TARGET_NOT_FOUND` → **全批按最差的那个分流**（fail-closed）。不得拿“其余三个都 ok”掩盖那一个出局。
4. **回灌脚本一次只装一份回报**：`--impact-json` / `--intent-json` 的输入都是一份对象，把两份 analyzer 回报合并成一份喂给脚本 = 稀释 `external_refs`，那比不验收更糟。
5. **快路径 F3 不并发**：它只有一个 `bug-analyzer(lite)`，且回报要回灌 G5；并发收益只存在于**完整路径步骤 4**（把 `dimensions` 拆成多个只读 analyzer 同时派）与**多模块同时学习**（每模块一个 `prelearn-analyzer`）。
6. 每个并发派发仍须逐条满足上面三条前置（首行回显 `target project: <code>` + 列参数 + 声明兜底），并发不免除任何一项；派发参数里永远显式带 `--project <code>`（既有红线）。

> 真误并发了（写类重叠）不自行收拾：也不新增一个“并发冲突检测”去自壮（那会成了第三个真相源）。下一次 `bug-dev` 进它的步骤 4 时，`git status` 与 `dirty_files` 一比就露馅，落回“允许停下来问用户”硬清单第 1 条。

## 分批学习算法

`prelearn-analyzer` 按 Controller 为单元切分 batch，遵守：

- **单 batch 上限 30KB**（含 frontmatter、路由标记、正文），超过必须切分
- **一个 Controller 只属于一个 batch**（不允许跨 batch 拆同一 Controller 的方法）
- **切分优先级**：Controller 数分片 > 方法数分片 > 单方法深挖后拆段
- **batch 命名**：`batch-<NN>.md`，NN 从 01 递增，零填充
- **`index.md` 必带**：路由名 → batch 文件 + 行号范围 + 完整度标记；格式按 `prelearn` skill 的「index.md 规范格式」节（首张表以 `| route |` 开列，七列 `route/controller/method/batch/lines/level/sources` **缺一不可** —— 这是机器契约，缺列 = 格式漂移 = 快路径门禁判 32 出局）。`sources` 列 = 该 batch 调用链可达文件全集（含 Controller 自身，repo-relative POSIX，`;` 分隔，追不全写 `-`），供快路径门禁 G4b 与 `git diff` 求交集做 batch 级新鲜度复核

## CURRENT 原子切换

学习数据每次落地必须走：

1. 创建新代目录 `<module>/gen-<yyyymmddHHMMSS>/`
2. 全部 batch + index 写入新代；**不 touch** 旧代
3. 校验新代完整性（batch 数、index 覆盖率、锚点存在性）
4. 通过后原子更新 `CURRENT` 指向新代目录名
5. 保留最近 2 代（N、N-1）；N-2 及更早标为 stale，24 小时后 GC

`CURRENT` 文件本身用 tmp + rename 更新（同目录、同文件系统，保证 rename 原子性）。**禁止**直接 truncate + write。

## copy-on-write 语义

任何对已有 batch 的修改（supplement 模式）必须：

1. 在**新代目录**里完整拷贝一份旧 batch
2. 拷贝上再合并新内容
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

触发路径**只允许**：`bug-dev` 在修复过程中读了某方法的源码 → 修复摘要里输出"内容缺口清单"→ 主 agent 派 `prelearn-analyzer` 定向深挖 → 派 `prelearn-writer` copy-on-write 合并。

禁止：
- 用户手动 `/supperH-learn --enrich`（污染上下文；一期不开放）
- 无 bug-dev 回报的"整模块预补学"
