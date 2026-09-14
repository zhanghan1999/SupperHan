---
name: supperH-auto-fix
description: supperH-auto-fix（修复协议）— 修复协议骨架 skill。定义一次完整修复的输入/输出契约、幂等性要求、回滚边界、失败分类。**一期只定义协议不实现自动化执行**——实际执行仍由 supperH-bug-dev 子 agent 承担；本 skill 存在的意义是让所有 agent 对"什么算一次 fix"达成一致。
---

# skill: supperH-auto-fix · 修复协议（一期协议骨架）

## 前置自检（硬性）

未替换的双花括号占位符 → 立即停 + 报告“这类残留 = L1 产物未经 sync（仓库级问题，与项目配置无关）” + 引导用户在工具仓库跑 `node "{{TOOL_ROOT}}/scripts/sync-assets.mjs"` 后重启 IDE + 不降级。**不指向 `/supperH-bootstrap`** —— 它只建私有根骨架，修不了产物陈旧。

## 一期状态

**协议定义完成，实现留白**。本 skill 一期不接入任何自动化 fix 通道；`supperH-bug-dev` 是唯一的实际执行者，通过 `edit` 工具直接改代码。二期若引入"批处理自动修复""跨仓库 fix 派发""fix 生成补丁文件"等能力时，遵循本 skill 定义的接口。

## 目标

把"修一个 bug"抽象为一个**有输入契约、有输出契约、可回滚、可幂等重放**的操作单元。避免以下现状：

- 修完不知道改了几个文件
- 中途失败留下半改状态没人清理
- 同一个 bug 描述跑两次产生不同结果

## 一次 fix 的最小闭环

```
[Plan] → [Snapshot] → [Apply] → [Verify] → [Deliver | Rollback]
   生成      建         执行        跑编译       按 deliveryMode
  diff 计划  回滚锚点     变更        + 单测       交付 / 回滚
```

每段失败时**下一步动作**是协议的一部分，见"失败分类"。

## 输入契约

```yaml
fix_request:
  task_id: <uuid>           # 由主 agent 生成，用于日志追踪
  project_code: {{PROJECT.identity.code}}
  module: <name>            # 命中 {{PROJECT.modules[].name}}
  target: <symbol or path>  # 例 "com.example.order.OrderService#create"
  symptom: <text>           # 现象描述，自由文本
  root_cause: <text>        # 由 supperH-bug-analyzer 输出的根因判断，一段话
  candidate_plan:
    - id: p1
      description: <text>
      touched_files: [<abs path>, ...]
      touched_methods: [<sig>, ...]
      requires_db_write: <bool>
      db_write_artifact:      # 若 requires_db_write：问题从来不是“能不能过门禁”，而是“工件写好了没”
        target_env: prod | uat | test
        target_schema: <name> # 按 target_env 从 db.schemas 取；AI 只标注，不执行
        sql_path: <{{TASKS_ROOT}}/<task_id>/sql/NNNN-<slug>.sql>
        six_segments: [目标标注, 前置校验, 变更语句, 回滚, 证据链, 禁用项]
      rollback_hint: <text>
  approved_plan_id: p1      # 用户或主 agent 选定的方案
  delivery_mode: none       # 来自 L2 git.deliveryMode，由 --preflight 解析后递出；缺省 none
```

**必填字段缺失 → fix 拒绝进入 Apply**；不允许"缺 rollback_hint 就先跑跑看"。

## 输出契约

```yaml
fix_result:
  task_id: <uuid>
  status: ok | partial | fail | aborted
  applied_at: <ISO timestamp>
  delivery_mode: none        # 本次实际执行的交付方式（--preflight 解析结果原样回写）
  snapshot:                  # 回滚锚点；见"Snapshot 语义"
    ref: refs/supperh/snap/<task_id>
    sha: <40位sha 或 null>    # null = 工作区本就干净，无可存内容 → 回滚退化为"无需回滚"
  changed_files:
    - path: <abs>
      before_hash: <sha256>
      after_hash: <sha256>
      lines_added: N
      lines_removed: M
  db_writes:                # 空数组 if requires_db_write=false
    - schema: <name>
      statement_type: INSERT | UPDATE | DELETE
      affected_rows: N
      rollback_sql: <text>  # 可选；无则回滚靠 Snapshot 记录的表 dump
  verification:
    compile: pass | fail | skipped
    tests:
      passed: N
      failed: M
      skipped: K
      failures: [<test id>, ...]
  content_gaps:             # 补学信号；见 supperH-prelearn skill
    - batch: <name>
      route: <HTTP-METHOD path>
      missing_level: L1|L2|L3
  residual_issues:
    - <text>                # 未修项 / 遗留 / 建议
```

## 幂等性要求

同 `task_id` 重放 → 结果必须**等价**（允许时间戳、`applied_at` 等字段差异）：

- Apply 段以文件为单位：先比 `before_hash` 与目标文件当前 hash；若已相同说明上次 Apply 生效，**跳过该文件**继续处理其它
- 若 hash 既不等于 before 也不等于 after → 报 `CONCURRENT_EDIT` 且停止
- DB 写通过 `UPDATE ... WHERE id=? AND version=?` 式乐观锁，或走显式事务 + rollback 语句

## Snapshot 语义

Snapshot 是**回滚锚点**，不是提交动作。它必须满足三条：不动工作区、不污染分支历史、不占用用户看得见的 ref。

- **不创建分支、不创建 commit、不 `git stash push`**（`push` 会真的改工作区内容并写入 `refs/stash`，用户 `git stash list` 里会莫名多出一条、IDEA 会弹恢复提示）
- 建锚点两步（都在 `effectiveRoot` 上跑）：
  1. `git stash create` —— 只**产出**一个悬空 commit 对象并打印其 sha：不改工作区、不写 `refs/stash`、不出现在任何分支历史里（IDEA 的 Log 面板看不到它）
  2. `git update-ref refs/supperh/snap/<task_id> <sha>` —— 立刻钉住，否则该悬空对象随时可能被 `git gc` 回收，锚点就失效了
- 结果落地记 `snapshot: {ref, sha}`（见输出契约）
- `stash create` 输出为空 = 工作区本来就干净 → 视为快照成功但 `sha: null`，回滚退化为"无需回滚"；**这不是错误**，不得因此中断任务
- **不存在"文件过大只记 hash"的退化分支**：内容交给 git 自己的对象库，1MB 和 100MB 没有区别（旧协议里那句 JSON 指纹截断规则随之一并作废）
- `git stash create` 只覆盖**已追踪**文件的改动；fix 新增的未追踪文件不在快照对象里，回滚它们靠"删除新文件"分支（见"回滚边界"）
- 快照 ref 留存天数由 L2 `git.snapshotTtlDays`（缺省 7 天）控制，清扫发生在 `scripts/resolve-project.mjs --preflight` 进程内，**失败静默**、绝不改变任何退出码（原理与选型排除法见 `docs/architecture.md` §10.10）
- 命名空间 `refs/supperh/*` 归本项目独占；清扫只允许遍历 `refs/supperh/snap/` 前缀并逐条 `update-ref -d`，不跑 `git gc`，不碰该前缀之外的任何 ref

## 交付（Deliver）语义

交付方式来自 L2 `git.deliveryMode`，由 `--preflight` 在运行期解析后随载荷递出，主 agent 原样写入 `fix_request.delivery_mode`。**本 skill 不引用 `{{PROJECT.git.deliveryMode}}` 占位符**（运行期输入不烤进 L1 产物，与 `drivers.<slot>.kind` 同纪律），执行者也不自行推断"没写该算什么"。

| deliveryMode | Verify 通过后的动作 | 边界 |
|---|---|---|
| `none`（缺省） | **不建任何 commit**。改动全部留在工作区，打印 `touched_files` 清单让用户在 IDE 里逐个双击核对后自行提交 | 最安全：AI 只负责改，提交权始终在人手里 |
| `local-commit` | 在当前分支 `git commit`，只含 `touched_files`，**不 push** | message 首行必须带 `task_id`；禁止 `--amend`、禁止 `--no-verify` |
| `push-pr` | **一期拒绝执行**：报 `DELIVERY_UNSUPPORTED`，按 `none` 把改动留在工作区并提示人工推送 | 外向 git 写操作是"涉及修改就舍弃快捷性、保证安全性"这条裁决的红线，任何一期都不放开 |

`none` 与 `--preflight` 的脏文件预检是互相成就的：正因为默认不 commit，任务开始时工作区是否已经脏，直接决定了"这份 diff 里哪些行是我改的"——所以预检必须把脏文件如实记下来（**只记录、不阻断**），交付时才能把归属讲清楚。

## Verify 段的最小要求

- **必须**跑一次编译（`{{PROJECT.build.compileCmd}}`）；不通过 → 触发 Rollback
- 若 `touched_methods` 涉及已有测试类 → 跑相关单测；测试失败 → 触发 Rollback
- 若目标模块无测试覆盖 → 状态记为 `partial`（不是 `ok`），并在 `residual_issues` 里显式列出"该模块缺测试"

## 失败分类

| 阶段失败 | 归类 | 后续动作 |
|---------|------|---------|
| Plan 缺字段 | `aborted` | 回到主 agent 补齐输入；**不**改任何文件 |
| Snapshot 写文件失败 | `aborted` | 无副作用；报 `SNAPSHOT_IO_FAIL` |
| Apply 中途 IO 失败 | `fail` | 对已改文件按 Snapshot 逐个回滚；回滚失败列清单给人工 |
| Verify 编译失败 | `fail` | 全部回滚；报 `COMPILE_FAIL` + stderr |
| Verify 单测失败 | `fail` | 全部回滚；报 `FAIL_TESTS` + 失败用例清单 |
| 守卫拦下写语句（driver 侧漏实现） | `aborted` | 不进 Apply；报 `DB_GATE_DENY` |
| 本次需要写 DB | `partial` | 不进 Apply；按 `supperH-driver-contract` §SQL 工件契约产出 SQL 文件 + 报 `DB_WRITE_OUT_OF_SCOPE`（不是失败，也不补跑） |
| `update-ref` 建快照失败 | `aborted` | 未 Apply，无副作用；报 `SNAPSHOT_REF_FAIL`（**没有锚点就不许进 Apply**） |
| 脏文件命中本次 plan 的 `touched_files` | `aborted` | **停下来问用户**（硬清单第 1 条）；脏文件不在 plan 内则只记录继续 |
| 快照恢复失败（ref 缺失 / sha 为空但确有改动） | `partial` | **停下来问用户**（硬清单第 2 条）；不得伪装成"已回滚" |
| `deliveryMode: push-pr` | `ok` | 交付降级为 `none` + 报 `DELIVERY_UNSUPPORTED`；不回滚已经改好的代码 |
| Rollback 也失败 | `partial` | **不隐藏**；打印每文件当前 hash 与快照 commit 里的版本让用户自行判断 |

## 回滚边界

- 回滚只覆盖 `touched_files`；若 fix 引入了**新文件**（例：新增一个 DTO 类）→ 回滚 = 删除新文件；若新文件被其它 fix 引用 → 拒绝删除 + 报 `RESIDUAL_REFERENCE`
- 已追踪文件的回滚一律用 `git checkout <snapshot_sha> -- <path>` **逐文件**恢复，绝不整树切换、绝不 `git reset` / `git checkout .`
- 用户"我已经手动改过那个文件了"的场景：先看 `--preflight` 记录的脏文件集合是否命中 `touched_files`——命中即停问（硬清单第 1 条），未命中照常回滚（快照里存的就是用户改完之后的状态，回滚只会退到那一版，不会吃掉用户的手工修改）
- DB 回滚靠 `rollback_sql`（若 fix_request 提供了）；否则只能人工执行 `db_writes` 里记录的语句反向操作

## 修复执行阶段允许停下来问用户的三处（硬清单，封闭）

提问预算是稀缺资源：掺进无价值的问题，整套机制就会因为"太烦"被关掉。**动手之后的阶段**（Plan→Apply→Verify→Deliver/Rollback）里**只有**这三处允许中断询问，其余一律不问：

1. `--preflight` 记录的脏文件**命中了本次 plan 的 `touched_files`** —— 用户手改过要动的文件，改动归属无法确定
2. 快照 ref 恢复失败（`checkout <sha> -- <path>` 报错 / ref 不存在 / `sha` 为 null 但确有改动）—— 意味着无法回滚
3. 口径 / 分布对照查询取不到数据 —— 设计口径与实测分布是根因判据的两条腿，缺一即不得下结论

除此之外（脏文件但不在 plan 内、快照 ref 清扫失败、driver 槽位未声明……）一律只记录事实继续走，或按上表归类，**不换成人话向用户提问**。

> 本清单只管**动手之后**。入口（intake）层的提问在命令那一层另有预算：`/supperH-bug` 步骤 1 选模块、步骤 1.6 因 `40` 的一次性补问、步骤 5 的多方案选型（仅完整路径）。它们与本清单同一套纪律：**一次问全、只补一次、问不到就停下而不是猜**。

## 与 supperH-bug-dev 子 agent 的关系

- 一期：`supperH-bug-dev` 是本 skill 的**唯一实现者**；`supperH-bug-dev` 用自己的编辑工具直接改代码，不通过 `supperH-auto-fix` 命令行接口
- 二期：抽出 `supperH-auto-fix` CLI，允许外部脚本 / CI 通过同一契约调用；`supperH-bug-dev` 变成 `supperH-auto-fix` CLI 的一个调用者

## 一期不实现清单

- ❌ 补丁文件生成（`*.patch`）
- ❌ `deliveryMode: push-pr`（外向 git 写操作，见"交付语义"）
- ❌ 脏工作区下的 git worktree 隔离（一期不做：脏数据与 worktree 无关，`--preflight` 记录 + 命中 plan 才停问已经够用）
- ❌ 自动化跨仓库 fix 派发
- ❌ 学习数据里"修复案例"库（把过往 fix 变成模式）
- ❌ 用户可编辑 fix_request 的 UI（当前完全由主 agent 组装）
- ❌ Rollback 后自动重跑整条 fix 链

## 边界（红线）

- 禁止 `status=partial` 时把 `residual_issues` 隐藏
- 禁止 Snapshot 里出现凭据 / token / 未脱敏的业务数据（快照对象存在目标仓库自己的 `.git` 内，但 `result.json` 里的 `ref`/`sha` 落 `{{PRIVATE_ROOT}}`，**仍属可备份资产**）
- 禁止 Apply 段绕过 Plan 的 `touched_files` 白名单（编辑了计划外文件即视为 `aborted`）
- 禁止在没有快照锚点（`snapshot.sha` 为 null 且工作区不干净，或 `update-ref` 未成功）的情况下进入 Apply
- 禁止把 fix_result 原样写入 git 追踪文件；结果落地在 `{{PRIVATE_ROOT}}/tasks/<task_id>/result.json`
- **谁落这个 result.json（与 §SQL 工件同一盘归属）**：上面那句写的是**落点**，不是“让某个 agent 用编辑工具去写”。一期本 skill 只是协议骨架、无人真的落这个盘（`supperH-bug-dev` 把结果按输出契约**回传**给主命令，主命令向用户汇报）。二期抽出 `supperH-auto-fix` CLI 时，落 `{{PRIVATE_ROOT}}/tasks/` 依旧只能是 **node 进程内 `writeFileSync`**（与 `resolve-project.mjs --emit-sql`、jsonl 账本同源）——实现者 `supperH-bug-dev` 与主命令都 `external_directory: deny`，写不了工作区外的私有根，不得把它们接上直写此路径的活（那会重踏 F-18 的 S2 写侧后尘）。
