# DSH 适配说明 · 在 DeepSeek Harness 里用 /supperH

> 本文件**只解决一件事**：当你在 DeepSeek Harness（DSH）会话里要用 /supperH 流程时，怎么把它装进 DSH 的 skill 目录、怎么刷新、入口长什么样。
>
> 这与配置向导（建私有根骨架、按工作区注册项目、连通检测）**是两件事**，互不依赖；那部分是跨 IDE 共享的，见同目录 README 与 docs/architecture.md。

---

## 为什么 DSH 里看不到 /supperH-*

DSH 的斜杠入口只有 skill 的 /name 手势，且命名强制全小写 kebab-case：

- skill 只从 `$DSH_HOME/skills`（未设时 `~/.dsh/skills`）发现一层：`<name>/SKILL.md`；
- skill 名与手势名必须匹配 `^[a-z0-9]+(?:-[a-z0-9]+)*$`，所以本机入口是 `/supperh-*` 小写形态（`/supperH-*` 在 DSH 里解析不到）。

所以「装到 DSH」= 把 sync 后的 dist + 红线四件套生成成 23 个 `supperh-*` skill，再往 `$DSH_HOME/AGENTS.md` 合并一块托管区块。

---

## 装法（一行命令）

在工具仓库根目录执行一次：

```powershell
npm install
node scripts/setup.mjs --target dsh --yes
```

一次 setup 顺手做四件事：

1. **生成 skill**：dist 的 `commands/ agents/ skills/` + `.qoder/rules/` 四件套 → 23 个 `supperh-*` skill 落到 `$DSH_HOME/skills`（6 命令 + 11 角色 + 5 协议 + 1 红线）。
2. **合并 AGENTS.md**：在 `$DSH_HOME/AGENTS.md` 写入带 `BEGIN/END` 标记的托管区块（重跑即整块替换，不手改块内内容）。
3. **清陈旧**：按安装清单 `supperh-installed.json` 删掉上一次自己放的文件；你手放进 `skills/` 的自有文件不在清单里，绝不会被删。
4. **写清单**：供下次清理使用。

改过工具仓库源码（`commands/ agents/ skills/ .qoder/rules/`）后，重跑上面那条 `node scripts/setup.mjs --target dsh` 一次即刷新拷贝件。

---

## 生效与刷新

- skill **无需重启**：DSH 有目录 watcher，下一个步骤就能看到新 skill 与手势。
- 只有改 DSH profile（如 MCP 装配的 `cordis.patch.yml`）才需重启该 profile。

---

## 入口形态

| 本机手势 | 对应源资产 | 用途 |
|---|---|---|
| `/supperh-setup` | `commands/supperH-setup.md` | 探测 IDE + 安装/刷新到各 IDE 加载目录 |
| `/supperh-bootstrap` | `commands/supperH-bootstrap.md` | 冷启动：建私有根骨架，不写注册条目 |
| `/supperh-init` | `commands/supperH-init.md` | 当前工作区注册项目 |
| `/supperh-driver` | `commands/supperH-driver.md` | 内网数据源驱动编写入口 |
| `/supperh-bug` | `commands/supperH-bug.md` | Bug 全流程主入口 |
| `/supperh-learn` | `commands/supperH-learn.md` | 代码/页面/流程学习入口 |

---

## 机制差异（够用即可）

- **命令**：源里 `mode: primary` 的 command 生成成 `user-invocable + disable-model-invocation` 的 skill —— 手势后面的自由文本就是命令入参（`--module` / `--flow` 这类旗标也在其中）。
- **子 agent**：源里 `mode: subagent` 的 agent 生成成 `user-invocable: false` 的角色 skill —— 派发 = 先 `skill` 加载角色正文，再把它作为 `subagent` 工具的 prompt。
- **协议 skill**（data-fetch / driver-contract / prelearn / auto-fix / incident-triage）：`user-invocable: false`，只供模型按需加载。
- **红线**：DSH 没有 rules 目录、不能像 Qoder 那样每轮注入 —— 做成长 `supperh-rules` skill 按需加载，外加 AGENTS.md 里的短区块留入口。

---

## 权限与工具映射

- DSH 没有 per-agent 的 `permission:`；源文件里的 `edit: deny` / `external_directory: deny` 是流程纪律，真实边界是本会话的文件策略与审批策略。
- 工具映射：`question` → `ask_user_question`；`task` / agent 派发 → `subagent`（默认后台；必须拿到结果时 `run_in_background: false`）；`bash` → `pwsh`；`read`/`edit`/`glob`/`grep` 同名。
- MCP：源里 `kind: mcp` 的槽位需要 DSH profile 的 `cordis.patch.yml`（dsh-mcp-client）装配，改 profile 后重启；`kind: script` 槽位不需要任何装配。

---

## 自检

装完跑：

```powershell
node scripts/detect-ide.mjs
```

输出里 `mcp.dsh` 应 `registered: true`（count 23）。私有根与注册表是所有 IDE 共用同一份，别为 DSH 另建。

---

## 与共享文档的分工

本文件只维护 DSH 的装法与生效；三层分离、命名空间（`supperH-` 前缀）、拷贝件纪律、并发与同步边界等共享知识，都在 README 与 docs/architecture.md 里维护一处，各 IDE 文档不重复搬运。
