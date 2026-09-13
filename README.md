# supper-Han-java

**通用 Java 项目多 Agent 工作流工具仓库（L1 层）**

> **全量代码在 [`dev`](https://github.com/zhanghan1999/SupperHan/tree/dev) 分支** —— 本分支（`master`）只有说明文件，
> 树上没有 `scripts/` `agents/` `commands/` `skills/` `schemas/` 等实现目录；文中出现的路径与退出码一律到 `dev` 核对。
> 变更记录见 [CHANGELOG.md](./CHANGELOG.md)：一节 = 一个 tag，首个版本 `v0.1.0`。

一份**与具体项目无关**的 Agent / Command / Skill 定义集合，可在多个 Java 项目上直接复用。真实项目事实（内网域名、库名、路径、分支名等）全部落在同级**私有根** `../supper-Han-private/`，不进入本仓库。

---

## 快速开始（首次 clone）

```bash
# 1. 克隆本仓库到任意位置
git clone https://github.com/zhanghan1999/SupperHan.git
cd SupperHan

# 2. 装依赖（脚本自身要 import yaml 包，这一步没有 node 直调等价物）
npm install

# 3. 一条命令完成：建私有根骨架 → 探测 IDE（Qoder / OpenCode）→ sync → 安装
node scripts/setup.mjs
#    注册项目是另一件事：到**目标 Java 项目的工作区**跑 /supperH-init（它扫结构 + 问你接哪些外部源）

# 4. 重启 IDE → 输入下面 5 个命令之一：
#    /supperH-setup      重新适配 IDE（换机器 / 装了新 IDE 时）
#    /supperH-bootstrap  补建私有根骨架（只建目录，不写条目）
#    /supperH-init       把当前工作区注册进来
#    /supperH-learn      学一个模块
#    /supperH-bug        修 bug
```

**一行安装目标**（非交互）：

```bash
node scripts/setup.mjs --target qoder    --yes
node scripts/setup.mjs --target opencode --dest ~/.config/opencode --yes
node scripts/setup.mjs --check           # 只体检不写入
```

---

## 三层分离

| 层 | 内容 | 存放位置 | git |
|----|------|---------|-----|
| **L1 通用行为层** | 角色职责、派发协议、分批算法、原子切换、降级策略、完成判定 | 本仓库 `agents/` `commands/` `skills/` `.qoder/rules/` | ✅ 上传 |
| **L2 项目契约层** | codeRoot、DB schema、驱动路径、分支、模块清单、包名 | `../supper-Han-private/projects/<code>.yaml`（+ `menus/<code>.yaml`）| ❌ 私有 |
| **L3 个人习惯层** | 日志详略、常用笔记、确认强度 | `../supper-Han-private/prefs.md` | ❌ 私有 |

**驱动契约层**（L1/L2 中间）：
- 本仓库上传 `schemas/driver-response.schema.json` + `drivers-skeleton/base_driver.py` + 可跑的 `example_json_driver.py`
- MCP 通道上传 `mcp-skeleton/`：一个壳 server（`supperh-drivers`，插件相对注册、零凭据）+ 共享契约包 `supperh_contract/`（envelope / exit code / SELECT-only 守卫 / 私有根定位）
- 真实内网驱动实现（DB / 日志 / 工单 / 效能）放 `../supper-Han-private/drivers/`，每人自开发；`kind: mcp` 的额外写一份 `drivers/<code>/adapter.py`（import 契约包，不复制守卫）
- 取数通道只有两条：`script`（bash + 退出码）/ `mcp`（工具化）。MCP 只换取数通道，**不作任何分流依据**，且取数工具只绑 4 个只读/测试类子 agent（主 agent 与命令入口不绑）—— 见 `skills/driver-contract/SKILL.md` §调用通道
- **没有“执行前预检”（VPN/网络通不通）这种模块**：连通性唯一合法判据是各槽位 `healthCheck` 的**协议级握手**退出码（ping / 网卡名 / 裸 TCP connect 均已被实测证伪）；连不上就停下，把端点 + 错误原文交给用户要求可连接环境 —— 见 `docs/architecture.md` §10.8

---

## 分支布局

| 分支 | 内容 | 用途 |
|------|------|------|
| `master` | **只有说明文件**：本 `README.md` + `CHANGELOG.md` + `docs/` + 两份 IDE 适配说明 | 落地页；clone 下来先读懂再决定拉哪条 |
| `dev` | 全量 L1 资产（`agents/` `commands/` `skills/` `scripts/` `schemas/` `mcp-skeleton/` `drivers-skeleton/` `tests/` `.qoder/`） | **实际使用就 checkout 这条**；`npm install` + `node scripts/setup.mjs` 的完整链路只在它身上成立 |

```bash
git clone -b dev https://github.com/zhanghan1999/SupperHan.git
```

两条分支的历史**互不相干**（各自孤儿提交）：说明文件与代码分头演进，也让 `master` 的 diff 保持"只有文档"这一可读承诺。

---

## 命令一览

| 命令 | 承载文件 | 用途 |
|------|---------|------|
| `/supperH-setup` | `commands/supperH-setup.md` | **一键适配**：探测 Qoder / OpenCode → 拷 dist 到对应加载目录 → 打印下一步 |
| `/supperH-bootstrap` | `commands/supperH-bootstrap.md` | 新用户引导：**只**初始化私有根骨架（五个子目录 + `prefs.md`，幂等）+ 处置 legacy 单文件。不写任何注册条目、不跑 sync——条目由 `/supperH-init` 扫描后产生 |
| `/supperH-init` | `commands/supperH-init.md` | 工作区级注册：扫描仓库预填结构字段 → 外部源**由用户多选**（全不选 = 纯代码模式，`db`/`drivers` 两段整段不写）→ 落 `projects/<code>.yaml` + `menus/<code>.yaml`；连通门禁 + driver 通道（`kind`）探测在此机械写定 |
| `/supperH-bug` | `commands/supperH-bug.md` | Bug 全流程主入口：解析→DB 门禁→学习模块检查→派 subagent 修复→验证→终判 |
| `/supperH-learn` | `commands/supperH-learn.md` | 学习入口：代码学习 / 菜单学习 / 流程学习 |

**二期再补**：`/supperH-flow`、`/supperH-package`、`/supperH-test`

---

## 脚本入口

文档与命令里一律写直调形式 `node scripts/X.mjs <旗标>`，不写 `npm run X`：`npm run` 得从当前目录往上找 `package.json`（agent 的当前目录是用户的 Java 工程），还会在脚本输出前后夹进自己的回显 —— 而这套流程的判据就是退出码与 stderr。`package.json` 里的同名脚本只是给人手敲的别名，两条皆可。

| 命令 | 作用 | npm 别名 |
|------|------|---------|
| `node scripts/setup.mjs` | **一键总入口**：建私有根 → sync → 探测 IDE → 安装到 Qoder 或 OpenCode（`--skip-npm` 不重跑装依赖） | `npm run setup` |
| `node scripts/setup.mjs --check` | 只体检不写入 | `npm run setup:check` |
| `node scripts/sync-assets.mjs` | **仅跑同步**：定位私有根 → 复制+替换 → 残留检测（阻断）→ L1 纯度扫描（阻断）→ 打包 dist → 装到 Qoder（配置校验不在 sync 里，由 `validate-project.mjs` 负责） | `npm run sync` |
| `node scripts/sync-assets.mjs --check` | 只跑同步的前半段（不写入）；有残留占位符 → exit 1；**dist 与源不一致（陈旧/孤儿文件）→ exit 4**；**上传物里出现注册条目的专有值或本机绝对路径 → exit 5**（可 `--allow-l1-fact <值>` 显式放行） | `npm run sync:check` |
| `node scripts/validate-project.mjs` | 校验注册表里**全部** `projects/<code>.yaml` 结构与 schemaVersion（含 identity.code 缺失、code 重复等静默失效项）；可加 `--project <code>` / `--file <path>` / `--json` | `npm run validate` |
| `node scripts/resolve-project.mjs --cwd <路径>` | **运行期唯一门禁**：项目身份解析 + 快路径准入 + I0 意图复述 + G5 回灌 + `--preflight` 本地事实（退出码即分流，见 `docs/architecture.md` §10） | —（agent 直调，不带别名） |
| `node scripts/bootstrap.mjs` | CLI 版引导（等价于 `/supperH-bootstrap`，不依赖 IDE）：只建骨架；`--check` 报就绪状态，`--migrate` 才处置 legacy 单文件 | `npm run bootstrap` |
| `node scripts/init-project.mjs` | 工作区级注册：预填结构字段落 `projects/<code>.yaml`（`/supperH-init` 的引擎）。接不接外部源由 `connect` / `db.*` 决定：接了整段生成、没接整段不写 | `npm run init-project` |
| `node scripts/migrate-registry.mjs` | legacy 单文件 `project.yaml` → 注册表模型迁移 | `npm run migrate-registry` |
| `node scripts/detect-ide.mjs` | 探测本机 IDE（输出 JSON） | `npm run detect-ide` |
| `node --test "tests/**/*.test.mjs"` | 全量用例（必须用这个 glob 形态：`node --test tests/` 会把目录本身当成一个测试文件跑，结果永远是一条失败） | `npm test` |
| 无脚本（人在终端跑） | 启用 `.githooks/pre-commit`：动作是 `git config core.hooksPath .githooks`。`config` 不在 agent 的 git 白名单里（R2），所以它只能人自己做 | `npm run setup:hooks` |

---

## 目录结构

```
supper-Han-java/
├── agents/                10 个 subagent（唯一放开 external_directory: prelearn-writer）
├── commands/              5 个 primary command（setup/bootstrap/init/bug/learn）
├── skills/                5 个 skill（prelearn/data-fetch/auto-fix/driver-contract/incident-triage）
├── schemas/               L2 project.schema.yaml + 示例 + driver-response.schema.json
├── drivers-skeleton/      驱动契约骨架 + 可跑的 JSON 示例（script 通道）
├── mcp-skeleton/          MCP 壳 server + 共享契约包 supperh_contract（mcp 通道；零凭据）
├── scripts/               resolve-project / fastpath-gate / git-preflight / sync-assets /
│                          validate-project / resolve-private-root / setup / detect-ide /
│                          bootstrap / init-project / migrate-registry
├── .qoder/rules/          项目无关红线（零占位符，clone 即生效）
├── .githooks/             降级式 pre-commit
├── docs/                  架构文档 + 占位符清单
├── dist/                  构建产物（.gitignore）
└── package.json
```

同级私有根（本仓库不创建、不追踪；骨架由 `/supperH-bootstrap` 引导创建，条目由 `/supperH-init` 写入）：
```
../supper-Han-private/
├── projects/<code>.yaml   按项目短码注册的 L2 契约（/supperH-init 写入）
├── menus/<code>.yaml      菜单学习来源配置
├── prefs.md               L3 个人习惯（骨架自带，存在则永不覆盖）
├── drivers/               用户自开发的内网驱动（含 <code>/adapter.py）
├── tasks/                 任务态数据
├── logs/                  运行期记账（fastpath-*.jsonl、壳 server 诊断；首次写入时自建）
├── project.yaml           legacy 单文件条目（注册表模型之前的形态；仍可读，bootstrap 会提示迁移）
└── context/<project>/<module>/gen-*/    学习数据（CURRENT 原子切换）
```

---

## 占位符规范

所有 L1 文件里**任何项目专有事实**必须写成 `{{PROJECT.<path>}}` 或 `{{TOOL_ROOT}}` / `{{PRIVATE_ROOT}}` / `{{DRIVERS_ROOT}}` / `{{CONTEXT_ROOT}}` / `{{SYNC_TIMESTAMP}}`。sync 阶段替换，**任何残留 `{{...}}` 会阻断 sync 报错（不降级）**。

写进 L1 的除了占位符，还有一种更阴的形态：把真实项目短码 / 包名 / 库名 / 本机路径当“例子”敲进文档或测试夹具。它不影响运行，所以没有任何现有检查会报——`sync --check` 的**纯度扫描（exit 5）**就是为此而存在：拿注册条目里的专有值与本机三个路径去比对全仓上传物，命中即拦（判据、过滤规则与例外通道见 `docs/placeholders.md` §9）。

详见 `docs/placeholders.md`。

---

## 冲突点提示

- `external_directory: deny` 是**除 prelearn-writer 外**所有 agent 的硬约束。writer 一个放开是因为学习数据要落到仓库外的 `{{PRIVATE_ROOT}}/context/`。
- `.qoder/rules/` **不走变量替换**——Qoder 直接把原文注入 prompt。红线里禁止出现任何 `{{...}}` 与真实项目专有词。
- Qoder plugin 组件路径禁 `..` 与绝对路径 → sync 阶段把 `{{PRIVATE_ROOT}}` 等替换成绝对路径后写入 `dist/`。
- MCP 侧是个例外：注册表 `dist/.mcp.json` **只能**是插件相对路径 + `env_vars` 名单，绝对私有根走 `mcp-skeleton/private-root.txt` 指针文件带外传递（sync 的 `--check` 形态断言：出现盘符、写了 env 值、指针缺失 → exit 4）。

---

## 许可

**本仓库不授予任何许可，全部权利保留（All rights reserved）。** 本节是权利声明而不是许可文本：它不放松任何限制，只把边界写明。

- **禁止商用。** 将本仓库的内容（含其任何部分、复制品与衍生实现）用于以营利为目的的产品、服务、对外交付或内部生产环境，以及据此向第三方收费，均不允许 —— 除非**事先取得权利人的书面授权**。
- **公开 ≠ 可用。** 内容能被查看与 fork 是 GitHub 服务条款层面的机制，不构成我对使用、修改、分发或再发布的授权。
- **分发时必须原样保留本节与署名**，不得移除、改写或替换。
- **无任何担保，概不负责。** 内容按“原样”（AS IS）提供，不含任何明示或默示的担保（包括适销性、特定用途适用性、无侵权）。因使用或无法使用本仓库产生的任何损害 —— 直接、间接、偶然、特殊、后果性损害，包括数据丢失、业务中断、商誉损失、替代商品或服务的采购费用 —— 均由使用者自行承担，即使已被告知发生此类损害的可能性。
- **历史声明不生效。** 本仓库历史提交中若出现过任何开源许可声明（包括 `MIT` 字样），均系误挂，不构成任何授权。
- 本仓库不属于 OSI 定义的开源软件。

Copyright © 2026 supperH
