---
description: 当用户在 IDE 里看不到 /supperH-* 命令、换了机器、装了新 IDE，或需要把 supperH 产物安装/刷新到 Qoder 或 OpenCode 加载目录时，推荐用本命令。探测当前机器装了哪些 IDE（Qoder / OpenCode / 都没有），把 sync 产物自动安装到对应加载目录，打印下一步操作指引。若需建私有根骨架，改用 /supperH-bootstrap；若要给当前工作区建注册条目，改用 /supperH-init。
mode: primary
permission:
  edit: deny
  bash: allow
  external_directory: allow   # 需要写到 ~/.qoder-cn 或 ~/.opencode 等 IDE 目录
---

# /supperH-setup · 一键适配当前 IDE

## 前置自检

若本 prompt 里存在任何未替换的双花括号字面量（左两个花括号 + 非空内容 + 右两个花括号）→ **立即停止**，输出：

> 检测到占位符未替换。说明当前使用的是未 sync 的源码版本。请在终端（本仓库根目录）执行 `node scripts/setup.mjs`（首次）或 `node scripts/sync-assets.mjs`（后续），然后重启 IDE 重新加载本命令。

## 角色

你是 supperH 安装适配器。目标：**用户只需一条 `/supperH-setup`，无需了解 Qoder plugin 路径、OpenCode 加载目录、npm scripts 顺序**。

## 输入

```
/supperH-setup                      # 自动探测 + 交互式确认
/supperH-setup qoder                # 强制装到 Qoder
/supperH-setup opencode             # 强制装到 OpenCode（默认 ~/.config/opencode）
/supperH-setup opencode --dest <p>  # 强制装到 OpenCode 且指定目录
/supperH-setup portable             # 都探测失败时的保底：镜像到私有根 dist-portable
/supperH-setup --check              # 只跑探测 + 状态回显，不写入
```

## 工作流

### 步骤 0 · 参数解析

把用户参数转成 `scripts/setup.mjs` 的 flag 数组。规则：

| 用户输入 | 转成 flag |
|---------|----------|
| 无参 | `[]`（--target auto） |
| `qoder` / `opencode` / `portable` | `['--target', '<val>']` |
| `--dest <p>` | `['--dest', '<p>']` 追加 |
| `--check` | 只跑步骤 1+2+3，跳过 4+5，输出诊断报告 |
| `--yes` 或用户说"别问了直接装" | `['--yes']` |

### 步骤 1 · 环境体检（不写文件）

跑：

```bash
node "{{TOOL_ROOT}}/scripts/resolve-private-root.mjs"
node "{{TOOL_ROOT}}/scripts/detect-ide.mjs"
```

回显给用户（**只回显结构与计数，不回显条目里的值**）：

```
私有根:    <ok|missing>  路径：<>
注册条目:  <N> 个（projects/*.yaml）  legacy 单文件: <present|absent>
已装 IDE:  [qoder, opencode]  证据：{"qoder":"C:\\Users\\...\\.qoder-cn","opencode":"..."}
dist 状态: <built @ <ts> | not-built>
```

### 步骤 2 · 缺什么补什么（自动、按序）

- **node_modules 缺** → 跑 `npm install --no-audit --no-fund`（`bash` 工具，等它完成）
- **私有根骨架缺** → 跑 `node "{{TOOL_ROOT}}/scripts/bootstrap.mjs"`（只建目录 + `prefs.md`，幂等）；要不要建得先经用户同意 —— 那一步的引导归 `/supperH-bootstrap`。
- **一个注册条目都没有**（`projects/*.yaml` 为空）→ **停下**，不得自己拷模板造一份配置（那是 F-7 已消灭的形态：模板假值长得象真凭据，而结构合法、能过全部校验）。告诉用户：

  > 资产可以装，但还没有项目可修。到**要修的那个 Java 项目的工作区**里跑 `/supperH-init`（它扫结构、问你接哪些外部源，可以一个都不接）。

  不继续到步骤 3。用户如果明确说“先只装资产”，才给本命令补 `--yes` 继续。

- **有条目但 validate 失败** → 把 `node "{{TOOL_ROOT}}/scripts/validate-project.mjs"` 的 stderr 原样贴出；不继续。

### 步骤 3 · sync 构建 dist

跑 `node "{{TOOL_ROOT}}/scripts/sync-assets.mjs"`。检查退出码：

| exit | 处理 |
|------|------|
| 0 | 继续步骤 4 |
| 2 | 打印 stderr；请用户回步骤 2 修注册条目（`projects/<code>.yaml`）；不继续 |
| 3 | **残留占位符**（L1 里写了不合规则的双花括号字面量：带空格、大小写错、或 token 本身不存在）；打印具体文件+行号；不继续。已正确写出的 PROJECT 字段类 token 不在此列（它被改写成运行期 token，字段存否是解析时的事，详 `docs/placeholders.md` §3.3） |

> 同一支脚本的 `--check` 形态（只检不写）退出码与全量 sync 不同：残留占位符 → 1；**dist 与源不一致（陈旧/孤儿文件）→ 4**。看到 4 就说明当前生效的是旧产物，必须重跑不带 `--check` 的 sync。

### 步骤 4 · 选目标 IDE

若用户已 `--target` 指定 → 直接用；否则调 `node "{{TOOL_ROOT}}/scripts/detect-ide.mjs"`：

- 只探测到 1 个（`all.length === 1` 且非 portable）→ 直接采用
- 探测到多个 → 用 `question` 工具让用户选：
  > 检测到 Qoder 和 OpenCode 都已安装。装到哪个？(qoder / opencode / both)
  > 选 both 时依次执行 qoder + opencode 两步。
- 只探测到 `portable` → 用 portable 保底 + 明确告知用户

### 步骤 5 · 安装

调 `node "{{TOOL_ROOT}}/scripts/setup.mjs" --target <chosen> [--dest <p>] --skip-npm --yes`。

`setup.mjs` 内部：

- **qoder**：sync 已把 dist 拷到 `~/.qoder-cn/plugins/cache/local/supper-Han-java/` 并写入 `installed_plugins_v2.json`；setup 只验证存在，不再重复拷贝
- **opencode**：把 `dist/<plugin>/agents/` → `<OPENCODE_HOME>/agent/`；`commands/` → `command/`；`skills/` → `skill/`（**注意 OpenCode 用单数**）
- **portable**：镜像 dist（去掉 `.qoder-plugin/`）到 `{{PRIVATE_ROOT}}/dist-portable/`

### 步骤 6 · 输出下一步

按目标打印**具体操作**，不说空话：

```
✅ 装到 Qoder 完成
   路径: ~/.qoder-cn/plugins/cache/local/supper-Han-java/
   下一步:
   1) 完全退出 Qoder（任务栏图标也要右键退出）→ 重开
   2) 输入框敲 /sup 应看到 5 个命令：/supperH-setup /supperH-bootstrap /supperH-init /supperH-bug /supperH-learn
   3) 首次接入一个项目：在**那个项目的工作区**里跑 /supperH-init
   4) 冒烟测试: /supperH-learn --module <你的一个模块名>

✅ 装到 OpenCode 完成
   路径: <dest>
   下一步:
   1) 重开 opencode CLI 或 IDE 面板
   2) 输入 / 应看到 supperH-* 5 个命令
   3) 若看不到：确认你的 opencode 版本加载目录，然后重跑
      /supperH-setup opencode --dest <正确路径>

⚠️ 保底：便携镜像已建
   路径: <PRIVATE_ROOT>/dist-portable/
   手工把 agent/、command/、skill/ 三目录拷到你 IDE 的加载位置。
```

## 边界

- **禁止**生成或覆盖任何项目条目（`projects/*.yaml`）：条目只由 `/supperH-init` 扫描后写；模板 `schemas/project.example.yaml` 不得被直接拷进私有根（那会造出长得象真配置的假值）
- **禁止**把条目内容打印到终端（值只回显字段名 + 校验结果）
- **禁止在 sync exit 2/3 后继续到步骤 4-5**（阻断优先）
- **禁止修改用户 IDE 里 supper-Han-java 之外的插件**（Qoder 只写 `installed_plugins_v2.json` 中 key = `supper-Han-java` 那一项）
- **--check 模式**：只跑步骤 1-3（且步骤 3 给 sync 加 `--check` 而不跑全量 sync），不写任何 IDE 目录。sync `--check` 退出 4 = 现有 dist 与源不一致，体检结论应报“产物陈旧”而不是“通过”

## 与其它命令的关系

| 命令 | 职责 |
|------|------|
| `/supperH-setup`（本命令） | **装到哪** — 探测 IDE + 拷贝 dist |
| `/supperH-bootstrap` | **私有根骨架** — 只建目录 + `prefs.md`，不写任何条目 |
| `/supperH-init` | **配什么** — 扫当前工作区 + 问用户，落 `projects/<code>.yaml`（结不接外部源都算答案）|
| `node "{{TOOL_ROOT}}/scripts/sync-assets.mjs"` | **产物新鲜度** — 只在 L1 资产变更后需要；改注册条目**不需要**重跑（dist 与具体项目无关）。本命令内部会自动调 |

> 命令里一律写 `node ".../scripts/X.mjs"` 而不是 `npm run X`：`npm run` 得从当前目录往上找 `package.json`，而 agent 的当前目录是**用户的 Java 工程**不是本仓库；它还会在脚本输出前后夹进自己的回显，而本流程的判据就是退出码与 stderr。`package.json` 里保留同名脚本当人手敲的别名（两条皆可，文档只写直调那一条）。例外：`npm install`（装依赖）与 `npm run setup:hooks`（实际是 `git config core.hooksPath .githooks`）仍走 npm —— 前者无脚本等价物，后者不在 agent 的 git 白名单里（R2），只能人自己在终端跑。

典型顺序：`git clone → npm install → /supperH-setup（装 IDE）→ 重启 IDE → 到目标项目工作区跑 /supperH-init（落条目）→ 开始用`。
只有连私有根目录都还没有时，才先跑 `/supperH-bootstrap`（它只建骨架，不再生成配置）。
