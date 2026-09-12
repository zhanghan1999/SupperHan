---
name: prelearn
description: supperH 预学习统筹 skill。定义分批算法、CURRENT 原子切换、copy-on-write、supplement 内容级补学四项核心不变量。被 /supperH-learn 主入口与 prelearn-analyzer / prelearn-writer 子 agent 共同引用。
---

# skill: prelearn

## 前置自检（硬性）

若本 prompt 里存在任何未替换的双花括号字面量（左两个花括号 + 非空内容 + 右两个花括号）：立即停止 + 引导用户在工具仓库跑 `node "{{TOOL_ROOT}}/scripts/sync-assets.mjs"` 后重启 IDE + 不降级。（残留 = L1 产物未经 sync，属仓库级问题；**不是** `/supperH-bootstrap` 的职责 —— 它只建私有根骨架。）

## 目标

在**不加载全模块源码到上下文**的前提下，把一个 Java 模块（Controller→Service→DAO→Mapper 调用链）学习成果**分区落地**、**代次化演进**、**可回退**。

## 目录不变量（不可协商）

```
{{CONTEXT_ROOT}}/
  └── <module>/
      ├── CURRENT               # 文本文件，内容 = 当前生效的 gen 目录名
      ├── gen-<ts-A>/           # 老代（stale 时保留 ≤2 代）
      └── gen-<ts-B>/           # 当前代 = CURRENT 指向者
          ├── index.md          # 元数据：learnedAtCommit / route→batch 反查表 / 完整度标记 / batch→sources
          ├── batch-01.md       # 一批 Controller 学习成果
          ├── batch-02.md
          └── ...
```

- `<module>` 必须命中 `{{PROJECT.modules[].name}}`，**或**为保留分区名 `menu`；否则拒绝写入
- `<ts>` 格式：`yyyymmddHHMMSS`（本地时区，秒级足够）
- `CURRENT` 是**文件**（不是符号链接），内容单行为 gen 目录名；读方 `readFile + trim`

## 四项核心不变量

### 1. 分批算法（30KB 预算）

- 每个 `batch-NN.md` ≤ 30KB（含 frontmatter）
- **同一 Controller 的所有方法必须落在同一个 batch**（不拆开）
- 一个 Controller 超 30KB → 单独一个 batch，允许该 batch 越限并打 `oversized: true` 标记（`index.md` 里登记）
- 切批策略：按 Controller 文件名字典序，贪心装填；填不进当前 batch 就开新 batch
- batch 编号从 `01` 起，宽度 2 位；≥ 100 个时自动扩到 3 位

### 2. `--- route: <method> ---` 锚点

- 每个 HTTP 入口方法体前面必须写一行：`--- route: <HTTP-METHOD> <path> ---`
- 例：`--- route: POST /api/v1/order/create ---`
- supplement 模式定位缺口时**依赖此锚点**；无锚点的方法视为私有方法，不参与 route 反查
- `index.md` 建立 `route → batch-NN.md` 反查表，供 `bug-analyzer` 快速定位

### 3. CURRENT 原子切换（copy-on-write）

写新代时：

1. 创建 `gen-<new-ts>/` 目录（不影响 CURRENT）
2. 从旧代拷贝**未被本次覆盖**的 batch
3. 用 analyzer 新数据**整体替换**指定 Controller 对应的 batch
4. 生成新 `index.md`，`learnedAtCommit` = 本次 analyzer 输入的 commit；`sources` 列按**本代实际内容**重算（拷贝过来的 batch 沿用其原有 `sources`，不重写）
5. **完整度自检**：`index.md` 中覆盖的 Controller 数 ÷ 目标模块 Controller 总数 ≥ 95% → 允许切换；否则报 `GEN_INTEGRITY_FAIL` 且不切
6. `writeFile("CURRENT.tmp", "<new-ts>")` → `rename("CURRENT.tmp", "CURRENT")`（同文件系统 rename 保证原子）

**任何异常路径**（write/rename 失败）→ 保留旧 CURRENT 指向；新代目录留在原地由下次 GC 清理；**禁止回滚性覆盖旧 CURRENT**。

### 4. copy-on-write 语义

- 学习数据**永不 in-place 修改**已 commit 过的 gen 目录
- `supplement`（内容补学）也走新代：`gen-<new-ts>/` = 旧代拷贝 + 目标 batch 用新内容替换 → 原子切 CURRENT
- 旧代保留最多 2 份（N、N-1）；N-2 及更早标记 stale，由 **writer 切 `CURRENT` 时的惰性 GC** 在 24h 后物理删除（`sync-assets.mjs` 不做任何 GC —— 旧版本文档在此误标为"sync 结尾的 GC 步骤"，已改）
- **禁止跨代 hardlink**（Windows 授权复杂 + 语义混乱）

## 四种工作模式（对外契约）

| 模式 | 触发方 | 输入 | 输出 |
|------|-------|------|------|
| `init` | `/supperH-learn --mode init` | 模块首次学习：analyzer 全量输出 | 新 gen 目录 + CURRENT 首次建立 |
| `update` | `/supperH-learn --mode update` | 代码变更后重学：analyzer 输出的**变更 Controller 清单** | 新 gen 目录（未受影响 batch 从旧代拷） + CURRENT 原子切换 |
| `supplement` | `/supperH-bug` 步骤 7a 内部触发 | 单个 `target_method` + `gap_hint` | 新 gen 目录（只有目标 batch 被替换） + CURRENT 原子切换 |
| `menu` | `/supperH-learn --menu <menu-id>` | 菜单来源配置（`menu` 对象） | 菜单索引 batch（`index.md` frontmatter 带 `kind: menu`）+ CURRENT 原子切换 |

`supplement` 不面向用户直接调用（`/supperH-learn` 一期只暴露 `init|update`）；只由 `bug-dev` 上报 `content_gaps` → 主 agent 派 `prelearn-analyzer(mode=enrich)` → 派 `prelearn-writer(mode=supplement)` 内部串起来。

### 菜单分区约定（保留名 `menu`）

- `menu` 为**保留分区名**，禁止与业务模块重名冲突：`/supperH-init` 采集 `modules[].name` 时须校验不含 `menu`，冲突则提示改名或让用户确认。
- 菜单学习产物固定落 `{{CONTEXT_ROOT}}/menu/gen-<ts>/`；`index.md` frontmatter 带 `kind: menu` 与 `menuSource: database|code`。
- 菜单 batch 锚点约定为 `--- menu: <menu-id> <path> ---`（便于 supplement / 反查）。
- 菜单分区与业务模块分区共享同一套目录不变量（CURRENT / gen / copy-on-write / 30KB 分批）。

## index.md 规范格式（机器可解析）

`index.md` 同时给人看和给确定性脚本查，因此**格式是契约的一部分**，不得自由发挥。运行期 `scripts/resolve-project.mjs --module <m> --anchor <a> --text <描述>`（快路径门禁）按本节解析；**解析不出即保守判 32 出局**（不降级为"尽力解析"）。本节与 `scripts/fastpath-gate.mjs` 的 `parseIndexMarkdown` 是一体两面：改本节必须同时改解析器 + 补测试。

### 段 1：frontmatter（YAML，必须）

文件以 `---` 开始并成对闭合，中间为 YAML：

```yaml
---
schema: supperh-index/2
module: <modules[].name | menu>
kind: code
learnedAt: <ISO-8601>
learnedAtCommit: "<git-sha>"
controllers: N
coveredControllers: N
---
```

字段含义（**写进 `index.md` 的只有上面这几行，不要把下面这段说明文字抄进去、也不要补行内注释**）：

- `schema`：固定值 `supperh-index/2`。解析器据此判**格式代际** —— 不符或缺失一律 32 出局。`/1` → `/2` 是因为反查表新增 `sources` 列（旧表无此列→无法安全判 G4b）；看到 `/1` 的存量数据一律先重学。
- `module`：目标模块名；菜单分区写 `menu`。
- `kind`：`code`（代码学习）或 `menu`（菜单学习）。**菜单分区必须 `kind: menu`**，否则 G2 会把它当业务模块。
- `learnedAt`：本次学习完成时刻。
- `learnedAtCommit`：学习时所在代码库的 HEAD SHA；**缺此项 → G4 新鲜度直接判失败（35）**。必须加引号，见下面「已知类型陷阱」。它仍然是**仓库级** HEAD（不是模块级、不是 batch 级）—— G4b 靠它作 diff 的左端点，而非拿它直接当相等判据。
- `controllers` / `coveredControllers`：目标总数 / 本 index 覆盖数；比值即 95% 完整度自检输入。

### 段 2：route 反查表（必须，表头以 `route` 开列）

文件中**第一个**以 `| route |` 开头的 markdown 表格即反查表。标准写法是七列全带行尾竖线：

```markdown
| route | controller | method | batch | lines | level | sources |
|---|---|---|---|---|---|---|
| POST /api/v1/order/create | OrderController | create | batch-01.md | 40-88 | L3 | src/main/java/com/x/OrderController.java;src/main/java/com/x/OrderServiceImpl.java;src/main/resources/mapper/OrderMapper.xml |
| GET /api/v1/order/detail | OrderController | detail | batch-01.md | 90-120 | L1 | src/main/java/com/x/OrderController.java;src/main/java/com/x/OrderServiceImpl.java;src/main/resources/mapper/OrderMapper.xml |
```

解析约定（脚本与 writer 共同遵守）：

- **`route` 必须是第一列**（解析器靠它区分反查表与其它表）；其余六列按**列名**定位，顺序可调，但 writer 一律按上面的标准顺序写
- 七列**缺一不可**：缺任一列即判格式漂移（32）。特别地，表头丢一根竖线会让 `level` 列整体丢失 —— 一个已学到 L3 的模块会被静默当成 L1、永久判 34，而被归因成"学习深度不足"，所以缺列绝不"尽力解析"
- **行尾 `|` 可选**（markdown 合法写法）、表头大小写不敏感、允许 `**route**` 加粗与行首 ≤ 3 空格缩进、分隔行风格不限（`|---|---|` / `| :-- | --: |`）；writer 产出的仍是标准写法
- `route`：`<HTTP-METHOD> <path>`，method 大写，与 batch 里 `--- route: ... ---` 锚点**字面一致**
- `controller`：简单类名（`OrderController`）；脚本按末段后缀匹配，允许锚点传全限定名
- `batch`：`batch-NN.md` 文件名（不含路径）
- `lines`：`起始-结束`；无法给出时填 `-`
- `level`：`L1`/`L2`/`L3`；**留空或写了别的值一律按 `L1` 处理**（保守降级，宁可判浅）
- 私有方法（无 route）不进此表；需要登记时另起一张表，不得混进 `| route |` 表
- 一张表内同一 `route` 只允许出现一次；重复即 G1 的多命中歧义

#### `sources` 列（G4b 批量级新鲜度的唯一依据）

本列 = 该 batch 所在调用链的**可达文件全集**（同一 batch 内各行的值相同，取该 batch 各方法 `touched_files` 的并集）。

- **形态**：相对代码库根（`EFFECTIVE_ROOT`）的 **POSIX 路径**，`;` 分隔，无空格、无盘符、无 `./` 前缀。与 `git diff --name-only` 的输出同形，否则交集永远为空。
- **必含 Controller 自身文件**（理由见 `agents/prelearn-analyzer.md` 步骤 3.5）。不为"省字节"剔掉它 —— 剔了等于打开漏杀口子。
- **追不全时写 `-`（而不是写空、也不是少写几个）**。`-` = "无法安全判定" → G4b **fail-closed 直接 35**。这一条是本列存在的根基：如果"不知道"被当成"无依赖"，整个修复就是把误杀换成漏杀。
- 路径本身含 `;` 或 `|` 的文件（几乎不会发生）→ 该 batch 写 `-`，走 fail-closed。
- 拷贝过来的 batch 沿用其原有 `sources`，不重新推演（重推没依据）；它的新鲜度由 G4b 的 diff 交集实测得出，不靠信任旧推断 —— 这正是本列顺手解决的"不可审计"问题。

**已知类型陷阱（两条，都是静默失效）**：

1. 不带引号的纯数字 SHA（如 `0012345`）会被 YAML 推定为 number 并丢掉前导零，导致与 HEAD 永远不相等 → 快路径默默不命中。解析器已按 **frontmatter 原文字面**取 `learnedAtCommit` 兜底，但 writer 仍必须写引号形式，以免其它消费方踩同一坑。
2. 行内注释：`learnedAtCommit: abc123 # 固定值` 里的 ` # ...` 会被解析器剥掉（`#` 前必须有空白才算注释，`abc#123` 不剥），所以**现在不会因注释而坏**。但剥注释是兜底不是契约 —— writer 产出的 `index.md` 里**不要写行内注释**，说明文字另起一行。

### 段 3：其余内容

概览、缺口说明、`oversized: true` 登记等自由排版，放在上述两段之后，不得再出现第二个 `| route |` 开头的表格（解析器只认第一个）。

## 完整度标记（L1/L2/L3）

`index.md` 里每个方法标注一个等级：

- **L1**：只写了签名 + 参数列表 + 返回类型（骨架）
- **L2**：L1 + 主要分支逻辑 + 显式抛出的异常清单
- **L3**：L2 + SQL 语句摘要（DAO 侧）+ 事务边界 + 外部调用清单

新写的 batch 默认 L1；`supplement` 模式目标就是把某方法的等级从 L1/L2 提到 L3。**主 agent 汇报学习完成时必须给出 L1/L2/L3 分布数字**。

## 边界（红线）

- 禁止把 `{{CONTEXT_ROOT}}/` 之外的任何路径作为写入目标（writer 内部 `WRITE_BOUNDARY_VIOLATION` 自检兜底）
- 禁止 CURRENT 指向不存在的 gen 目录（写入前 `fs.stat` 校验）
- 禁止 in-place 修改已 commit 过的 gen
- 禁止跨 worktree 复用 gen 目录（学习数据只跟 codeRoot 走，不跟 effectiveRoot 走；worktree 只影响**读取源码**的路径）
- 禁止把 `{{PROJECT.identity.code}}` 之外的目录作为 `{{CONTEXT_ROOT}}` 的最后一段（避免多项目串数据）

## 与其它 skill 的关系

- 本 skill 只讲**学习与落地**协议；数据**获取**（从已登记的源取结构化数据）见 `driver-contract` skill 与 `data-fetch` skill
- `supperH-bug` 主入口的步骤 3（新鲜度检查）与步骤 7a（补学）都遵循本 skill 定义的 CURRENT 语义
