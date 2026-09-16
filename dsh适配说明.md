# DSH 适配说明 · 在 DeepSeek Harness 里用 /supperH

<div style="background:#fff0f0;border-left:4px solid #d40000;padding:8px 12px">

**⛔ <span style="color:#d40000;font-size:115%">不建议使用：走 DSH 需要适配的文件过多</span>**

<span style="color:#d40000">为了把 6 个 `/supperH-*` 命令搬到 DSH，实测需要动 <b>9 个仓库文件</b>（3 个新增 + 6 个修改）<b>＋ 2 处仓库外的 harness 配置</b>，此后还要永久承担"改了源就得三边各装一次、这份说明也得跟着改"的漂移成本；而其中最硬的一环（per-agent 权限矩阵）<b>在仓库里根本表达不出来</b>，只能在 DSH 的 preset 里另立一份真相。收益只是"能在 DSH 里敲手势"，代价是一条长期维护的第二通道 —— 所以本仓库<b>不提供 DSH 安装通道</b>。</span>

**结论：要用这套流程，请在 Qoder 或 OpenCode 里用（见同目录 `qoder适配说明.md` / `opencode适配说明.md`）。** 本文件只保留两类内容：**DSH 的机制事实**（都带实测来源，别再让人重新踩）与**"真要适配得动哪些文件"**。文中提到的 `--target dsh` 等命令**不存在于本仓库**。

</div>

---

## 一句话结论

**DSH 没有"命令目录"这个概念** —— 它唯一能吃到 `/xxx` 的通道是 **skill 的 `/name` 手势**，而手势名与 skill 目录名**强制全小写 kebab-case**。所以：

- `/supperH-bug` 在 DSH 里**永远解析不到**（harness 的硬校验，不是配置问题、不是版本问题）。能敲出来的最接近形态是 `/supperh-bug`。
- 要拿到 `/supperh-bug`，必须新增一条"把 `commands/` `agents/` `skills/` `.qoder/rules/` **生成**成 DSH skill"的通道 —— 这就是上面红字说的成本。
- 而**取数、门禁、学习数据这些主流程在 DSH 里并不受阻**：可变态全在私有根，脚本判据与 IDE 无关（见 §门禁的公用性）。也就是说 DSH 缺的是"**入口**"和"**每轮自动注入的红线**"，不缺"**内核**"。

---

## 为什么会这样（DSH 的六条机制事实，逐条可复核）

| # | DSH 的机制 | 结论 |
|---|-----------|------|
| 1 | **斜杠入口只有 skill 手势。** 用户命令注册表（`dsh-commands`）只接受插件代码注册的 `CommandDefinition`，**没有** markdown 命令目录扫描；而 skill 消费方 `dsh-tool-skill` 的 pre-step 监听器扫描"已认领的用户消息"，命中某个 **user-invocable** skill 的 `/name` 就把它的**完整正文**作为该步骤的指令上下文注入（与 `skill` 工具加载同一份 `<skill_content>` 渲染） | 命令要能在 DSH 敲出来，就必须**变成 skill** |
| 2 | **skill 名与手势名都强制 kebab-case 全小写**：`^[a-z0-9]+(?:-[a-z0-9]+)*$`（`skill-filesystem` 校验 + `parseCommand` 的 `^\/([a-z][a-z0-9_-]*)`）；且 `<目录名>/SKILL.md` 的目录名**必须等于** frontmatter 的 `name`，不等则**整条被丢弃**（只留一条 warning） | `supperH-` 前缀只能降格成 `supperh-`；这是本仓库命名空间与 DSH 语法的唯一冲突点 |
| 3 | **skill 只被发现一层**：`<扫描根>/<name>/SKILL.md` 或平铺 `<name>.md`（不递归 `**/SKILL.md`） | 22 个资产 = 22 个一层目录，无法打包成一个插件目录了事 |
| 4 | **扫描根按 rank**：`<项目根>/.dsh/skills`(100) → `<项目根>/.agents/skills`(200) → custom(300) → **`$DSH_HOME/skills`(400)** → `~/.agents/skills`(500)；`$DSH_HOME` 未设时是 `~/.dsh`；项目根 = 最近的含 `.git` 的祖先 | 全局装一次可跨项目；也可按项目装 `<项目>/.dsh/skills`（rank 100 会遮蔽全局那份） |
| 5 | **DSH 没有 rules 目录**，对等能力是 `AGENTS.md`：每步注入 **`$DSH_HOME/AGENTS.md`** 与项目根（及被 read 触达的嵌套目录）的 `AGENTS.md` / `CLAUDE.md`；候选名固定（带目录分隔符的候选会被判非法丢弃），有渲染预算 `maxBytes`（随附 bundle 用 65536），超预算时**更具体的文件优先、全局那份先被省略** | 红线四件套约 37 KB：塞得进预算，但会挤压用户项目自己的 `AGENTS.md`；且**没有** OpenCode 那种"指回工具仓"的机制 → 只能拷/粘，必然漂移 |
| 6 | **subagent 是运行时 provider**（spawn / fork / claude-code / codex…），**没有按文件注册 subagent 的目录**；模型侧只有 `subagent` / `subagent_fork` / `send_message`，入参是 prompt。**也没有** per-agent 的 `permission:` / `mcpServers:` —— 权限粒度是**父会话的 sandbox/approval 策略，由子 agent 继承** | 11 个 agent 定义只能当"角色 skill"（加载正文 → 塞进 `subagent` 的 prompt）；`edit: deny` 这类**逐 agent 能力开关无处声明** |

---

## 门禁的公用性：三层结论（正面回答"这套东西能不能三家共用"）

| 层 | 承载 | 公用性 | 依据 |
|---|---|---|---|
| **A 确定性脚本门禁** | `resolve-project.mjs`（10/11/12、快路径 G0–G4b、I0、G5、`--preflight`、`--flow-readiness`、`--flow-plan`）、`fastpath-gate.mjs`、`git-preflight.mjs`、`validate-project.mjs`、`driver-registry.mjs`（探活不过不落盘、`--force` 才降级）、`flow-engine.mjs`、`sync-assets.mjs --check`（残留=1 / 陈旧=4 / 纯度=5 / 名字空间=7） | **100% 公用**：三家 + 人在终端跑出来是同一道结论 | 判据只有三样 —— node 进程退出码、stdout JSON、stderr；脚本不读任何 IDE 变量。把 `{{CONTEXT_ROOT}}` 一类改成"步骤 0 运行期现填"正是为此设计的 |
| **B 红线四件套** | `.qoder/rules/*.md` | **文本公用，装载机制不公用** | Qoder：`plugin.json` 声明 `rules/`，每轮注入。OpenCode：`opencode.json` 的 `instructions` glob 指回工具仓（每轮注入 + 单一真相）。DSH：只认 `AGENTS.md` / `CLAUDE.md` 固定候选名 → 只能拷/粘一份，退成拷贝件 |
| **C 权限门禁** | `agents/*.md` 的 `permission:` + `mcpServers:` | **不公用**（是**声明位置**不同，不是格式不同） | Qoder/OpenCode：权限写在**每个 agent 文件**里，机制强制（9 个 deny + 2 个精确 allow）。DSH：粒度是**父会话 sandbox/approval，子 agent 继承**；per-agent 收窄只存在于 harness 的 preset / persona + 工具过滤层（插件组合 YAML） |

> **一句话**：真正决定分流与写保护的判据全在 **A 层，A 层完全公用**；红线（B）跨 IDE 文本共用、装载各配各的；只有 **C 层（谁被允许改文件）** 在 `.md` 资产里表达不出来。所以"门禁在 DSH 上无法公用"这个判断**只对 C 成立**，不是整体不可用。

---

## 红字的技术依据：真要适配，得动这些文件

上一轮做过一次完整实现并端到端验证过（装进 `$DSH_HOME` 后目录里确实出现 17 个 `supperh-*`、`AGENTS.md` 区块确实被注入；`node --test` 311 例全绿、`sync --check` 全绿），随后**按本文件的结论全部回退**。留下的账本：

| # | 文件 | 为什么非改不可 |
|---|------|---------------|
| 1 | `scripts/dsh-assets.mjs`（**新增**） | 生成层：`supperH-*` → `supperh-*` 命名降格、frontmatter 翻译成 DSH 的键（`disable-model-invocation` / `user-invocable`）、每个正文头部注入"工具映射 + 权限语义 + 角色引用规则"preamble、红线四件套合成一个 skill、`AGENTS.md` 带标记区块的 created/appended/replaced 合并 |
| 2 | `scripts/setup.mjs` | 新增 `--target dsh` 分支 + 安装函数 + 清单式陈旧产物清理（`supperh-installed.json`）+ next steps 文案 |
| 3 | `scripts/detect-ide.mjs` | DSH 探测（否则 `--target auto` 在这台机器上仍会选 Qoder）+ 技能通道探针 + 6 个手势的清单 |
| 4 | `tests/setup-dsh.test.mjs`（**新增**） | 9 例：命名合法性、命令/角色/协议的 frontmatter 通道语义、幂等、按清单清理不误删用户文件、`AGENTS.md` 三种合并形态、`.dsh` 结尾时区块落项目根、私有根不造 legacy 条目。**没有这层，"名字合法吗"这类问题会静默失效**（skill 名不合法 = 整条被丢弃，只留 warning） |
| 5 | `README.md` | 分支表"两份→三份"、一行安装、命令一览的名字形态注、脚本入口表 |
| 6 | `docs/architecture.md` | 拷贝件纪律从"两边各装一次"变"三边"、文档清单 |
| 7 | `scripts/sync-assets.mjs` | L1 纯度 / EOL 扫描名单（`L1_SCAN_FILES`）要加本文，否则这份文档躺在仓库里没人管行尾与专有值泄漏 —— **本文件目前不在名单里，就是这条成本的现状证据** |
| 8 | `package.json` | keywords（小） |
| 9 | **22 个资产的正文引用** | 正文按 `supperH-<x>` 指名角色与协议、按 `/supperH-<x>` 指入口。不改源 → 需要 #1 那层 preamble 做映射；改源 → 牵动 `tests/asset-naming.test.mjs`、`tests/agent-permissions.test.mjs`、`l1-purity` 三道门禁与 Qoder/OpenCode 两侧 |
| 10 | **仓库外：DSH profile / preset** | 补 C 层的权限矩阵（persona + 工具过滤）与 MCP 通道条目。**这是第二份真相**，不在 git 里，也不会被本仓库任何测试覆盖 |
| 11 | **此后每次改源** | `commands/` `agents/` `skills/` `.qoder/rules/` 一改就要三边各装一次（Qoder 重启、OpenCode 重跑、DSH 重跑）；DSH 侧是 23 个拷贝件 |
| 12 | `dsh适配说明.md`（**本文件**） | 一旦真开了 DSH 通道，本文的**每一节都会失效**：顶部红字的文件数、"本仓库不提供 DSH 安装通道"这句结论、`--target dsh` 的"不存在于本仓库"注记、§如果将来仍要走（要改成 §装法）、§现在就能用/用不了 表的第 2 行、§与 Qoder / OpenCode 的差异对照 的"本仓库提供安装通道？= 否"行，以及 `README.md` 分支表与 `docs/architecture.md` 的"两份/三边"计数。**它是这份清单里"已经在仓库里、却没有任何测试兜着"的文件** —— #1–#4 有 `tests/setup-dsh.test.mjs` 兜，#5–#8 有 `sync --check` 兜，本文件没有（它甚至不在 `L1_SCAN_FILES` 里，见 #7）；只有 #10 同样无人兜，但 #10 在仓库外，至少不会像这样在 git 里留下一段过期结论。要么把它也纳入 #7 的名单，要么接受它长期说谎 |

**成本不对称的地方**：#9 与 #10 是长期税，#1–#8 只是一次性，**#12 是纯长期税**（一次性成本为零、遗漏概率为 100%）。而且 #10 意味着"权限"这件事从 git 里**漏出去**了。

---

## 如果将来仍要走这条路（最小正确形态）

1. **命令入口** → user-invocable 且 `disable-model-invocation: true` 的 skill（对等 Qoder 的 `mode: primary`：入口是"人来点"，不该被模型自己翻出来执行）。手势后跟的自由文本就是入参（DSH 没有正式 `{{args}}`，靠模型自己读那句话）。
2. **11 个 agent** → `user-invocable: false` 的**角色 skill**；派发时先 `skill` 加载正文，再把「正文 + 本次任务」交给 `subagent`。写类角色必须串行（DSH 的 `subagent` 默认后台，不传 `run_in_background: false` 就拿不到结果，写类互斥会被悄悄破坏）。
3. **5 个协议 skill** → 原样转成 `supperh-<x>`（本来也是按需加载，语义一致）。
4. **红线** → `AGENTS.md` 只放"入口 + 工具映射 + 权限语义 + 拷贝件纪律"的**短区块**（带标记，可整块替换），全文做成 `supperh-rules` skill 按需加载。要 always-on 就把四件套整段粘进 `$DSH_HOME/AGENTS.md`（37 KB < 65536，放得下），代价是漂移 + 挤压项目自己的指令预算。
5. **工具映射**（写进每个生成件头部，正文逐字保留）：`question` → `ask_user_question`；`task`/agent 派发 → `subagent`（+ `subagent_fork` / `send_message`）；`bash` → `pwsh`；`read`/`edit`/`glob`/`grep` 同名。**不做机械改名**：`agents/supperH-driver-author.md` 这类是真实路径，全局替换成 `supperh-*` 会指向不存在的位置。
6. **MCP 通道**：profile 加一条 `@deepseek-ai/dsh-mcp-client`（`serverName: supperh-drivers`，stdio，`command: python`，`args: [<工具仓>\mcp-skeleton\shell.py]`，`env.SUPPERH_PRIVATE_ROOT=<私有根>`），**需重启该 profile**。默认全槽位 `kind: script`，不配也照跑。`serverName` 会进工具名 `mcp__<serverName>__<tool>`，改名等于换工具。
7. **权限矩阵**：见 §需要这么做 第 2 条 —— 只能在 harness 的 preset/persona 做，`.md` 里做不了。

---

## 现在就能用 / 用不了（DSH 未适配状态）

| 想在 DSH 里做的事 | 现状 |
|---|---|
| 敲 `/supperH-bug` | ✗ 语法上不可能（强制小写） |
| 敲 `/supperh-bug` | ✗ 本仓库不提供生成通道，装了也不会有出处 |
| 让模型读 `commands/supperH-bug.md` 并照做 | ✓ **可行且是当前的推荐用法**：直接说"读 `c:\...\supper-Han-java\commands\supperH-bug.md` 并按它执行"，正文里的绝对路径本来就是烤好的 |
| 跑脚本门禁 | ✓ 完全公用（A 层，与 IDE 无关） |
| 读私有根 / 学习数据 / 任务台账 | ✓ 完全公用，三边互通 |
| 红线每轮自动生效 | ✗ 没有 rules 装载机制；`AGENTS.md` 里没写就不注入 |
| 只读子 agent 物理禁写 | ✗ 只能靠会话文件策略 + 审批（粒度是整会话，不是逐 agent） |

> 第三行是"零适配"的正解：**DSH 的 `read` 工具能直接读到工具仓的原文**。牺牲的是"输入框里 `/` 一下"的便利与红线的自动常驻，换来的是不动任何文件。真要长期在 DSH 里用，这条路比开第二通道便宜得多 —— 可以把 `commands/supperH-bug.md` 的绝对路径存成自己的常用语。

---

## 需要这么做（要动手时的清单，本仓库当前不实现）

1. **红线要 always-on（补 B 层装载）**：把四件套整段粘进 `$DSH_HOME/AGENTS.md`。两个代价要认：改红线必须重贴（漂移源）；这份全局文件会挤占项目自己 `AGENTS.md` 的渲染预算（超预算时更具体的文件优先，全局那份先被省略）。
2. **权限矩阵要机制强制（补 C 层，唯一的正解）**：在 DSH 的 profile / preset 里做 persona + **工具过滤**，产出两条委派工具行（例如 `subagent_readonly` 禁写、`subagent_writer` 只放开 `context/` 与 `drivers/` 所需策略），命令正文按角色 → 对应工具行派发。**这件事在 `.md` 资产里做不了**：DSH 的 skill 没有承载 `permission:` 的位置，`subagent` 工具也不接受 per-call 策略参数（只有 `description` / `prompt` / `run_in_background`）。且 DSH 的工具过滤语义是"**可见性而非权限**" —— 真要硬边界必须同时靠会话文件策略。
3. **写类流程的运行前提**：`supperH-prelearn-writer`（落 `context/`）与 `supperH-driver-author`（落 `drivers/`）必须在**可写会话**下跑。私有根在 workspace 之外 → 落盘会走审批，这一条恰好等价于 `external_directory` 边界，且对**所有** agent 生效（粒度比 Qoder 更宽）。只读会话下这两个角色会如实停下，那是正确行为，不是 bug。
4. **`/supperH-*` 这个名字本身**：`^[a-z0-9]+(?:-[a-z0-9]+)*$` 是硬校验。不接受降级的唯一出路是**不在 DSH 上用手势入口**（把命令正文当 model-invocable skill 让模型加载），代价是入口不再"人来点"，与 `mode: primary` 语义不符 —— 也就是上面表格里"推荐用法"那一行。
5. **数据层不需要任何适配**：可变态全在私有根（`projects/ screens/ context/ tasks/ drivers/ prefs.md`），路径 token 由主 agent 步骤 0 跑 `resolve-project.mjs` 现填。唯一前提是**三边用同一个私有根**：谁设了 `SUPPERH_PRIVATE_ROOT` 就会静默裂成两份数据。自检：`node "<工具仓>\scripts\resolve-private-root.mjs"` 在各边各跑一次，比对 `privateRoot` 与 `registryCount` 完全相等。

---

## 清理本机上一次的实验残留（如果还在）

上一轮曾把生成件装进过 `$DSH_HOME`。仓库代码已回退，那份安装现在是**没有出处的拷贝件**，确认要清掉的话在终端执行：

```powershell
$root = if ($env:DSH_HOME) { $env:DSH_HOME } else { "$HOME\.dsh" }
Get-ChildItem "$root\skills" -Directory -Filter 'supperh-*' | Remove-Item -Recurse -Force
Remove-Item "$root\supperh-installed.json" -ErrorAction SilentlyContinue
# AGENTS.md 只摘托管区块（BEGIN/END supperH rules 之间），别整文件删：那可能是你自己的项目规则
if (Test-Path "$root\AGENTS.md") {
  $t = Get-Content "$root\AGENTS.md" -Raw
  if ($t -match '(?s)<!-- BEGIN supperH rules.*?<!-- END supperH rules -->\s*') {
    Set-Content "$root\AGENTS.md" ($t -replace '(?s)<!-- BEGIN supperH rules.*?<!-- END supperH rules -->\s*','') -NoNewline
  }
}
```

判据：清完后 `Get-ChildItem "$root\skills" -Filter 'supperh-*'` 应为空，且 DSH 会话的技能目录里不再出现 `supperh-*`（**无需重启**，目录有 watcher，下一个步骤就刷新）。

---

## 与 Qoder / OpenCode 的差异对照

| 维度 | DSH（本文件） | Qoder | OpenCode |
|------|--------------|-------|----------|
| 本仓库提供安装通道？ | **否**（成本不对称，见红字） | 是（`sync-assets.mjs`） | 是（`setup.mjs --target opencode`） |
| 斜杠入口机制 | skill 的 `/name` 手势（**无命令目录**） | 插件声明的 commands | `command/` 目录扫描 |
| 命令名形态 | 强制小写 kebab-case（`/supperh-*` 才可能） | `supperH-*` 原样 | `supperH-*` 原样 |
| 主体资产 | 命令/角色/协议都得变 skill（22 个一层目录） | 三种原样（11 agent / 6 command / 5 skill） | 同 Qoder（目录名映射成单数） |
| 红线 rules | 无处声明；只有 `AGENTS.md` 可粘/拷 | `plugin.json` 声明 `rules/`，每轮注入 | `instructions` 指回工具仓（单一真相，不拷贝） |
| 子 agent | provider 运行时，角色只能当 prompt | 文件注册的 subagent（带 `permission:`） | 同 Qoder |
| per-agent 权限 | **无位置可写**（会话策略 + 审批，粒度更粗） | 机制级强制 | 机制级强制 |
| MCP 注册 | profile 加 `dsh-mcp-client` 条目，需重启 profile | 插件自带 `.mcp.json`，零配置 | 写进 `<目标>/opencode.json` 的 `mcp` 块 |
| 生效 | 装 skill 无需重启（有 watcher）；改 profile 要重启 | 完全退出后重开 | 重开 opencode |
| 脚本门禁 / 私有根 / 学习数据 | **三家完全共用，不受适配与否影响** | 同 | 同 |
| 详见 | — | 同目录 `qoder适配说明.md` | 同目录 `opencode适配说明.md` |
