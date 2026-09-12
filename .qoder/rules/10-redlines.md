# 项目无关红线（Always Apply）

本文件加载路径：`.qoder/rules/10-redlines.md`  
**约束**：本文件不得包含任何双花括号占位符、任何具体项目专有名词、任何真实域名/账号/路径。若发现请提 PR 修正。

以下红线**在任何项目、任何 agent、任何工具（OpenCode / Qoder / 其它）下均生效**。违反其中任一条 → 输出无效，必须回滚重来。

## R1 数据与代码安全

- **禁止绕过 DB 门禁**：任何写操作前必须比对当前注册条目（`projects/<code>.yaml`）的 `forbidWriteSchemas` 清单。若目标 schema 命中 → 立即终止 + 报告，不允许"用户明确同意"作为例外。
- **清单不存在 / 为空 / 未被填充 = 本项目未接入数据库**，而不是"无限制"：写库操作一律禁止（无法证明安全就不能动手），DB 取证步骤记为缺口，告知可用 `/supperH-init` 补接。同理 `drivers.database` 缺席时不得另开通道去连库。
- **禁止跳过新鲜度体检就 git add**：跑本仓库的 `node scripts/sync-assets.mjs --check`（在仓库根目录执行；人工别名 `npm run sync:check`），残留占位符进入 dist 会导致运行时行为不可预测。
- **禁止把私有根目录**（同级 `supper-Han-private/`）**加入任何 git 仓库**，包括通过符号链接/junction 变相加入。
- **禁止把生产凭据/账号名/内网域名写入本仓库任何文件**：真实值只能出现在私有根的注册条目（`projects/<code>.yaml`）或 `drivers/` 里。MCP 形态同理：注册表（`.mcp.json` / IDE 的 mcp 块）只允许出现 server id、启动命令与 `env_vars` **名单**，凭据只进 server 进程环境，禁写字面量 —— 注册表本身是 agent 可读文件。
- **禁止拿“只是个例子”为由把项目专有值写进上传物**：文档示例、测试夹具、注释里的真实项目短码 / 包根 / 库名 / 本机绝对路径同样是泄露。这条不靠人记得去扫：`node scripts/sync-assets.mjs --check` 的纯度扫描（**退 5**，写模式构建 dist 前同样拦）会拿注册条目的专有值与本机三个路径（私有根 / 仓库父目录 / 家目录）比对全仓上传物。撞车时用显式旗标 `--allow-l1-fact <值>`，**不得改成警告也不得静默跳过**。

## R2 权限边界

- **禁止 prelearn-writer 之外的任何 agent 使用 `external_directory: allow`**。这是最小放开面原则。
- **禁止 agent 通过 `bash` 里的 `echo`、`tee`、`cat >`、`sed -i` 绕过工具层权限拦截**去做被 `edit: deny` 禁掉的写操作。
- **禁止主 agent 直接读源码定位问题**：代码定位由学习模块（prelearn）+ 学习记录（`CONTEXT_ROOT/<module>/`）提供。若学习记录不完整 → 派 prelearn-analyzer 定向补学，不允许越级。
- **`git` 命令只限白名单**（适用于所有 agent；主入口根本不碰 git，只调解析器）：只读类 `status` / `diff` / `log` / `blame` / `rev-parse` / `show`；快照类 `stash create`、`update-ref refs/supperh/snap/*`、`checkout <sha> -- <path>`（只跟具体改过的文件）；仅当运行期 `git.deliveryMode: local-commit` 时的 `add` + `commit`。**永不允许**：`push`、`reset`、`clean`、`checkout .`（及整树切换）、`stash push` / `stash drop`（及任何其它 `stash` 子命令）、`rebase`、`gc`、`commit --amend`、`--no-verify`，以及对 `refs/supperh/snap/` 之外任何 ref 的 `update-ref`。理由：`stash create` 是这里唯一**不动工作区、不写 `refs/stash`、不进分支历史**的快照形态；`stash push` 会静默改用户的工作区与 stash 栈，`reset`/`clean`/整树 `checkout` 会拿掉用户手改的内容 —— 那些都不需要 agent 的修复动作就能造成不可逆损失。

## R3 流程纪律

- **禁止在注册条目缺失或未通过校验时执行任何 bug 修复/测试/学习动作**。此时唯一正确响应是按退出码分流：本目录未注册（**10**）→ 引导 `/supperH-init`（它扫结构后才写条目）；连私有根都不存在（**12**）→ 引导 `/supperH-bootstrap`（它只建骨架）。**禁止**为了“先能跑起来”而拷 `schemas/project.example.yaml` 或手写一份条目 —— 模板假值结构合法、能过全部校验，是最难发现的脏数据（F-7/F-9 已为此消灭了两个拷贝入口）。
- **禁止把 L2 值塞进 L1 prompt**：任何形式的"这段文字只在 A 项目有意义"的常量都不允许写进 `agents/commands/skills/` 里；必须写成 `PROJECT.<dot.path>` 占位符。
- **禁止未替换的占位符进入运行时**：sync 阶段若检测到任何双花括号包裹的占位符残留 → 必须阻断，不许降级为 warning。

## R3.5 运行期项目解析门禁（多并发根因）

L1 产物**项目无关**：sync 只烤 `TOOL_ROOT / PRIVATE_ROOT / DRIVERS_ROOT / SYNC_TIMESTAMP` 四个工具级恒定值；任何项目级路径（`CONTEXT_ROOT / TASKS_ROOT / EFFECTIVE_ROOT / PACKAGE_ROOT_PATH / PROJECT.*`）在产物里一律保留为运行期 token，由主 agent 在步骤 0 用解析器输出填充。

- **禁止主 agent 用 LLM 判断"当前是哪个项目"**：项目身份只能来自确定性脚本 `scripts/resolve-project.mjs` 的**退出码 + stdout JSON**（0 命中 / 10 未注册 / 11 歧义 / 12 无私有根）。
- **禁止主 agent 用 LLM 判断"这个 bug 能不能走快路径"**：快路径准入（锚点类型与唯一性、学习数据就绪、完整度等级、新鲜度（G4a 仓库级 + G4b batch 级交集）、否决词表、影响半径 G5）只能来自同一个解析器的**退出码**（0 准入；30–37 属正常分流信号；**40 不属此列**，它是“问用户一次”的停机信号，故意放在 30–37 连续段之外）。理由：误判成本高度不对称 —— 漏杀的代价是线上回归且当场不可见，误杀的代价只是多花几十秒。**尤其禁止自行判断"这次提交跟这个 batch 无关"**：无关与否由脚本拿 `git diff` 与该 batch 的 `sources` 求交集得出，无从判定时一律按过期出局。
- **禁止用文字自行判定 I0（意图复述）**：“我听懂了”不得由主 agent 自陈，必须把三槽位 + 逐字引用片段交同一个解析器（`--intent-json` 或 `--intent-report`）由 `verifyIntent` 判（40 = 内容欠定义 → 一次性补问用户；36 = 结构不可用 → 修调用姿势而不是去问用户）。它只验“引用逐字出自原话 + 期望/实际两格真区分 + 症状句被引到”，**拦不住“原话里确实有这句、但说的不是这件事”** —— 那一半靠把复述回显给用户，两道缺一道都不算闭合。它是**两条路径共有**的义务：不进快路径时仍要拿空锚点（`--anchor ""`）跑一次把 I0 求值出来。
- **禁止拿 MCP 工具的结果做分流**：MCP 调用没有退出码，且 server 起不来时工具**从列表静默消失**（无错误码、无 stderr）——拿它判断等于把"错被吞"写进流程。`drivers.<slot>.kind` 由 `/supperH-init` 注册期探测机械写死（探测不过就回写成 `script`），会话内**只读已定的 kind、不重探**（重探 = 每会话多一个 30s 超时面）。`kind: mcp` 只换取数通道，门禁槽位（`vpnPreCheck`）在 schema 层就被拒。
- **禁止用文字自行判定 G5**：影响半径窄与否不得靠主 agent 读 `bug-analyzer` 回报的措辞得出结论，必须把回报原文回灌解析器（`--impact-json` 或 `--impact-report`）由 `verifyImpactReport` 的退出码定（0 窄→继续；37 宽或 lite 护栏被破→升格；36 回报不可用→升格）。脚本只验回报形状，G5 因此永久弱于 G1–G4。
- **禁止把退出码 0 与"没跑成门禁"混为一谈**：锚点门禁 `exit 0` 必须同时满足 `fastPath.eligible === true`、`fastPath.anchorResolved` 非空、`fastPath.intent.ok === true`；G5 回灌模式 `exit 0` 必须满足 `impact.narrow === true`。`--anchor`/`--text`/`--module`/`--intent-*`/`--impact-*`/`--scope` 不成对、或脚本内部异常，一律由脚本返回 **36（门禁未求值）** 落完整路径 —— “没校过”永远不等于“校过了且通过”。主 agent 不得因为"只是少个参数"而自行补参重试或当作通过。
- **禁止跳过步骤 0 门禁**：`/supperH-bug`、`/supperH-learn` 进入步骤 1 之前**必须**先成功运行解析器（退出 0）。非 0 一律立即停止并原样输出打回语。
- **窄 bash 白名单**：`/supperH-bug`、`/supperH-learn` 虽 `bash: allow`，其**唯一**允许的 bash 脚本就是那一条 `node "<TOOL_ROOT>/scripts/resolve-project.mjs" ...`，可按不同参数多次调用：步骤 0 不带参、新鲜度取数带 `--module`、I0 + 门禁判定带 `--anchor` + `--text` + `--intent-json`/`--intent-report`（反查来的锚点再加 `--anchor-source lookup`）、诊断基线带 `--env`、G5 验收再带 `--impact-json`/`--impact-report`（可叠 `--scope`）、改动动手前带 `--preflight`。**白名单只圈到“这一个脚本文件”**，不圈子命令：除上述已文档化的旗标外不得自造参数。其它任何编译/DB/网络命令（**包括跑 driver**）仍必须派子 agent——快路径 F1.4 的 traceId/ticketNo 反查因此走 `bug-analyzer(mode=lookup)` 而非主 agent 直接跑脚本；`--preflight` 也只集**本地事实**（脏文件/快照 ref/槽位名单），绝不在执行前做网络预检（§10.8）。
- **MCP 取数工具只绑子 agent**：壳 server `supperh-drivers` 只允许出现在子 agent frontmatter 的 `mcpServers` 里（现绑 `bug-analyzer` / `bug-tester` / `bug-test-writer` / `prelearn-analyzer`），**主 agent 与命令入口一律不绑**。这与上一条是同一条精神的两个面：取数动作必须发生在被约束的下游，主入口只消费结构化结果。
- **跨私有根的只读取数下沉到脚本**：子 agent 与主入口均不得为了读 `CONTEXT_ROOT/` 下的 `index.md` 而要求放开 `external_directory`；需要这份数据时走解析器返回的 `freshness` / `fastPath` 字段，或派 `prelearn-analyzer`。目的是把最小放开面钉在 1 个 subagent 上。
- **禁止不传 `--project <code>` 就调用 driver/子 agent**：拿到解析结果后，所有下游调用必须显式携带该 code 与解析返回的 `contextRoot`，杜绝多项目下串包。

## R4 学习数据完整性

- **禁止 prelearn-writer 在 copy-on-write 生成新代目录之前修改 CURRENT 指向**。原子切换顺序：写入新代 → 校验通过 → 原子 rename 更新 CURRENT。
- **禁止在同一 module 下并存两个未 GC 的 gen-* 目录超过 24 小时**。GC 策略见 `20-workflow.md`。
- **禁止手写 batch-*.md 内容绕开 analyzer**：所有学习记录必须由 prelearn-analyzer 生成结构化输出后交 writer 落地。
- **禁止把空 / 不合法的 `sources` 当成"该 batch 无源码依赖"**：`index.md` 反查表的 `sources` 列必须是该 batch 调用链可达文件**全集**（含 Controller 自身），repo-relative POSIX 路径、`;` 分隔；追不全、或路径含 `;`/`|` 等破坏表格的字面，一律写 `-`。G4b 对 `-` 与非法形态 **fail-closed** 判过期（35）——写成空集等于给门禁开后门，把误杀换成了漏杀。
- **禁止给 `index.md` 加列而不升 `schema` 代际**：反查表列集合是机器契约，`scripts/fastpath-gate.mjs` 的 `REQUIRED_COLS` / `INDEX_SCHEMA` 必须与 `prelearn` skill 的「index.md 规范格式」节同步；代际不符或缺列一律 32 出局，绝不"尽力解析"。

## R5 派发协议

- **禁止主 agent 派发 subagent 时不回显目标项目 code**：每次派 sub 之前必须在响应首行输出 `target project: <project-code>`（值取自步骤 0 解析器输出，不允许硬编码、不允许凭记忆猜）。
- **禁止把已拒绝的 subagent 结果二次派发以图"换个 agent 试试"**：subagent 明确返回 fail 时，主 agent 必须走失败降级路径，不允许换 agent 重试。
- **禁止快路径升格失败后继续轻装前行**：触发升格（fast → full）后必须从步骤 3 起重跑完整路径，且不得拿快路径已得结论去佐证后续判断。升格只能单向发生，不存在 full → fast。

## R6 输出规范

- **禁止在最终响应里泄露内网拓扑**：即使 agent 内部处理时接触到域名/IP，最终给用户看的总结里必须脱敏为 `<internal-host>` 等占位形式。
- **禁止把注册条目（`projects/<code>.yaml`）内容原样 dump 到对话里**：只允许按需引用具体字段。
