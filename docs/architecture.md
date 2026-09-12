# supperH 架构：三层分离

## 0. 一句话摘要

**L1 通用行为层**（本仓库）+ **L2 项目契约层**（`supper-Han-private/projects/<code>.yaml`）+ **L3 个人习惯层**（`supper-Han-private/prefs.md`）；三层各管各的变化频率，互相不污染。运行时另有一道**确定性门禁**：判定不交给 LLM，交给脚本退出码（见 §10）。

## 1. 为什么要分层

一个可复用的 AI 编程工具最常见的腐化路径是：**把项目事实混进通用逻辑里**。表现为：

- Agent prompt 里写死了具体项目的包名、库名、分支名（例：`<company>.modules.*` / `<internal_db_schema>` / `<release-branch>`）
- 换到新项目要"改代码"而不是"改配置"
- 别人 fork 你的仓库发现里面全是你公司的表名、库名、产品名 —— 不能分享
- 团队里每个人的沟通习惯（"简洁"/"详细"）也塞进 agent prompt → 每人一份分叉

三层分离就是为了打断这条路径：

| 层 | 变化频率 | 载体 | 是否上传 | 是否走 sync 变量替换 |
|----|---------|------|---------|-------------------|
| **L1 通用行为** | 极少（协议演进才改） | 本仓库 agents/commands/skills/scripts/ | ✅ 公开 | ✅ |
| **L2 项目契约** | 每项目一份 | `<PRIVATE_ROOT>/projects/<code>.yaml`（一个项目一个文件；迁移期兼容 legacy 单文件 `project.yaml`）+ schema | ❌ 私有 | 作为**替换来源** |
| **L3 个人习惯** | 每人一份 | `<PRIVATE_ROOT>/prefs.md` | ❌ 私有 | ❌ 不参与决策路径 |
| **驱动契约** | 每人/每项目实现不同 | `<PRIVATE_ROOT>/drivers/*.py` | ❌ 私有 | ❌ 只放骨架进 L1 |

## 2. 判据：一段内容该放哪一层

**主判据（变化频率）**：

- 换项目时会改动 → **L2**
- 换人时会改动 → **L3**
- 换项目换人都不动 → **L1**

**次判据（决策影响）**：

- 会被 agent 用 `if/==/命中` 判断的 → 必须 **L2**（要能程序化）
- 只影响"输出详细度 / 语气 / 排序偏好" → **L3**（人类可读即可）

**边界例子**：

| 内容 | 层 | 理由 |
|------|----|----|
| "测试库 schema 是 X" | L2 | 换项目就换值；agent 用它拼 SQL |
| "禁止写生产库" | **L1** | 换项目红线不变；具体生产 schema 名放 L2 |
| "回复用中文不要长篇大论" | L3 | 换人就换；agent 不用它做 if 判断 |
| "分批算法 30KB 上限" | L1 | 协议，不变 |
| "本项目 Java 版本 JDK 1.8" | L2 | 项目事实 |
| "每次派发 subagent 前必须回显目标项目 code" | L1 | 派发协议 |

## 3. 数据流：clone → 可用

```
git clone https://<your-host>/supper-Han-java
      │
      ▼
npm install          # 装 yaml 依赖
      │
      ▼
/supperH-bootstrap   # 或 node scripts/bootstrap.mjs（CLI 版）—— 只建目录，不写条目
      │  ├─ 检测同级 supper-Han-private/ 不存在 → 创建骨架 projects/ menus/ drivers/ context/ tasks/ + prefs.md
      │  ├─ 幂等：已存在的目录与 prefs.md（L3 用户资产）一律不动；--dry-run 一个字节不写
      │  ├─ legacy 单文件 project.yaml 存在 → 只报告路径 + 指路；--migrate（= 用户点了头）才转注册表
      │  └─ 把“注册项目”交给下一步：条目只能由 /supperH-init 在目标工作区扫描后产生
      │
      ▼
/supperH-init        # 或 node scripts/init-project.mjs --write --cwd <绝对路径>
      │  ├─ 扫结构预填 code / codeRoot / build / packageRoot / modules / branches
      │  ├─ 问“接哪些外部源”：一个都不选 = 纯代码模式，db / drivers 两段整段不写（不接是合法答案，不回落模板假值）
      │  └─ 写 supper-Han-private/projects/<code>.yaml + menus/<code>.yaml   # 注册表模型（§10.12）
      │
      ▼
node scripts/validate-project.mjs   # 独立命令；sync 不调它（旧版本文档在此处误标）
      │  ├─ 无参 = 校验 projects/ 下全部文件；--project <code> / --file <path> 单选
      │  ├─ 另查解析器自查不到的完整性：缺 identity.code、code 重复、文件名 ≠ code
      │  ├─ 另查跨字段通道规则（本仓库最小校验器不支持 if/then/allOf，故写在代码里）：
      │  │   kind=mcp 必带 mcp 绑定且 sources 非空、script 槽位不得挂 mcp 段；废弃槽位只警告不阻断
      │  ├─ 另查写保护覆盖度：forbidWriteSchemas 必须包含 db.schemas.prod 与 db.schemas.uat 的值
      │  │   （清单非空但一条都不命中 = 写保护不存在；driver ReadOnlyGuard / bug-dev DB 门禁全靠这个列表）
      │  ├─ 另查模板假值残留（只看 db / drivers 两棵子树的所有字符串）：残留 example_* → exit 2
      │  │   （这两段会被当真凭据/真库名/真驱动路径拿去用；codeRoot/packageRoot 里的 EXAMPLE 只会“匹配不上”，不属同类伤害）
      │  ├─ 另查 db 与数据库通道（role: database 的槽位）必须彼此成立：有驱动没 db 段 = 错（guards.py 的 select_only_guard 对空清单
      │  │   一条都不拦 = 写保护默认失效）；有 db 段没驱动 = 警告（库信息是事实，只是暂时无通道）
      │  └─ exit 0 有效 / 2 违规或无可校验 / 3 用法错误
      │
      ▼
node scripts/sync-assets.mjs
      │  ├─ resolve-private-root.mjs → 定位私有根
      │  ├─ 清空 dist/supper-Han-java-plugin/
      │  ├─ 复制 agents/ commands/ skills/ schemas/ drivers-skeleton/ mcp-skeleton/ → dist/
      │  ├─ 逐文件：去 BOM → CRLF 归一化 → 占位符替换 → 残留扫描
      │  │   （.py 里写 {{TOKEN}} 直接阻断：烤成绝对路径后反斜杠在字面量里是转义序列）
      │  ├─ 残留非空 → exit 3 阻断（不降级）
      │  ├─ 写 .qoder-plugin/plugin.json + .mcp.json（单条壳注册）+ mcp-skeleton/private-root.txt
      │  └─ 拷到 ~/.qoder-cn/plugins/cache/local/supper-Han-java/ + 注册
      │     （`node scripts/sync-assets.mjs --check` = 只校验不写盘：残留 exit 1；dist 与源不一致 / 注册表形状
      │       违规（绝对路径、写了 env 值、缺指针）exit 4）
      │
      ▼
重启 Qoder / OpenCode
      │  .qoder/rules/ 直接读取（零配置通道）
      │  agents/commands/skills 通过 plugin 加载（占位符已展开为绝对路径）
      ▼
输入 /supperH-bug "订单接口创建人字段丢失"
      │
      ▼
步骤 0 / 1.5：node {{TOOL_ROOT}}/scripts/resolve-project.mjs（全流程唯一放开的 bash）
         └─ 退出码即分流信号：0 通过 / 10·11·12 硬停 / 30–37 落完整路径 / 40 停下问用户一次 —— 见 §10
```

**关键点**：

- 命令文本里一律写 `node scripts/X.mjs`（带参数时连旗标一起），不写 `npm run X`：`npm run` 得从当前目录往上找 `package.json`，而运行期唯一被放开的 bash 是**绝对路径直调**（`node "<TOOL_ROOT>/scripts/resolve-project.mjs"`，R3.5 窄白名单）；npm 还会在脚本输出前后夹进自己的回显，而本流程的判据就是退出码 + stdout JSON。`package.json` 里的同名脚本只是给人手敲的别名，两条皆可。
- `.qoder/rules/` 走**零配置通道** —— clone 完立即生效，**不走 sync** —— 因此 rules 里严禁 `{{...}}` 占位符
- `agents/commands/skills` 走 **plugin 通道** —— sync 后展开绝对路径 + 项目字段，dist 自包含
- 学习数据落在 `{{PRIVATE_ROOT}}/context/<code>/<module>/gen-*/`，与本仓库解耦；本仓库不追踪任何 context
- 菜单来源配置落 `{{PRIVATE_ROOT}}/menus/<code>.yaml`（独立于 `projects/<code>.yaml`）；`/supperH-init` 首次注册强制采集，缺省退出 22 且不可 `--force` 绕过
- MCP 侧只有一条注册表（`supperh-drivers` 壳），内容由 sync 产出：server id + 插件相对命令 + `env_vars` **名单**，无凭据无绝对路径；壳靠 `mcp-skeleton/private-root.txt` 指回私有根，再 `importlib` 装载 `drivers/<code>/adapter.py` —— 加项目不动注册表（详 §11）

## 4. 三层各自的"变化操作"

| 场景 | 需要动 | 不需要动 |
|------|-------|---------|
| 换一个新 Java 项目 | 只改 L2（在**新项目工作区**跑 `/supperH-init` 多落一份 `projects/<code>.yaml`）| L1 一行不改；不重装插件 |
| 换菜单来源（database ↔ code） | 只改 `{{PRIVATE_ROOT}}/menus/<code>.yaml` | L1 不动；不必重新注册项目 |
| 换一个人使用 | 只改 L3（prefs.md） | L1/L2 不动 |
| 学完新代码 → 学习数据更新 | 只写 `{{CONTEXT_ROOT}}/` | L1 不动 |
| 加一个新内网数据源 | 在 L2 `drivers.*` 注册 + 在 `{{DRIVERS_ROOT}}/` 写实现 | L1 的 agent 一行不改（因为它们只依赖 `driver-contract`）|
| 某个源改走 MCP 通道 | 只改 L2 `drivers.<slot>.kind: mcp` + `mcp.sources` 白名单，重跑 `/supperH-init` 探测 | L1 不改；IDE 注册表不改（只有一条壳）；agent 提示词不写通道分支（通道由 `data-fetch` resolve 段机械选定）|
| 发现 L1 的 agent 里漏了个通用规则 | 提 PR 到本仓库 | L2/L3 不动 |
| 发现 L1 里出现了具体产品名 | **红线违反** —— 立即改回占位符 + sync 会阻断 | — |

## 5. 权限边界：最小放开面

**默认全部收紧**：

| 权限 | 默认 | 例外 |
|------|------|------|
| `read` | allow | — |
| `edit` | deny | bug-dev / bug-refactor / bug-code-optimizer / bug-code-generator / bug-mybatis-optimizer / prelearn-writer / supperH-bootstrap |
| `bash` | deny | bug-tester / bug-analyzer / prelearn-* / bootstrap / setup / supperH-bug 主入口（**仅** `resolve-project.mjs` 这一个脚本，可按不同参数多次调用） |
| `external_directory` | **deny** | **仅** prelearn-writer（写 `{{CONTEXT_ROOT}}`）+ driver-author（写 `{{DRIVERS_ROOT}}`）+ supperH-bootstrap（建私有根）+ supperH-init（写 `projects/` 与 `menus/` 条目）+ supperH-setup（写 IDE 加载目录）|
| `mcpServers`（取数工具） | **不绑** | **仅** 4 个只读/测试类子 agent：bug-analyzer / bug-tester / bug-test-writer / prelearn-analyzer（均只绑壳 `supperh-drivers`）|

`external_directory: allow` 是**跨越 workspace 边界**的能力，全仓库只放开 **2 个 subagent + 4 个 command**。这六个的 prompt 里都写死了路径前缀自检（名单同时钉在 `tests/agent-permissions.test.mjs` —— 只改本文不改进代码里的名单，测试会先红）：

- `prelearn-writer`：`filePath` 必须以 `{{CONTEXT_ROOT}}/` 开头 + 匹配 `<known-module>/gen-<ts>/(batch-NN.md | index.md | CURRENT)`；违反报 `WRITE_BOUNDARY_VIOLATION`
- `driver-author`：`filePath` 必须以 `{{DRIVERS_ROOT}}/` 开头（凭据只额外允许 `.secrets/*.local.json`）；不得碰注册表 YAML、L1 仓库、代码工作区；违反同样报 `WRITE_BOUNDARY_VIOLATION`。不绑壳 server（它是造驱动的，不是用数据的）
- `supperH-bootstrap`：只允许在 `<TOOL_ROOT>/../supper-Han-private/` 下 mkdir / 写文件；不允许在本仓库内创建私有根
- `supperH-init`：只允许写私有根下的注册文件（`projects/<code>.yaml` + `menus/<code>.yaml`）与 `context/<code>` `tasks/<code>` 目录骨架；实际写盘动作全部在 `scripts/init-project.mjs --write` 里完成，命令本身不手改 YAML
- `supperH-driver`：写盘全部经 `scripts/driver-registry.mjs`（先备份 + 先在内存过 schema + 探活不过不落盘）；临时 values JSON 也不得落到私有根之外
- `supperH-setup`：只允许写 `~/.qoder-cn/plugins/cache/local/supper-Han-java/` + `~/.config/opencode/{agent,command,skill}/` + `<PRIVATE_ROOT>/dist-portable/`；禁止修改用户 IDE 里 supper-Han-java 以外的插件目录

**为什么是两个而不是一个**（曾评估“把写驱动并入 prelearn-writer 以保住数字”并否决）：`external_directory` 是布尔开关而不是目录白名单 —— 拿到 allow 的那一刻它覆盖整个私有根，“只能写 context/”从来只是提示词里的自检。所以并职责**不缩小硬面**，只会把边界判据从“路径必须以某前缀开头”（无分支）退化成“先本次是哪种模式、再查对应前缀”（含分支）—— 那等于把边界交还给模型判断，与本仓库“确定性门禁优于模型判断”相反。真正缩小硬面的做法是默认不携带该 agent（用完再装），代价是命令层多一条“探测 agent 装了没”的脆弱路径；本仓库本来就有 4 个 command 带 allow，“这套工具就是要往私有根写东西”是既定事实，故取“名单显式登记 + 机械测试卡住新增”而非“默认不装”。派 `driver-author` 前必须先征得用户当次同意（写进 `commands/supperH-driver.md` 步骤 2）。

MCP 取数工具的绑定面与上一条同源：**外连动作必须发生在被约束的下游**。R3.5 的窄 bash 白名单已经规定「其它任何编译/DB/网络命令（包括跑 driver）仍必须派子 agent」；若把壳 server 绑到主 agent 或命令入口，等于开一条绕过该约束的外连直道。因此 `supperh-drivers` 只出现在 4 个只读/测试类子 agent 的 frontmatter 里，主入口只消费结构化结果。（门禁、编译、GC、写文件、扫码登录类动作**永不 MCP 化**，理由见 §10.2。）

## 6. 冲突点与决策

| 冲突 | 表现 | 本仓库解法 |
|------|------|-----------|
| C1 权限 `external_directory: deny` × 私有根在 workspace 外 | 学习数据写不到私有根；驱动脚本也写不到；IDE 装目录也在 workspace 外 | 只放开 `prelearn-writer` + `driver-author` 两个 subagent 与 `supperH-bootstrap` + `supperH-init` + `supperH-driver` + `supperH-setup` 四个 command；其它保持 deny；六者 prompt 内置路径前缀自检 + `WRITE_BOUNDARY_VIOLATION` 兜底；名单机械锁在 `tests/agent-permissions.test.mjs` |
| C2 git worktree × context 位置 | worktree 切分支时 context 该跟着哪个 root？ | context 落 `{{PRIVATE_ROOT}}/context/`，**与 worktree 解耦**；worktree 只影响 `effectiveRoot`（读源码路径），不影响学习数据落地 |
| C3 权限树无参数级校验 | `bash: allow` 允许任何 shell 命令，防不住 `rm` | sync 阶段的**占位符残留阻断**（进程级），不依赖 prompt；agent preamble 里做二级兜底 |
| C4 Qoder plugin 禁 `..` 路径 | 私有根 = `<TOOL_ROOT>/../supper-Han-private`，含 `..` | sync 时把 `{{PRIVATE_ROOT}}` 等替换成绝对路径后写入 dist；plugin 里只出现绝对路径，自包含 |
| C5 门禁要读 `CONTEXT_ROOT/index.md` + `git rev-parse HEAD`，但主 agent 与 `bug-analyzer` 均 `external_directory: deny`、bash 窄白名单 | 若把"能不能走快路径"交给 LLM，等于要求它使用两类自己根本没有的能力做判断 | **不改权限**，把判定下沉进 node 进程（`resolve-project.mjs` 在进程内读私有根 + `execFileSync` 取 HEAD），结果以 JSON 返回、退出码传信号；详见 §10.1 |

## 7. 学习数据分区结构

```
{{PRIVATE_ROOT}}/context/
  └── {{PROJECT.identity.code}}/       # 按项目 code 分区，多项目互不污染
      └── <module>/                     # 按条目 modules[].name 分区（或保留分区名 menu）
          ├── CURRENT                   # 文本文件；内容 = 当前 gen 目录名
          ├── gen-20240101120000/       # 上一代
          │   ├── index.md
          │   └── batch-01.md
          └── gen-20240201120000/       # 当前代
              ├── index.md              # learnedAtCommit / route→batch 反查 / L1-L3 完整度
              ├── batch-01.md           # ≤30KB；同 Controller 不拆开
              └── batch-02.md
```

演进规则：

- 每次重学 → 新代目录（copy-on-write） → 原子切 `CURRENT`（tmp + rename）
- 保留最近 2 代；N-2 及更早由 **prelearn 惰性 GC**（agent 切 `CURRENT` 时顺手回收 + 24h 后物理删除），**sync 不做任何 GC**（旧版本文档误标；sync 全文只把 `CONTEXT_ROOT` 当 runtime token 处理）
- 保留分区 `menu`：菜单学习（`/supperH-learn --menu`）产物，`index.md` frontmatter 带 `kind: menu`；与业务模块分区共用同一套 CURRENT/gen 不变量
- 详见 `skills/prelearn/SKILL.md`

## 8. Skill vs Agent vs Command 的分工

| 类型 | 定位 | 触发方式 | 有无副作用 |
|------|------|---------|-----------|
| **Command** | 用户主入口 | `/supperH-xxx` 手工输入 | 只编排；不亲自改代码 |
| **Agent**（subagent） | 执行体 | 主 agent 通过 `task` 工具派发 | 有；各自 permission 段严格限定 |
| **Skill** | 协议知识 | 被 command/agent 加载为 prompt 上下文 | 无；纯文档 |

- 一份 skill 通常被多个 agent 引用（`data-fetch` 是所有需要数据的 agent 的公共协议）
- 一个 command 只服务一个用户意图（`/supperH-bug` 只服务 bug 全流程）
- 一个 agent 只承担一个角色（`bug-analyzer` 只分析不改代码）

## 9. sync 阶段的两级防御

**一级：进程级阻断**（`scripts/sync-assets.mjs` 第 5 步）

- 遍历复制后的每个文本文件 → 正则扫 `\{\{[^}]+\}\}`
- 命中 → 记录 `文件路径:行号` → 加入残留清单
- 清单非空 → 打印所有命中位置 + `exit 3` **阻断，不降级**

**二级：prompt 自检**（每个 agent/command 的"前置自检"段）

- 万一残留没被 sync 拦下（例：用户手动改 dist/） → agent 收到 prompt 时自己扫描 `{{` 字面量
- 命中 → 立即停止 + 固定文案引导 `/supperH-bootstrap`
- 明确写"不允许推测、不允许降级、不允许继续"

## 10. 确定性门禁：退出码即分流

本仓库的三道门禁（项目身份 / 快路径准入 G0–G5 / 意图复述 I0）全部收在同一支脚本里，共同点是**脚本求值、退出码传信号**：主 agent 只按码分支，不做判断。

### 10.1 为什么判定必须在脚本里

- **权限事实**：主 agent 与 `bug-analyzer` 是 `external_directory: deny`，bash 只放开一条白名单——它**读不到** `CONTEXT_ROOT/index.md`，也**跑不了** `git rev-parse HEAD`。把“能不能走快路径”交给 LLM，等于要求它用两类自己没有的能力做判断（冲突点 C5）。
- **成本不对称**：漏杀（该慢走快）= 线上回归且当场不可见；误杀（该快走慢）= 多花几十秒。所以所有不确定路径一律保守出局，而这必须是**代码里写死的保守**，不能是 prompt 里的“请谨慎判断”。
- **可回归**：退出码能被 `tests/` 锁死；LLM 的一次判断无法固定，也就无法防漂移。

分工因此固定：**抽取归 LLM，判定归脚本**。LLM 只负责从自然语言里认出锚点字面量（`POST /api/v1/order/create` / `类#方法` / `File.java:88`），判定全在 `scripts/fastpath-gate.mjs`。

### 10.2 全量退出码表

**本表每一个码都来自脚本通道**（node 进程退出码）。MCP 不产生退出码，因此不占本表任何一行 —— 不是“还没写”，而是结构性不得入表：server 起不来时工具从列表**静默消失**（无码无 stderr），拿它当分流依据等于把“错被吞”写进流程（红线 R3.5）。取数通道的 `kind` 也遵同一秩序：注册期由脚本探测机械写定，会话内只读不重探。

| 码 | 归属 | 含义 | 主 agent 动作 | 可否降级 |
|---|---|---|---|---|
| 0 | 项目 / 快路径 | 唯一项目命中；带参时 = 全部门禁通过 | 继续；带参时读 `fastPath.anchorResolved` | — |
| 10 | 项目 | cwd 未注册 | 停 → 引导 `/supperH-init` | **禁止** |
| 11 | 项目 | 多项目命中歧义 | 停 → 让用户消歧 | **禁止** |
| 12 | 项目 | 私有根不存在 | 停 → 引导 `/supperH-bootstrap` | **禁止** |
| 20 | init | 驱动已配置但全部探活失败 | 停 → 修驱动，或显式 `--force` | 需显式 |
| 21 | init | 写完配置后解析器复验 cwd 不命中 | 停 → 修 `identity.workspaces` | 禁止 |
| 22 | init | 菜单来源未采集（`menus/<code>.yaml` 缺） | 停 → 采集后重试 | 禁止 |
| 30 | 快路径 | 锚点不可用：类型不支持（G0）或反查零命中（G1）；也用于 `enabled=false` 整体关闭。若返回体带 `needsLookup` 则是 traceId/ticketNo，应先回 F1.4 反查 | 落完整路径，不报错 | — |
| 31 | 快路径 | 锚点多命中歧义 | 落完整路径 + 终判记 `anchor_ambiguous` | — |
| 32 | 快路径 | 学习数据未就绪：CURRENT/index.md 缺失、不可读、`schema` 代际不符、必需列漂移、`kind: menu` 分区 | 落完整路径（先学） | — |
| 33 | 快路径 | 否决词表命中 | 落完整路径 | — |
| 34 | 快路径 | 目标方法完整度 < L3 | 落完整路径 + 建议 `/supperH-learn --mode update` | — |
| 35 | 快路径 | 新鲜度过期：**仓库级** `learnedAtCommit != HEAD`（G4a）**且**该 batch 的 `sources` 与 `git diff` 相交、或无从判定（`sources` 缺失/形态不合法、diff 取不到、HEAD 取不到，G4b fail-closed） | 落完整路径（走定向重学） | — |
| 36 | 快路径 | **门禁根本没求值**：入参不成对、impact 回报结构不可用、或脚本内部异常；**或诊断基线不成立**（环境名非法 / 空白，以及本项目未接入数据库 = L2 无 `db` 段） | 落完整路径；这是唯一“脚本自身不可信”的码 | — |
| 37 | 快路径 | **G5：影响半径 > 1 层或 lite 护栏被破**（回报 `IMPACT_WIDE` / `external_refs` 非空 / `reads` 非空） | 升格完整路径；终判记 `impact_wide` | — |
| **40** | **I0 意图复述**（两条路径共有） | **意图欠定义**：三槽位（expected/actual/repro）缺格；`quotes[].text` 的片段不在 `--text` 原文里逐字出现；expected 与 actual 的片段重叠或互为子串（说明两格没真区分）；`actual` 无任一条命中症状词表 | **停下来一次性补问用户**，补齐复述后重跑一次；仍 40 → 停止并原样输出 `problems`。它不是分流信号：禁止当普通出局轻装前行，也禁止猜个默认值继续 | — |

30–37 一律是**正常分流**：非 0 时不打回语、不重试、不换锚点再跑（与 10/11/12 的硬停严格区分）。

**40 故意排在这个连续段之外。** 30–37 的共同语义是"这次不走快路径，接着干"，主 agent 见到这段里任何一个码动作都相同 —— 一段连续区间正好承载"看码段就知道该干什么"这个习惯。40 的动作完全不同（**问用户**），给它一个段外的码位，是为了让"顺手分流掉"无路可走。它与 10/11/12 的区别：那三个是环境性硬停（修不好就结束），40 是可自愈的一次交互（问完接着跑）。

**完整路径也要判 I0，但读的不是退出码**：抽不到锚点时拿空锚点（`--anchor ""`）跑一次，空锚点在 G0 就短路成 30，走不到 40 的码位 —— 此时读载荷里的 `fastPath.intent`（见 §10.3）。同一个欠定义，快路径上是 40，完整路径上是 `30 + intent.ok:false`，语义一致、载体不同。

驱动契约自己的 0–5 码在两条通道上同构：`script` 分支是进程退出码，`mcp` 分支是 envelope 里的 `error.code` + JSON-RPC `error.code`（对照表唯一来源 `mcp-skeleton/supperh_contract/codes.py`，`tests/mcp-manifest.test.mjs` 拿它与 `base_driver.py`、`schemas/driver-response.schema.json` 三方机械比对锁死）。

表里的 20/21/22 只由**脚本通道**的探活结果决定：壳的 `--health` 是管路检查（私有根/注册文件/白名单/adapter 可装载，不碰后端），其探测项带 `gate: false` 不参与 20 的计数 —— 否则"脚本全挂 + 管路完好"会把没连上的项目登记成已就绪。探测结论对通道的唯一影响是**回写 `kind`**（探不过且 `fallback` 允许 → 写成 `script`），而不是现场改判；`fallback: none` 时只报 `blocked`，不悄悄翻写。

### 10.3 不变式

```
exit 0  ⟺  fastPath.eligible === true  &&  fastPath.anchorResolved != null  &&  fastPath.intent.ok === true
```

“没求值成功”必须是 36，绝不能是 0 —— 否则调用方会拿着一个空锚点进快路径，等于从参数解析器后面绕过“判定归脚本”这条红线。所有「未求值」分支（缺 `--anchor`、`--anchor` 在末尾无值、缺 `--text`、内部异常）必须走同一条 `bail()`：置 36 + 补一条 jsonl 记账（否则账本分母被削，日后据此调阈值会偏乐观）。仅带 `--module` 是 **freshness-only 模式**：未请求门禁，所以不得注入 `fastPath` 字段、退出仍为 0。

G5 回灌模式（`--impact-json` / `--impact-report`）有另一条不变式：

```
exit 0  ⟺  impact.narrow === true        且此模式从不注入 fastPath 字段
```

回报不可用（非 JSON 对象 / 缺 `code` / 未知 code / 缺 `reads` 数组 / 目标与锚点不一致）一律 36；回报明确“不窄”才是 37。两者结果都是落完整路径，但账本能分开“没判”与“判了不过”。

I0（意图复述）的不变式是**覆盖面**性质的：

```
I0 被求值 ⟺ 本次调用带了 --intent-json / --intent-report     （与是否进快路径无关）
退出码 40  ⟹  fastPath.intent.ok === false                    （逆否不成立，见下）
```

- `intent` 字段随**每一个**退出码回传（`res()` 恒带），这是完整路径能拿空锚点求值 I0 的前提 —— 少这一行，"两条路径都常驻"就只能靠自觉。
- `40 ⟹ ok:false` 成立，反过来不成立：更早的门禁出局时码位被占用，欠定义只体现在 `intent.ok` 上（退 30–37）。所以判定"复述够不够"永远看 `intent.ok`，判定"走哪条路径"才看码 —— 两个问题不许用同一个数字回答。
- `fastPath.intent === null` 且 `gates.I0_intent === 'skipped'` 永远意味着**调用姿势错了**（缺 `--intent-*` → 36），不是"用户没说清"。此时唯一正确动作是补齐入参重跑，**严禁拿去问用户**；`--anchor + --text + --impact-json` 的回灌模式会重跑整条锚点门禁，漏带 intent 就是自己把自己判成 36（`impact.applied:false`，G5 根本没求值）。

### 10.4 求值顺序（`evaluateFastPath`，短路）

```
G0 anchorKind → G2 dataReady → G4a fresh(仓库级) → G1 unique → G4b fresh(batch级) → G3 depth → veto → I0 intent → G5 pending_agent（本调用内）
                                                              └→ 第 2 次调用 --impact-json：verifyImpactReport 定 G5
```

- **G4 拆成两段（G4a 仓库级 + G4b batch 级）**：G4a 只做 `learnedAtCommit == HEAD` 的字面全等，命中即 `gates.G4_fresh='pass'` 并**跳过** G4b（零额外 git 开销）；不等时不立即出局，置 `'pending_batch'` 延迟到 G1 之后 —— 因为 G4b 需要 `hit.batch` 的 `sources` 列才知道该查哪个 batch。G4b 取 `git diff --name-only <learned> <head>`，与 `sources` 求交集：**不相交则放行**（`gates.G4_fresh='pass_disjoint'`），相交则 35。理由：原设计把整仓任何一次无关提交都算成过期，快路径会随团队提交频率退化成永远不走。
- **G4b 的三条 fail-closed 分支**：`sources` 为空/写 `-`/含非法形态（绝对路径、反斜杠、`./`、盘符）、`git diff` 取不到（`null`，与"零变更"的 `[]` 严格区分）、HEAD 取不到 —— 一律判 35。**不确定就当过期**，与漏杀/误杀不对称那条原则一致。
- **`sources` 必含 Controller 自身文件**：这是 "G4a 前置于 G1" 原不变式的替代保障——即使表算出的命中本身可疑，diff 至少会覆盖该 Controller 自己的文件。
- **G4a 前置于 G1**：反查表本身可能已过期，过期表算出的命中结果不可信。
- **否决词前置求值、但不决定短路顺序**：`vetoHits` 在函数顶部就算好，即使因数据过期先出局，也把真实命中面交给 jsonl——否则“描述里有否决词但因别的原因出局”的样本会被记成否决未命中，词表命中率被系统性低估，日后调参会往松的方向偏。
- **veto 放最后一道**：G2/G4/G1/G3 的失败原因比“你没传 `--text`”更可行动。但走到这里仍缺 `--text` 时返回 36 而非 0。
- **I0 排在 veto 之后、G5 之前**：它是唯一一条"判了也不改变分流"的门禁 —— 通过与否都是"继续"，不通过时停下来问人。放这么晚与 veto 后置同理：数据过期、锚点歧义这类原因更可行动，不能让"你没听懂"抢在前面报错。
- **G5 分两段**：`evaluateFastPath` 只置 `gates.G5_impact = 'pending_agent'`（它没读源码，无法算影响半径）；真正的 G5 判定在第二次调用里由 `verifyImpactReport` 完成——把 `bug-analyzer(lite)` 回报回灌 `--impact-json`。**脚本只能验回报形状（shape），信它的结论但验它的格式，所以 G5 永久弱于 G1–G4。**

### 10.5 阈值与硬上限

| 常量 | 值 | 语义 |
|---|---|---|
| `DEFAULTS` | `maxDiffLines 40` / `maxFiles 2` | L1 内置默认预算 |
| `HARD_CAPS` | `maxDiffLines 80` / `maxFiles 4` | L2 覆盖的**夹取上限**（只允许调小） |

缺这道夹取，L2 一个笔误（`maxDiffLines: 4000`）就能让规模门禁形同虚设。**现状（P1 已接线）**：`schemas/project.schema.yaml` 已声明可选段 `fastPath: { enabled, maxDiffLines, maxFiles, allowAnchorKinds }`，`resolve-project.mjs` 从 `binding.project.fastPath` 读出并传给 `evaluateFastPath`。语义：`enabled:false` 在任何 I/O 前短路直接判 30；`maxDiffLines/maxFiles` 被 `cap()` 夹到 ≤ HARD_CAPS（写大了不报错但不生效）；`allowAnchorKinds` 是可选锚点类型白名单，缺省/null = 不限制。**不写整段是最安全的**（走 L1 默认）。

### 10.6 否决词表与记账

- 词表是 `VETO` 常量数组，13 组 id：`methodSignature` / `buildFile` / `configFile` / `mapperXml` / `publicApi` / `migration` / `txConcurrency` / `perf` / `nondeterministic` / `security` / `cacheQueue` / `dataFix` / `dbWrite`。prompt 侧不再抄一份规则，只写“以脚本返回的 `veto[].id` 为准”，避免两处漂移。
- 扫描前做 Unicode **NFKC** 归一（全角字母会被折叠回半角，否则 `ｄｅｌｅｔｅ` 漏杀）；写库词用**子串匹配**而非 `\bdelete\b` —— 驼峰标识符内 `\b` 不成立，而 `deleteById` / `insertSelective` 恰是用户描述里最高频的写库说法。宁因此多误杀，不可漏杀。
- 每次带锚点调用向 `<PRIVATE_ROOT>/logs/fastpath-<yyyymm>.jsonl` 追加一行：`at / project / module / anchorKind / anchor(≤120) / textGiven / status / eligible / gates / veto[] / route / level / batch / g4b / wall_time_ms`（stage=`anchor_gate`；`needsLookup`、`budget` 也入注；`g4b = {ran, outcome, sources_count, changed_count, intersect_count}` 是 batch 级复核收益的唯一数据源；I0 入注 `intentGiven`（本次有没有申请复述）与 `intent = {ran, ok, slots_missing[], quotes_total, quotes_verified, problems[]}`（结论），外加 `anchorSource`（`lookup` = 锚点来自 F1.4 反查而非用户原话，因而豁免"逐字出现在 `--text` 里"那条判据））。G5 回灌单独记一行（stage=`impact_gate`，带 `impactCode` 与 `problems`）——未求值的 G5 同样记账，否则账本分母缺一块。写在 node 进程内：不占 agent 权限、不进 git、不消耗 token。硬停分支（10/11/12）**不记账**——它们不是门禁结论。

### 10.7 已知坑（代码里都留了注释）

| 坑 | 后果 | 现有防线 |
|---|---|---|
| CLI 用真值判断 flag 是否存在 | 「显式空值」「flag 末尾无值」被折叠成「没传」→ 整段门禁跳过 → 返回 0 | `xSeen` 布尔与值解耦 + `gap` 判定 → 36 |
| `additionalProperties: false` 拒掉被别的脚本写入的字段 | `identity.workspaces` 曾未声明 → **每个注册过的项目都判违规** | schema 已声明并在 description 写明“谁写、谁读、为何必须保留”；`node scripts/validate-project.mjs` 逐个点名 |
| copy 式构建的 `--check` 只比源文件 | 陈旧 `dist/` 误报通过 | `--check` 兼检 dist 一致性 → exit 4；时间戳双侧归一避免误报 |
| index.md 行内注释 / 纯数字 SHA | frontmatter 值被注释吃掉、SHA 变 number 丢前导零 | `normalizeScalar`（只有 `\s+#` 才算注释）+ 强制 `learnedAtCommit` 加引号 |
| `git diff A,B` 逗号形式传给 commit | git 对 commit **不支持**该形式 → `fatal: ambiguous argument` 退 128 → `diffNameOnly` 永远 `null` → **G4b 永远判 35，整套修复静默空转**（不报错、不改变行为，只在账本里空跑，最难发现的一类） | 两参数形式 `git diff --name-only <from> <to> --`；jsdoc 写明此坑；`gitRepo()` 真仓用例锁住两端点都能取到 diff |
| 非 ASCII 路径被 `core.quotePath` 转义成八进制 | 中文文件名永远不进 `changedSet` → 该重学的判成不相交 → **漏杀** | 取数时前置 `-c core.quotePath=false` + 剥外层引号；G4b-⑨ 用真中文路径验证 |
| `git diff` 默认折叠 rename | 旧路径从 `changed` 消失 → 改了文件位置但该重学的判成不相交 | 强制 `--no-renames`；G4b-⑧ 用真 `git mv` 验证 |
| `sources` 为空被当成“无依赖” | 新列刚上、旧表未重学时全量放行 → **把误杀换成漏杀**（净负收益） | `parseSourcesCell` 对空 / `-` / 非法形态一律 `usable:false` → G4b fail-closed 判 35 |

### 10.8 连通性判据：只认调用自返的证据

§10.2 末尾说的驱动契约 0–5 码里，`3 = 数据源不可达` / `4 = 认证过期` 只能由 **driver 自己的协议握手**产出。这里曾有一个「执行前预检」槽位 `drivers.vpnPreCheck`（先判断 VPN 通不通，再决定要不要跑 driver），本机对零信任隧道网关实测后**删除** —— 三类「看起来能提前判断连通性」的写法在全断的情况下全部报绿灯：

| 判据 | 实测行为 | 为什么不是证据 |
|---|---|---|
| 枚举网卡 / VPN 客户端名（`Get-NetAdapter` 匹配 VPN 关键字） | 冷启动 **1.80–2.42s**（用户所述「卡死」的来源） | 全局状态：适配器 Up ≠ 目标可达；不需 VPN 的直连内网反而被假阻断 |
| ICMP ping | 同一 VPN 网段内地址常不回包；偶尔回包耗时 **112ms** | 滤 ICMP 是内网常态，回了也不代表服务在场 |
| 裸 TCP connect | 同一内网主机的 **port 1 / 59999 / 65500 全在 0.00–0.02s 报「OPEN」**；本机 closed 端口反而 `TimeoutError` 2s | 网关替目标完成三次握手后丢弃字节 → 「端口开放」恒为真 |
| **协议级探测**（唯一合法判据） | 真端口 HTTP 拿到 `401` 用 **0.28s**、TLS 握手 `TLSv1.3` **0.21s**；对被代答的假端口发 HTTP 立刻 `RemoteDisconnected`（0.09–0.24s） | — |

由此定下三条硬约束：

1. **不存在执行前预检槽位**。取数前不做任何网络 / VPN 状态判断，也不得再引入；连通性结论只来自**本次调用自返的退出码**。协议级「是否不可达」在**取数**这件事上没有可提前获得的独立信息 —— 能测准的手段（带凭据连一次）必然带业务语义，那正是各槽位 `healthCheck` 已经在做的事，再造一个通用预检只是复制第二套真相。
2. **`healthCheck` 必须说真协议**：DB 用配置账号真连一次；HTTP 拿到任意状态行即算服务在场（`401/403` → exit 4，只缺凭据；拒连 / 超时 → exit 3）。禁止 ping / 网卡名 / 裸 connect 当判据。预算：单端点 ≤8s、总 ≤20s、多端点并行、绝不卡死 —— 预算**不能按热连接定**：同一个 HTTPS 端点冷启动首次 TLS 握手经隧道 >3s（拿 3s 做预算会假阻断），预热后只耗 0.2s。HTTP 类可直接用 L1 提供的 `http_health()`（`drivers-skeleton/base_driver.py`）。
3. **拿不到证据时的义务**：exit 3 / 4 → 停止该源取数，把**目标端点 + 错误原文**交给用户要求可连接环境；不猜 VPN 状态、不自动重试、不换网络再跑，更不得把「拿不到数据」写成「没有数据」。

退场兼容：`drivers` 段是 `additionalProperties: false`，直接删掉 `vpnPreCheck` 键会让已注册项目一夜之间 exit 2 全挂 —— 所以 schema **保留该键**，`node scripts/validate-project.mjs` 对它发**废弃警告（不阻断）**，运行期（init 探测 / data-fetch / driver 骨架）不再引用。与「legacy 单文件 `project.yaml` 仍可用但提示迁移」是同一条不变式。

怎么复现：对同一台内网主机分别做 `socket.create_connection()` 与一次 `urllib.request.urlopen()`，拿高位假端口（如 59999）与真实服务端口做对照。两类判据的差异在 0.1s 量级就能看出来：connect 对两者都秒回，HTTP 对前者报错、对后者返回状态行。**注意把实测结果记回本文档时只记方法与时序，不要把内网 IP / 端口号写进 L1**（红线：L1 无内网端点值）。

### 10.9 两个基线：新鲜度（代码侧）与诊断（环境侧）

这两个东西长期共用一个名字（“本项目”），于是产生一类不会被任何门禁拦住的错：

| 基线 | 回答什么 | 载体 | 取法 |
|---|---|---|---|
| **新鲜度基线**（代码侧） | 学习记录相对于**我这份检出**过期了没 | `learnedAtCommit` vs `HEAD` of `effectiveRoot` | 门禁 G4a/G4b（`--module` 单给时为 `freshness` 字段），**只用于分流** |
| **诊断基线**（环境侧） | 取回的行 / 日志 / 响应属于**哪个环境** | `branches.<env>` + `db.schemas.<env>` + driver 的 `--source <env>` | `resolve-project.mjs --env <name>` → `payload.diagnoseBaseline` |

一个只关心代码，一个只关心数据。它们可以同时成立而互不蕴含：代码是 `dev` 分支的 HEAD（新鲜度 OK），证据取自 `uat` 库。此时若结论写“代码与数据不一致”，两边都没错——错的是把它们当同一个现场比。

机械接线（`scripts/resolve-project.mjs`）：

- 合法环境名 = `branches.*` 与 `db.schemas.*` 的**键并集**（两边常常不对齐：`test` 库可能无对应分支、`dev` 分支可能无对应 schema）。取不到的那一侧回 `null`，不编一个值。
- 环境名**区分大小写且不模糊匹配**。未知 / 空白 / 缺值 → **exit 36**（调用方 bug：环境必须被说出来，不是被猜出来），且它**压在所有门禁之前求值**——否则 `--module` 单独给就能退 0 这条路会把无效环境静默放过去。
- **未接入数据库的项目（L2 无 `db` 段）给 `--env` 也是 36**：环境标签只对“从某个库取回的数据”成立，无源可采时给任何一个名字都是编的。它与“环境名写错”的差别只在 `reason` 文案（递两条出路：接库后重跑，或去掉 `--env` 只要代码结论）——同一个码，不让调用方去背“哪种不成立”的分类表。
- 不给 `--env` → **不注入 `diagnoseBaseline` 字段**（与 `--module` / `--anchor` 同一形状纪律：没申请就不伪造，`sync:check` 与金样用例因此不破）。
- **环境不参与分流**：它不进 G 系列、不改任何退出码语义（除了把自己的非法值报成 36）。原因是环境不是“能不能走快路径”的条件，而是“结论归属于谁”的标签；拿它做分流会造出一个新的隐式门禁。
- 记账：`diagnoseBaseline` 无效时落一行 `stage=baseline_gate`（否则账本分母缺一块），`anchor_gate` / `impact_gate` 两行都带 `diagnoseEnv`——没这一项就答不了“历史上那些快路径结论是在哪个环境上复核的”。

下游义务（写进契约，不靠自觉）：`evidence[].kind == "data"` 的 `ref` 形状为 `<project>/<source>@<env>#<meta.syncTs>`；**跨环境的值不可互相佐证**（拿 prod 的一行去证 dev 分支上的代码逻辑 = 拿别人的现场证自己的结论）。“uat 与 prod 不一致”是合法结论，但两条证据必须各自带 `env`。取数侧的对应约束见 `skills/data-fetch/SKILL.md` §环境归属，分诊侧见 `skills/incident-triage/SKILL.md` §三条硬要求。

### 10.10 交付方式与回滚快照（git 侧安全模型）

AI 改代码天然比人快，所以**涉及修改的环节必须舍弃快捷性换安全性**——这是本项目对"快路径"这条主张划的边界：快路径省的是*多余的确认*，不是*前置的确认*。落到 git 上就是两件事：一次 fix 改完之后代码**去哪里**（交付），以及改砸了怎么**退回来**（快照）。

#### 交付：`git.deliveryMode`，缺省 `none`

| 取值 | Verify 通过后的动作 | 为什么这么定 |
|---|---|---|
| `none`（缺省） | **不建任何 commit**，改动留在工作区，交回文件清单让人在 IDE 里逐个双击核对 | 提交权始终在人手里。AI 产出的 commit 一旦落进分支历史，纠正成本从"双击撤销"变成"改历史" |
| `local-commit` | 当前分支 `git commit`（只含本次 `touched_files`），**不 push**；message 首行带 `task_id` | 给已经信任这套流程、但仍要求本地可 `revert` 的场景 |
| `push-pr` | **一期拒绝执行**（`DELIVERY_UNSUPPORTED`），按 `none` 保留改动 | 外向 git 写操作不可逆且影响他人，不在任何自动化里放开 |

两个字段（`deliveryMode` / `snapshotTtlDays`）是**运行期输入**，绝不允许烤进 L1 产物：不写 `{{PROJECT.git.deliveryMode}}` 占位符，改由 `resolve-project.mjs --preflight` 读出后随载荷递出，执行者（`bug-dev`）只消费递出来的值。与 `drivers.<slot>.kind` / `fallback` / `mcp` 同纪律（§3.3）。理由有两条：一是省掉"进 `docs/placeholders.md` 登记表 + 改值必须重跑 sync 与重启 IDE"的成本；二是**消除歧义**——"L2 里没写这一段"到底是 `none` 还是"由模型自己看着办"，必须由脚本给一个确定的答案，不能留给 LLM 推断。

#### 快照：`git stash create` + 隐藏 ref

Snapshot 段的目标是**回滚锚点**，不是提交动作。旧协议（落一份 JSON 内容指纹）有三处硬伤，全部由这两条命令解决：

```bash
git -C <effectiveRoot> stash create                              # 打印一个 sha，仅此而已
git -C <effectiveRoot> update-ref refs/supperh/snap/<task_id> <sha>   # 立刻钉住，防 gc
# 回滚（逐文件，绝不整树）
git -C <effectiveRoot> checkout <sha> -- <path>
```

`stash create` 与 `stash push` 的区别是本节的全部要点：前者只**创建对象**并打印 sha——不动工作区、不写 `refs/stash`、不出现在任何分支历史里；后者会真的清空工作区并留下一条用户看得见的 stash 记录。用"看不见"换取"不污染"。

选型排除法（每一行都被实测性质否掉，不是偏好）：

| 方案 | 否决理由 |
|---|---|
| `git stash push` | 改动走掉、工作区变更 → 用户和 IDE 当场看见一条莫名 stash，`git stash list` 被污染；且它要求配对 `pop`，中途失败留下更难收拾的状态 |
| 临时分支 + commit | 进 `git log` / IDEA Log 面板，污染用户可见历史；用户下次 `git branch` 看到一堆垃圾 |
| `git worktree add` | 一期不做。且要分清：**脏数据与 worktree 无关**——worktree 解决的是"多个分支检出并存"，而本项目的风险是"同一个工作区里已有用户未提交改动"，换 worktree 并不会让归属变清楚 |
| 只记 JSON 内容指纹（旧协议） | 大文件要截断（>1MB 只存 hash + 首尾 100 行）→ 回滚能力随文件大小衰减为零，最终还得让人手工 `git checkout`；交给 git 对象库则无此限制 |
| IDEA Shelve | 不是 git 能力，落在 IDE 私有存储里，agent 无法机械调用，也不跨 IDE |

遗留的诚实说明：隐藏 ref 存对象这个手法本身在 git 生态里是有先例的（branchless 一类工具用非标准 ref 承载提交），但"拿它当编码 agent 的回滚锚点"没有现成惯例可循。它依赖的前提只有两个，都可验证：`update-ref` 钉住的对象不被 gc 回收；`checkout <sha> -- <path>` 只读对象不切分支。这也是把它写成硬清单第 2 条停问（恢复失败必须停下来问人）的原因——这条路走不通时不猜。

#### ref 命名空间与 TTL 清扫

- `refs/supperh/*` **归本项目独占**。任何清扫只允许遍历 `refs/supperh/snap/` 前缀，逐条 `git update-ref -d <ref>`；不碰该前缀之外的任何 ref，不跑 `git gc`。
- 留存天数 = L2 `git.snapshotTtlDays`（缺省 7，`0` = 不自动清扫）。过期判定用 `git for-each-ref --format='%(refname)\t%(objectname)\t%(committerdate:unix)' refs/supperh/snap/` 的**提交时间**，不依赖 ref 名里的日期（名字只是 task_id，不是时间）。
- 清扫落在 `resolve-project.mjs --preflight` 进程内。为什么不交给 `bug-dev`：主 agent 的 bash 是窄白名单（R3.5），而让 `bug-dev` 干就得给它 `update-ref -d`，把权限摊到最不该有删除能力的位置。脚本本来就已获准在 `effectiveRoot` 上跑 git（G4 取数），复用它是最小面。
- **失败静默**：清扫失败不改变任何退出码、不阻断任务（残留 ref 只是占点磁盘，不影响正确性）。这与 §10.6 记账失败绝不分流是同一条纪律：卫生动作不许产生决策权。

#### `--preflight` 只出本地事实

`--preflight` 做的**不是**连通性预检——§10.8 已经论证过执行前预检能测到的都不是证据，那条结论对 git 侧同样成立。它只收集本地既成事实：当前分支、`HEAD`、脏文件集合、解析后的 `deliveryMode` 与 TTL、driver 槽位是否声明、快照 ref 清扫结果。**脏文件只记录、不阻断**：一期不做隔离，也没资格阻断用户自己的工作区。它与 `deliveryMode: none` 互相成就——正因为默认不 commit，任务开始时工作区脏不脏就直接决定了"这份 diff 里哪些行是我改的"。

**修复执行阶段**（Plan→Apply→Verify→Deliver/Rollback）只有三处允许停下来问用户（封闭清单，见 `skills/auto-fix`）：脏文件命中本次 plan 的 `touched_files`、快照 ref 恢复失败、口径/分布对照查询取不到数据。其余一律只记录继续。理由很实际：**提问预算是稀缺资源**，掺进无价值的问题，整套机制会因为"太烦"被用户关掉。命令入口层另有三处（步骤 1 模块消歧、步骤 1.6 的 40、步骤 5 的多方案决策，见 §10.11）—— 两份清单各自封闭，合起来才是全流程的提问预算；任何一份想加条目都得先改本文档与红线。

### 10.11 意图复述 I0：唯一一条"判了也不分流"的门禁

G0–G5 全在回答"这个 bug 落在哪段代码"，没有一处在回答"用户到底要什么"。缺口表现为很具体的三类返工：每一步都合法，最后**精确地执行了一个错误的意图** —— 用户要的是可复核的定位（哪个类、哪个方法），我给的是一条读起来顺的流程叙述；或者把"期望是保存后详情页显示创建人"听成"期望是接口返回创建人"。定位判据齐全而意图判据为零，是本节补的完备性缺口。

分工照旧：复述由 LLM 写（三槽位 + 逐字引用），合格与否由 `verifyIntent` 判。五条机械判据：

| # | 判据 | 拦什么 | 拦不住什么 |
|---|---|---|---|
| 1 | 三槽位齐（`expected`/`actual`/`repro`）；`repro` 允许字面 `absent`，其它值须过长度下限 | 只描述了症状、没说想要什么 | 期望写得含糊但够长 |
| 2 | `quotes.expected[]` / `quotes.actual[]` 每条达下限字符数**且**被 `--text` 原文 `includes()` 命中 | 编造/意译出来的"用户说的" | 原话里确有此句、但挑错了句 |
| 3 | expected 与 actual 的引用片段不得相同或互为子串 | 整段抄一遍、两个槽位共用 | — |
| 4 | `actual` 至少一条命中 `SYMPTOM_RE` | 引用了背景描述而不是出问题的那句 | — |
| 5 | 锚点逐字出自原话（`fileLine` 只验文件名段；`--anchor-source lookup` 豁免） | 意译出一个原文里不存在的 route —— 后面的 G0/G1 只会夸它合法且唯一 | 原话里确有这句、但锁的不是这件事 |

- **零新增采集通道**：`verifyIntent` 吃的 `text` 就是否决词表已经在吃的那个字符串。I0 因此不要求用户多说任何一句话 —— 它只是把已经拿到的东西拿去对质。
- **`absent` 是字面量，不是"留空"**：`repro` 经常被用户省略，强制填非空的直接效果是奖励填空，而填出来的那句会被当成"用户确认过的前提"往下传。让它显式登记 `INTENT_ABSENT`（唯一合法写法，同义词不算 —— 判据要能机械复现）比让它被编造好。
- **回显是 I0 的第二半，不是礼貌动作**：上面五条全部只验"引用逐字出自原话 + 两格真区分 + 症状句被引到"，结构性地拦不住"原话里确实有这句、但说的不是这件事"。那一半只能靠把复述打印回给用户看（`commands/supperH-bug.md` 步骤 1.6 的回显模板）。省掉回显 = 把猜测格式化了一遍就当作已确认。
- **前置求值、不决定短路顺序**（与 veto 同纪律，§10.6）：`intentVerdict` 在 `evaluateFastPath` 顶部就算完，任何一次早退出的载荷里都带着它。这正是完整路径（空锚点）与 `fastPath.enabled:false`（L2 整体关闭）两种场景下仍能拿到机械判定的原因 —— 这两种情形**读 `fastPath.intent`，不读退出码**。
- **随单下发**：复述不是"走完就丢"的一次性仪式。`intent` 三槽位要随派发下发给 `bug-analyzer`（`scope.mustAnswer` 写成 expected 与 actual 之差）与 `bug-dev`（动手前把 expected 写成可检验目标，完工时回报 `intent_check`）。不落执行层的意图判据，与没有判据只差一步。

### 10.12 外部数据源是用户的选择，不是注册的硬前置

`db` 与 `drivers` 曾在 schema 顶层 `required` 里（`drivers` 还单独 required `database`）。看上去只是为了"配置完整"，实际效果是：**用户答“不接”时，框架没有合法的地方放这个答案**。于是当时真实发生的形态是：留空的字段保持模板字面量（`db.example.internal` / `example_prod` / `example_readonly` / `<DRIVERS_ROOT>/db-example.py`），而三份机制全都看不出它没被配好：

- `validate-project.mjs` 只看结构与类型——假值全是合法字符串；
- 连通门禁的算式是“已配置的 driver 无一探活 → 20”，零个已配置 = 无可探对象 = 自动放行；
- `forbidWriteSchemas: [example_prod, example_uat]` 非空、过形状检查，但 `guards.py` 的 `select_only_guard` 是**比字面库名**，真库 `demo_prod` 一条都不命中——写保护存在但永不生效。

现在的规则是**缺席即语义**，四处必须一致（只改提问文案不算修完）：

| 环节 | 实现 | 不接时的行为 |
|---|---|---|
| schema | 顶层 `required` 不含 `db`/`drivers`；`drivers` 不 required `database` | 整段缺席 = 纯代码模式，合法 |
| 生成 | `init-project.mjs` 的 `planConnections` + `applyConnectionChoices` | 接了按真值**整段生成**，没接**整段删除**（文本级段落手术，不 YAML round-trip：模板注释是"这个字段为何不能留空"的载体） |
| 校验 | `checkTemplateResidue` + `checkDbDriverCoherence` | 残留 `example_*` → 2；有驱动无 db 段 → 2，有 db 段无驱动 → 警告 |
| 运行 | `resolveDiagnoseBaseline` 先判 `db` 存在 | `--env` → 36（无源可采）；不给 `--env` 一切照旧 |

三条推定的理由：

- **存在时全字段 required**：`db.*` 七项缺任意一项，`initWrite` 在写盘前退 2 并逐项点名缺什么。半截 db 段比不写更糟——没答上来的字段会长得象真凭据（旧实现里连 `undefined` 都会被引号包成一个可用的主机名）。
- **残留扫描只盖 db / drivers 两棵子树**：这两段的值会被当真东西拿去用。`codeRoot` / `packageRoot` 里的 EXAMPLE 只会"匹配不上"，不属同类伤害；把一切形似占位符的字符串都当错误，只会让人把真库名改个写法绕过检查。
- **不接与“接了但没落地”必须分得开**：`gateNote` + `result.connections.mode`（`code-only` / `connected`）区分这两件事，零驱动时 `anchorLookup` 也不再报就绪。同形歧义就是上一代机制放过 F-7 的原因。
- **`anchorLookup` 只能说“候选就绪”，不能说“反查可用”**（F-11 之后顺带成立）：该字段报的是“已登记槽位的探活结果”，而“哪个槽位能拿 traceId 换回 route”要到运行期读各槽位的 `desc` 才知道。旧文案写死 `'ready'` 时，它其实替所有项目默认了“有个叫 logs 的源”，那是同一个缺陷的另一种形态。

边界：纯代码模式下菜单来源仍必填（硬门禁 22），但 `menu.source: database` 需要数据库通道（`role: database` 那个槽位）才能取到菜单数据——这一**跳文件**一致性目前无人机械拦（`validate-project.mjs` 不读 `menus/*.yaml`），靠 `commands/supperH-init.md` 步骤 2 的告知文案兜底。同一位置的另一件事已经改成机械拦：选了哪一支、那支的必填项没答齐 → 退 2 `menu-choices-incomplete`（为什么菜单比 db 段更需要这一道，见 §10.16 末尾）。

### 10.13 安装通道：OpenCode 侧不做“拷贝件”的两样东西

L1 资产可以被两个通道装载（Qoder 插件 / OpenCode 配置目录）。可装载 ≠ 可共享，所以定下两条边界：

| 对象 | 做法 | 为什么不能拷 |
|---|---|---|
| 红线四件套 `.qoder/rules/*.md` | OpenCode 侧不拷，写 `opencode.json` 的 `instructions: ["<TOOL_ROOT>/.qoder/rules/*.md"]` | rules 是**行为约束**，两份副本必然漂移（Qoder 改了、OpenCode 还拿旧副本办事）；指回工具仓后改红线不需重装。代价：工具仓不得删/改名/搬家，搬家后重跑 setup（旧 glob 按 `/.qoder/rules/*.md` 后缀识别并替换，不累积） |
| 用户配置文件 `opencode.json(c)` | merge-only，且**只拥有 `opencode.json`** | `.jsonc` 是用户文件，`JSON.stringify` dump 会抹掉注释；带注释的 `.json` 同样拒写，只打印待粘贴片段（fail-loud 比静默不生效好）。两个文件名 OpenCode 都会加载，所以探测必须两个都看（只看 `.json` 在“本机只有 `.jsonc`”上永久假阴性） |

命令 / agent / skill 正文**仍是拷贝件**（OpenCode 只能按目录发现它们，没有“声明指向另一个仓库”的稳定约定）—— 所以改了这三类源码必须两边各装一次。这条限制写进两份适配说明的“共用数据”一节，不让人靠猜。

数据层本身天然工具无关：可变态全在私有根（`projects/ menus/ context/ tasks/ drivers/ prefs.md`），路径 token 由主 agent 步骤 0 跑 `resolve-project.mjs` 运行期现填，所以 Qoder 学出来的模块 OpenCode 直接可读（反之亦同）。

另两条同族纪律：

- **陈旧产物按清单清理，不按目录 rm**：`setup.mjs` 在目标目录写 `supperh-installed.json`，下次安装只删清单内且落在 `OPENCODE_MAP` 目标根之下的文件（越界条目拒删）。`rm -rf` 会连用户自放文件一起抹；完全不删则改名/删掉的命令以陈旧副本继续被加载。两者都不可接受。
- **setup / bootstrap 不生成项目条目**：旧实现在 legacy `project.yaml` 缺失时 `copyFileSync(example → project.yaml)`，把 F-7 刚消灭的模板假值重新造回私有根。现在只建骨架目录（含对“已有条目但缺 `menus/`”的幂等补齐）+ 把路指回 `/supperH-init`。`--yes` 只表示“知道没条目，仍继续装资产”。`scripts/bootstrap.mjs` 与 `commands/supperH-bootstrap.md` 同族同治，见 §10.14。

测试旋钮 `SUPPERH_DIST_DIR`（与 `SKIP_QODER_INSTALL` 同类）：`node --test` 是文件级并发，而 `tests/mcp-manifest.test.mjs` 会真跑 sync（rmSync 后重建 `dist/`），安装测试读真 dist 就是偶发 ENOENT。并发套件里依赖共享可变产物的用例，必须自带副本。

### 10.14 注册项目只有一个入口：bootstrap 建目录，init 写条目（F-9）

`scripts/bootstrap.mjs` 与 `commands/supperH-bootstrap.md` 曾是注册项目的**第二个**入口：从 `schemas/project.example.yaml` 拷一份写 legacy 单文件 `<私有根>/project.yaml`，再交互问四个字段。看着只是“多一条便路”，实际是三件事叠在一起：

- **劣化复制**：无扫描（结构字段全靠人肉猜）、无探活门禁、无菜单采集，而这三样正是 `/supperH-init` 存在的理由；两个入口并存时用户不知道该跑哪个。
- **产物形态倒退**：落的是注册表模型之前的 legacy 单文件，事后还得靠 `scripts/migrate-registry.mjs` 收尸（§10.12）。
- **模板假值的第二个造入口**：`setup.mjs` 因同样的手法被改掉（上一条纪律），bootstrap 不改就是漏网。

现在的边界：**bootstrap 只建目录 + `prefs.md`，一个 yaml 条目都不写**；要注册项目就到目标工作区跑 `/supperH-init`。三条机械表达：本命令 front-matter `edit: deny`（写配置的能力直接不给）；`--force` 随“覆盖条目”这个职责一起消失，传了就报错退 2 并指回 `init-project.mjs --write`（静默忽略等于假装还在听旧协议）；legacy 文件默认只报告、`--migrate` 才动，且原文转 `project.yaml.migrated.bak` 保留。

骨架子目录清单收敛为 `resolve-private-root.mjs` 的 `PRIVATE_SUBS` 单点导出，`bootstrap.mjs` 与 `setup.mjs` 共用。历史上这两处各写一份，漂移过一次：迁移出来的根缺 `menus/`。

### 10.15 branches：未检出的分支名不写盘（F-8）

`branches` 是 `--env` 诊断基线的读取源之一（`resolveDiagnoseBaseline` 拿环境名去比对 `branches` 与 `db.schemas`）。缺陷形态很隐蔽 —— **不是 init 主动写假值**，而是三件事合起来把假值变成事实：

1. 渲染器只改写**检出的键**，未检出的键原样留在文本里；
2. 模板 `schemas/project.example.yaml` 的 `release-main` / `staging` / `develop` 是活值（不是注释），于是未检出的项目把三个形似名字烤进配置；
3. schema 把三键列进 `branches.required`，validate 只会放行。

旧测试里那句 `doc.branches == {prod:'release-main', uat:'staging', dev:'develop'}` 甚至把这个泄漏锁成了期望。后果是拿得出一套结构合法、过全部校验、却指向仓里不存在分支的现场。

修法是四处一致（同 §10.12 的“缺席即语义”，但键位不同）：

| 环节 | 实现 | 未检出时的行为 |
|---|---|---|
| 扫描 | `pickBranch` 只认真出现在 `git branch` 里的名字，命中给 `{name, detected:true}`，否则 `name: null` | 下游拿不到一个可以当事实用的字符串（比“带标记的假值”更难误用）|
| 落盘 | `applyBranchSection` **整段重建**，只写 `detected && isGiven` 的键；一个都没有 = `dropSection` | 盘上缺席，不留模板字面量（行内替换做不到这件事：它只能改写已存在的键）|
| schema | `branches` 退出顶层 `required`；写了则内部 `required: [prod]` + 值 `minLength: 1` | 半截比不写更糟；`prod: ""` 在 `--env` 会长成一个合法环境名 |
| 汇报 | `branchMappingOf` 回 `declared` / `undeclared` / `note`，命令层原样复述 | “当初就没答”与“解析器坏了”分得开 |

两条推定的理由：

- **没把握的默认值不配被烤进配置**：猜中也该让人看见（进步骤 2 问），而不是长得象事实。`--values` 回灌路径同时把 `branchesDetected[k]` 转 true —— 用户确认过的就不是猜的。
- **环境键清单单点**：`BRANCH_KEYS = ['prod','uat','dev']` 被扫描 / 覆盖 / 落盘与汇报三处共用，否则会长出“扫得到却永不落盘”的第四种键（schema 是 `additionalProperties: false`，那种键还会反过来把已注册项目打成 exit 2）。

### 10.16 槽位名归用户：L1 不得持有“外部源名单”（F-10 / F-11）

缺陷形态：L1 把四个键名（历史上是 database / logs / tickets / efficiency）当成“可用的外部源”，在四处同时生效 —— schema 的 `properties` + `additionalProperties: false`、`init-project.mjs` 的 `DRIVER_SLOTS` 常量与探测循环、扫描 JSON 的 `connectSlots`（命令层照着摆多选题）、以及产物里的 `{{PROJECT.drivers.<名字>.*}}` token。第 5 个源根本注册不进来（实测：`$.drivers.sms: additional property not allowed` 退 2），而 `tickets` / `efficiency` 本身就是某家公司的产品类别（R3 的 L2 泄漏）。改 L1 去加源看起来像正常演进，实际是在**替所有项目规定源的名字与个数**。

改后六处必须一致（只改其中一处会留下“其他五处还在假设四个源”的裂口）：

| 环节 | 实现 | 判据形态 |
|---|---|---|
| schema | `drivers` 改用 `patternProperties: "^[A-Za-z][A-Za-z0-9_-]{1,39}$"` → `driverSlot`，不列名字 | 形状与动作词表归 L1，名字与个数归 L2 |
| 语义标记 | `role` 枚举只有一个值 `database` | 唯一有机器语义的槽位属性（写保护绑它），全项目最多一个（validate 拦） |
| 人话描述 | `desc`：schema **不** required（存量文件不得一夜全灭），登记入口必填 + validate 逐槽位告警 | L1 判“这个源是干什么的”的唯一线索 |
| 登记入口 | `commands/supperH-driver.md` + `scripts/driver-registry.mjs`（add/update/remove/list：先备份 → 内存过 schema → 探活不过不落盘）；驱动不存在时派 `driver-author` 先写实现 | 与 `/supperH-init` 解耦：init 只问“要不要先接一个”，源可多次添加 |
| 解析器 | 输出派生字段 `dbDriver`（`{slot, kind, impl, healthCheck}` 或 `null`；按 role 解，判定规则单点复用 `validate-project.mjs:dbRoleSlot`）；`preflight.driverSlots` 遍历实际键 | “没库”是值为 `null` 的可机械区分事实，不是一个解不开的 token |
| 取数面 | MCP 壳工具收缩为 `db_query`（role: database）+ `query`（通用），`ROLE_OF_TOOL` 按 role 判 | 外连工具面与 role 语义一致，不再假设源的种类与数量 |

三条推定的理由：

- **`dbDriver` 是派生别名，不是第二个真相源**：它由 `drivers` + `role` 现场解出，不落盘、不可手写进 YAML、schema 里没这个属性。另一条路（在 L1 里列“允许的名字”）之所以不通，是因为那恰好是本次要治的病。重复 role 时按**键名排序**取首个（`Object.entries` 跟随 YAML 书写顺序，不排序就会让“同内容不同键序”的两份文件解出不同库通道且都退 0）。
- **按 `desc` 选源只允许发生在“失败方向安全”的位置**：anchor-lookup 用哪个槽位靠读 `desc`（候选 ≠ 1 即出局），因为选错最多导致反查失败 → 升格完整路径，不可能把错的 route 递进门禁；而边界判据（谁能往私有根写）必须**无分支**，所以那边用的是路径前缀锚点而不是描述文本（同一句“确定性门禁优于模型判断”，两处的正确读法不同，见 §5 “为什么是两个而不是一个”）。
- **动作词表新增一项的门槛**：同类动作在 ≥ 2 个项目里出现过才进 `writeAction` 枚举。`other` 是泄压阀（必须带 `userPhrase` 且命令要问归类），“永远停在 other”是审计链上的洞而不是合法答案；把某个产品名塞进词表 = 把 L2 事实写进 L1 协议。

机械锁：`tests/l1-slot-neutrality.test.mjs`（prompt 侧出现旧名或名单枚举即红，**无例外分支**）、`tests/driver-registry.test.mjs`（登记与探活）、`tests/resolve-project-cli.test.mjs`（`dbDriver` 形态与排序确定性）、`tests/agent-permissions.test.mjs`（放开面名单）。

第七处落点在菜单配置里，而且它是唯一一处理论上可以静默坏掉的：`menus/<code>.yaml` 由 `renderMenuConfig` 从 `schemas/menu.example.yaml` 行级改写而来，而 `setLine` 的语义是“没答就不改写”——于是模板里的**活值** `slot: database` 会原样落进每一个没被问过 slot 的项目。F-10 之前它凑巧能用（库槽位就叫 `database`）；F-10 之后库槽位名归用户，它变成“菜单学习去查一个本项目不存在的槽位”——不报错，只是查不到。同一个机制还把整段未被选中的分支留在盘上（选 `code` 的项目带着一套完整的 `sys_menu` / `menu_id` 假列名），而日后按本文“换菜单来源只改这个文件”翻过来时，那段假值看起来像已经答过。

所以菜单这一路改成三条（与 §10.12 / §10.15 同纪律，不是新发明）：没答的可选键**删行**（`slot` / `order` / `rootParentId` / `extraFilter`；`limit` 5000 与逻辑源名 `menu` 是文书里写明的缺省，不删）、未被选中的分支**整段不写**、选中的那一支必填项缺任一项则**写盘前退 2**（`planMenuChoices` → `menu-choices-incomplete`，逐项点名）。菜单比 `db` 段更需要这道机械拦：`validate-project.mjs` 不读 `menus/*.yaml`，模板残留扫描也只盖 projects 条目——菜单写坏没有任何一层会在后面兜住。

## 11. 一期范围与二期规划

**一期做**：

- L1 全部资产（本仓库）
- L2 schema + example（`schemas/project.schema.yaml` / `project.example.yaml`）
- 可跑 JSON 示例驱动（`drivers-skeleton/`）
- sync + validate + bootstrap 脚本
- `.qoder/rules/` 四份零配置红线
- 6 个命令：一期主流程 `/supperH-bug`、`/supperH-learn`、`/supperH-bootstrap`，注册链路 `/supperH-init`（落 `projects/<code>.yaml` + 探活门禁 + `kind` 探测）、数据源登记链路 `/supperH-driver`（槽位名归用户，走 `driver-registry.mjs`）与安装链路 `/supperH-setup`
- 11 个 subagent（8 个 bug-* + 2 个 prelearn-* + 1 个 driver-author 驱动写作）
- 5 个 skill（prelearn / data-fetch / auto-fix 协议骨架 / driver-contract / incident-triage 现象分诊）
- **快路径门禁 P0**：`scripts/fastpath-gate.mjs`（G0–G4 + 否决表 + 退出码 30–36，第 37 码由下述 P1 补）、`resolve-project.mjs` 带 `--module/--anchor/--text` 扩展、jsonl 记账、`.qoder/rules/` 与 `commands/supperH-bug.md` 同步、`tests/` 34 条用例
- **快路径门禁 P1**：`fastPath` L2 覆盖接线（schema 声明 `enabled/maxDiffLines/maxFiles/allowAnchorKinds` + `resolve-project` 传值）；G5 脚本化（`verifyImpactReport` + 退出码 **37** + `--impact-json`/`--impact-report`）；A1 锚点（`traceId`/`ticketNo`）**识别**与保守出局（`needsLookup`）+ F1.4 反查链路（`bug-analyzer mode=lookup` + `data-fetch` anchor-lookup 契约）
- **快路径 G4 batch 化（P1.5）**：G4 从仓库粒度收窄到 batch 粒度（G4a 仓库级全等 + G4b `git diff ∩ sources` 交集复核），否则“任何人提一次交”就会把全仓快路径永久打成 35。连带变更：`index.md` 机器契约升 `supperh-index/2`（反查表六列 → **七列**，新增 `sources`），缺列即 32；退出码 **35 的语义变窄**（行为变更，不与码值变更混淆）；analyzer 输出契约新增 `touched_files`/`sources_incomplete`，writer 模板同步；jsonl 增记 `batch`/`g4b`。所有不确定形态一律 fail-closed 判 35，不把误杀换成漏杀。
- **意图复述 I0（本轮）**：`fastpath-gate.mjs` 新增 `verifyIntent`（五条判据见 §10.11）+ 退出码 **40**（故意在 30–37 连续段外）；`resolve-project.mjs` 新增 `--intent-json`/`--intent-report`（互斥、一次给全）与 `--anchor-source lookup` 豁免；**两条路径常驻**（完整路径拿 `--anchor ""` 求值后改读 `fastPath.intent`）；jsonl `anchor_gate` 行埋 `intentGiven`/`intent{}`/`anchorSource`；`skills/incident-triage` 承载三层语义模型与现象类别；`--preflight`（只集本地事实、脏文件只记录不阻断）与 `git.deliveryMode` 缺省 `none` + `git stash create` 快照（§10.10）。**注意一处隐性接线**：F3 回灌模式（`--anchor` + `--text` + `--impact-json`）会在同一进程里重跑整条锚点门禁，`--intent-*` 因此也是它的必填入参 —— 漏带会被自己判成 36（`impact.applied:false`，G5 根本没求值），不是 G5 判宽。
- **双通道取数（二期已落地部分）**：L1 带 MCP 壳 server（`mcp-skeleton/shell.py` + 共享契约包 `supperh_contract/`）。注册表只有一条 `supperh-drivers`（插件相对路径 + 零凭据），项目 adapter 由壳运行期 `importlib` **查找**装载 —— 加项目不改注册表也不改 IDE 配置，"项目配了但 server 没注册"这类漂移结构性消失。通道分类只有两条（`script` / `mcp`）；官方 server 与自研 adapter 属配置选型，不进入 L2 枚举。守卫唯一化：L1 发 `supperh_contract` Python 包，adapter 一律 import，不复制守卫。`kind`/`fallback`/`mcp` 三个字段入 schema；原门禁槽位 `vpnPreCheck` 已删（执行前预检实测无效，理由与实测数据见 §10.8），schema 保留键、validate 只发废弃警告；`healthCheck` 一律是本地脚本且必须协议级；`kind` 由 `/supperH-init` 注册期探测机械写定（探不过→回写 `kind: script`；`fallback: none` 只报 blocked 不悄悄翻写），会话内只读不重探。MCP 取数工具只绑 4 个只读/测试类子 agent，主 agent 与命令入口一律不绑。

- **外部数据源可选化（本轮，见 §10.12）**：`schemas/project.schema.yaml` 顶层 `required` 去 `db`/`drivers`；`init-project.mjs` 新增 `planConnections`/`applyConnectionChoices`（不接 = 整段不写，接 = 整段生成，接一半 = 写盘前退 2 `connection-choices-incomplete`）；`validate-project.mjs` 新增 `checkTemplateResidue`（`example_*` 残留 → 2）与 `checkDbDriverCoherence`（有驱动无库 = 错、有库无驱动 = 警告）；`resolve-project.mjs --env` 在无 `db` 段时退 **36**（36 的触发条件扩展，**码集不变**）。`schemas/project.example.yaml` 的 db/drivers 两段改为注释形态的字段说明书（模板不再携带可被误用的假值），`/supperH-init` 步骤 2 改为一次多选接入清单。**端到端实证顺带抓出一个只在真实 CLI 路径才触发的缺陷**：`initWrite` 里 `cfgText` 被误写成 `const`，`decideChannels` 回写 `kind` 时抛 TypeError → `--write` 每次退 1，而当时全绿的都是渲染层用例。已修，并补 2 条 `spawnSync` 真实 CLI 用例（纯代码模式退 0 且落盘无 db/drivers；接一半退 2 且不落盘）—— **落盘类行为一律要有走命令行的用例，只测渲染层等于没测**。

- **L1 纯度门禁（本轮，对外发布前的补欠）**：`sync-assets.mjs` 新增 `checkL1Purity()`，`--check` 与写模式（构建 dist 前）都是**退 5 硬阻断**。判据两条：上传物里不得出现注册条目的专有值（`identity.code` / `displayName` / `aliases[]` / `packageRoot` / `codeRoot` / `db.host` / 三个库名 / 两个账号 / `forbidWriteSchemas[]`），也不得出现本机三个绝对路径（私有根 / 仓库父目录 / 家目录）。三个设计决定：① **值从 L2 运行期取，不写硬黑名单**——把公司名抄进 deny 列表等于把它再公开一遍；② 比对按**段**过滤示例形态（`example_*` / `demo_*` / `<占位符>`），否则模板自身天天误报；③ 不把模块名/分支名当事实（`order` / `dev` 这类高复用词淹没信号），环境词（prod/uat/dev）也**不列进过滤表**——列了会连带屏蔽掉 `<code>_prod` 这种真库名。为什么现在才做：文档与红线一直写着“sync 的敏感字扫描会拦下”，而这条扫描从未存在；失去机械判据后，真实项目短码、真实包根、真实工作区路径成片躺在 `tests/` 夹具与 `mcp-skeleton/README.md` 示例里（手工才找得到，因此对外发布前的全量人工扫描是必须的一道）。同时 `main()` 加了 `import.meta.url` 守卫——无守卫的入口脚本被测试 import 时会重烤 dist 并 `process.exit`。
**一期不做**：

- `/supperH-flow`、`/supperH-package`、`/supperH-test`（二期）
- 真实内网 driver 实现（用户自开发放 `{{PRIVATE_ROOT}}/drivers/`）
- 真实私有 MCP adapter（`{{PRIVATE_ROOT}}/drivers/<code>/adapter.py`）与官方数据库/日志 server 的内网可用性探测；每项目独立 venv（现共享解释器 site-packages）；IDE 对 MCP `tools/list_changed` 的消费行为未实测，不作设计地基
- 存量仓库（跨仓）命令行里的路径字面串 → token 收敛（需先定位到真实 driver 迁入 `{{PRIVATE_ROOT}}/drivers/<code>/` 后才能验收“正则 `python\s+"?[A-Za-z]:[/\\]` 命中数 0”）—— L1 自身的 `{{DRIVERS_ROOT}}` 展开缺陷已修（见 §9 与 `docs/placeholders.md` §3.3）
- 工单 watcher（task-1024 已定为二期）
- Claude Code / DSH 兼容层（二期）
- marketplace 发布通道（二期）
- auto-fix 的 CLI 化实现（一期只出协议骨架）
- **快路径 P1 未完部分**：A1 锚点反查的**实际内网 driver 实现**（由用户经 `/supperH-driver` 逐个登记；L1 不规定它叫什么名字、也不假设有几个）——代码/契约/退出码已全部就位，缺的只是驱动本体；驱动未就绪时 F1.4 自动退回完整路径
- **快路径 P2**：按 §10.6 的 jsonl 真实样本校准 `DEFAULTS`/`HARD_CAPS`；评估 A2（异常栈）在完整度 ≥ 某水位后放行；评估 analyzer 多维度并行 fan-out

## 12. 版本演进策略

- `package.json` 里的 `version` 决定插件版本
- `schemas/project.schema.yaml` 顶层 `schemaVersion: const 1` —— 破坏性变更时 +1；sync 会做兼容检查
- `driver-response.schema.json` 里 `meta.schemaVersion` —— 同上
- 三层版本解耦：L1 迭代不动 L2 schema；L2 schema 迭代不动 L3；L3 无版本概念
- **退出码是对外契约**：新增码（如本轮的 33、36，以及后来的 37、**40**）属 additive，但**旧提示词副本不认识新码** —— `{{TOOL_ROOT}}` 被烤成绝对路径后，脚本从仓库工作副本直接执行（改动即时生效），而 command/agent/rules 文本从插件安装目录加载（必须 sync + 重启才生效）。两边代际不一致时，新码会落到旧文本的未定义分支。所以：**改退出码集合必须与 sync + 重启同步交付**。

## 13. 一句话总结

**L1 是协议 + 编排骨架；L2 是唯一变量；L3 只影响输出不影响决策；驱动只放骨架不放内网实现；sync 用绝对路径 + 残留阻断保证部署产物自包含；而“能不能走快路径”从来不是 LLM 的判断——它是 `resolve-project.mjs` 的退出码。**
