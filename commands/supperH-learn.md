---
description: 当用户想先理解/梳理某个模块、菜单或业务流程的代码（还没具体 bug、想建立上下文、说“先学一下 xx 模块”，或 bug 流程发现模块未学需要补学）时，推荐用本命令。三种模式：代码学习 / 页面学习 / 流程学习；产出 batch + index 结构落到私有上下文。若用户已有一个具体 bug 要修，应改用 /supperH-bug。
mode: primary
permission:
  edit: deny
  bash: allow   # 窄用途：本命令唯一允许的 bash 脚本是 resolve-project.mjs（可带 --module 多次调用做新鲜度取数）；分析/落地/编译仍走子 agent
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
| **flow** | `/supperH-learn --flow <flow-name>` | 流程学习：页面级依赖关系（一期只建骨架，二期填血） |

## 输入契约

```
/supperH-learn
  [--project <code>]           # 仅作交叉校验：解析器只认 --cwd（没有 --project 旗标，传了会被静默忽略）。
                               # 项目身份永远由当前工作区决定；本旗标的值与步骤 0 返回的 code 不一致时
                               # 立即停止并告知用户切到正确的工作区，绝不用它去改选项目
  [--module <name>]            # 或 --screen / --flow
  [--branch <name>]            # 默认 {{PROJECT.branches.dev}}；不同分支用 git worktree 检出到临时目录
  [--mode init|update|enrich]  # 默认 init
  [--commit <hash>]            # 默认 HEAD
  [--limit N]                  # 只学前 N 个 Controller，用于分批验证
```

## 步骤 0 · 项目门禁（**确定性硬门禁**）

与 `supperH-bug` 步骤 0 **完全一致**：取当前工作区绝对路径 `<WORKSPACE>`，运行解析器（本命令全程只允许这一个 bash 脚本，可按不同参数多次调用）：

```
node "{{TOOL_ROOT}}/scripts/resolve-project.mjs" --cwd "<WORKSPACE>"
```

- 退出 `0` → 持有返回 JSON 的 `code / contextRoot / codeRoot / effectiveRoot` 等；后续对 `supperH-prelearn-analyzer`/`supperH-prelearn-writer`/driver 的调用均**显式带** `--project <code>` 与该 `contextRoot`。
- 退出 `10/11/12` → **立即停止**，原样输出解析器 `message`（分别引导 `/supperH-init`、消歧、`/supperH-bootstrap`），禁止进入步骤 1。不做任何 LLM 猜测。

## 步骤 0.5 · 页面发现器门禁（**仅页面模式**）

仅当 `/supperH-learn --screen` 时执行；`code` / `flow` 模式跳过本步。

- 先查旧物：步骤 0 返回 JSON 的 `staleScreenConfig` 非空 → 检测到旧版 `menus/<code>.yaml` 残留，**立即停止**并提示用户跑 `/supperH-init --reinit` 重配（绝不静默当成未配置，也不搬运旧配置到新位置）。
- 再读步骤 0 返回 JSON 的 `screen` 与 `screenConfigFile`：
  - `screen != null` → 持有页面档案配置（`screen.discovery` 至少一项，每项 `via` ∈ `database` | `driver` | `code` | `artifact`），进入步骤 1。
  - `screen == null` → **立即停止**，原样输出：
    「页面发现器未配置（`<screenConfigFile>` 不存在），请先运行 `/supperH-init` 指定页面清单从哪些介质发现（database / driver / code / artifact，至少一项）。」
    禁止任何推断/降级（不得默认 `database`、不得猜测表名/列名）。

## 步骤 1 · 解析模块范围

- `--module` 必须命中 `{{PROJECT.modules[].name}}`；否则列清单让用户选
- `--screen` 时**模块名固定为保留分区名 `screens`**（不参与 `{{PROJECT.modules[].name}}` 匹配）；后续一律以 `module: "screens"` 派发 analyzer/writer，产物落 `{{CONTEXT_ROOT}}/screens/gen-<ts>/`。
- 若指定 `--branch` 且不等于当前 HEAD：
  - `git -C {{PROJECT.codeRoot}} worktree add <tmp> <branch>`
  - `<tmp>` 记为 `effectiveRoot`（**不写入 project.yaml**，仅本次运行使用）
  - 学习完成后 `git worktree remove --force <tmp>`
- 未指定 `--branch` → `effectiveRoot = codeRoot`

## 步骤 2 · 学习检查

**你不亲自读 `{{CONTEXT_ROOT}}` 下的文件，也不亲自跑 git**（`external_directory: deny` + bash 窄白名单，两件事都做不到）。用步骤 0 同一个解析器取数：

```
node "{{TOOL_ROOT}}/scripts/resolve-project.mjs" --cwd "<WORKSPACE>" --module "<module>"
```

- `freshness.available: false` → 无 gen 目录 → 走 `--mode init`
- `freshness.available: true` → 走 `--mode update`（拿 `learnedAtCommit` vs `headCommit` 交 analyzer 作为增量文件清单的起点）

## 步骤 3 · 分批策略

- 从 `{{PROJECT.modules[].entryPattern}}` 定位所有 Controller 文件
- 按 30KB 预算切 batch：同一 Controller 不拆开；一批 batch-NN.md 覆盖一组 Controller
- 输出批次计划给用户预览（不立即执行），用户确认后再进派发

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

> **并发只有一种形态**：多模块同时学 —— 每个 module 一条自己的 `analyzer → writer` 流水（不同 module 的分区目录天然不碰）。**同一 module 上永远串行**：writer 正在写新代目录 / 切 `CURRENT` 时再派一个 analyzer 读它，拿到的 batch 集合不是任何一瞬间的真实状态（完整规则见 `.qoder/rules/20-workflow.md`「子 agent 并发与互斥」）。

> **页面模式不重复本步**：页面清单已在步骤 3.5 由 `supperH-prelearn-analyzer(mode=screen)` 产出 `data.screens`；页面模式直接进步骤 5 落地（`module: "screens"`）。

## 步骤 5 · 派发 writer（原子切换）

```
派 supperH-prelearn-writer {
  mode: init | update | supplement,
  module,
  analyzer_output: <analyzer 返回的 data 字段>
}
```
页面模式：`module: "screens"`，`mode` 取 `init`（首次）或 `update`（已有代次）。

writer 返回：
- `WRITTEN` → 继续下一批
- `GEN_INTEGRITY_FAIL` → 停止 + 报告；不重试
- `WRITE_BOUNDARY_VIOLATION` → **立即中止整个流程 + 上报红线**

## 步骤 6 · 汇总

```
## 学习完成
- module: <name>
- gen_dir: <absolute path>
- prev_gen: <previous or "none">
- batches: N 个
- methods_written: M
- 完整度分布: L1=a, L2=b, L3=c
- 页面模式专属（仅 `--screen`）: screens_written=<n> / route_resolved=<n> / code_linked=<n>
- 用时: Xs
- worktree 清理: done | skipped (branch=当前 HEAD)
```

## 步骤 7 · 失败降级

- 单批失败 → 保留已落地批次；报失败原因 + 建议后续动作
- worktree 场景失败 → 必须 `git worktree remove --force` 清理，不留悬空引用

## 边界（红线）

- 禁止主 agent 亲自读源码定位方法（红线：派 analyzer 干这事）
- 禁止跳过 worktree 清理直接返回
- 禁止把 `--enrich` 作为面向用户的公开模式（enrich 只由 supperH-bug 步骤 7a 内部触发；`/supperH-learn` 一期只暴露 init/update）
- 禁止在页面模式推断页面发现器或猜测 DB 表名/列名（红线：发现器一律取自步骤 0 的 `screen` 配置）
- 禁止主 agent 亲自连库或读发现器源文件（红线：由 `supperH-prelearn-analyzer(mode=screen)` 获取）
