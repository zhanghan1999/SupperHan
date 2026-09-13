# OpenCode 适配说明 · 在自己的项目里用 /supperH

> **本分支说明**：`master` 只放说明文件，本分支树上**没有** `scripts/` `agents/` `commands/` `skills/` `schemas/` 等实现目录 —— 文中出现的路径、退出码与判据请到 [`dev`](https://github.com/zhanghan1999/SupperHan/tree/dev) 分支核对。变更记录见 [CHANGELOG.md](./CHANGELOG.md)。

> 本文件**只解决一件事**：当你用 OpenCode 打开**自己的 Java 项目**（不是 supper-Han-java 工具仓库本身）时，怎么让那 5 个 `/supperH` 命令能被识别、能在当前项目上下文里用 `/` 调出来。
>
> 这与配置向导（建私有根骨架、按工作区注册项目、连通检测）**是两件事**，互不依赖。本文件只讲**命令在 OpenCode 里的加载路径与作用域**。Qoder 侧对应文档见同目录 `qoder适配说明.md`。

---

## 为什么会"项目里不识别"

OpenCode 的命令定义只从**固定目录**加载，且分两个作用域：

| 作用域 | 加载目录 | 覆盖范围 |
|--------|---------|---------|
| 全局 | `~/.config/opencode/{agent,command,skill}/` | 任意项目打开都识别 |
| 项目级 | `<你的项目根>/.opencode/{agent,command,skill}/` | 仅该项目识别 |

**痛点根因**：supper-Han-java 的命令源在工具仓库里；你在**另一个 Java 项目**打开 OpenCode 时，那个项目目录下既没有全局配置、也没有 `.opencode/`，所以 `/` 菜单里**看不到** `/supperH-*`。要让它看到，就得把命令定义**放进上面某个目录**。

> 注意目录名：工具仓库源码是复数 `agents/commands/skills`，安装时映射成**单数** `agent/command/skill`。
> 实测 1.18.21 的可执行文件里同时存在 `agent/` 与 `agents/`、`command/` 与 `commands/`、`skill/<name>/SKILL.md` 与 `skills/<name>/SKILL.md` 两组路径常量 —— **单复数都吃**，所以映射成单数是安全的（这条结论来自二进制字符串扫描，不是官网描述；升级版本后若命令不出现，先按下面§排障核对目录）。

---

## 方案 A（推荐）：装到全局，一劳永逸跨项目用

在 `supper-Han-java` 工具仓库根目录执行一次：

```powershell
cd c:\...\supper-Han-java      # 你的工具仓库路径
npm install
# 产出 dist 并拷到 OpenCode 全局目录（agent/command/skill 单数）
node scripts/setup.mjs --target opencode --dest "$env:USERPROFILE\.config\opencode" --yes
```

看到 `opencode: agents → ...\agent` 三行即装好。之后**打开任意 Java 项目**用 OpenCode，输 `/` 都应出现 `/supperH-*`。

一次 setup 顺手做四件事：

1. **拷资产**：`dist/{agents,commands,skills,mcp-skeleton}` → 目标目录（单数名）。
2. **清陈旧**：按目标目录里的安装清单 `supperh-installed.json` 删掉**上一次 supperH 自己放的**文件 —— 改过名或已删掉的命令不会以副本继续被加载；你手放在 `agent/command/skill` 里的自有文件不在清单里，绝不会被删。
3. **合并写 `opencode.json`**（只 merge，不覆盖你其它配置）：一条 `mcp.supperh-drivers`，以及 `instructions` 指向工具仓的红线四件套（见下面§红线 rules 怎么生效）。
4. **写安装清单**，供下次清理使用。

改过工具仓库源码后，重跑上面 `node scripts/setup.mjs ...` 一次刷新（它内部会先 `sync` 再拷贝）。

---

## 方案 B：只给某个项目用（项目级 `.opencode/`）

不想动全局、或该项目要用独立版本时：

```powershell
# 在“你的 Java 项目根”执行；把工具仓库产物拷进本项目的 .opencode/
node "<工具仓库路径>\scripts\setup.mjs" --target opencode --dest "<当前项目路径>\.opencode" --yes
```

或直接手工拷贝 `dist\supper-Han-java-plugin\` 下的 `agents→agent`、`commands→command`、`skills→skill` 三目录到 `<项目根>\.opencode\`（需要 MCP 通道时还有 `mcp-skeleton`）。

> 缺点：换项目要重来一次；好处：与全局互不干扰，可版本隔离。

---

## 生效步骤（在你的 Java 项目里）

1. 完成方案 A 或 B 的拷贝。
2. **重开 OpenCode**（CLI 就退出重进；面板就刷新）。
3. 在**你项目**的输入框输 `/`。

**预期**出现：

| 命令 | 用途 |
|------|------|
| `/supperH-setup` | 一键适配：探测 IDE + 把产物装到加载目录 |
| `/supperH-bootstrap` | 冷启动：建私有根**骨架**（五个子目录 + `prefs.md`）+ 处置 legacy 单文件。不写任何注册条目——按工作区注册项目用 `/supperH-init` |
| `/supperH-init` | 当前工作区注册：落 `projects/<code>.yaml` + `menus/<code>.yaml`（exit 10 打回时跑它）|
| `/supperH-bug` | Bug 全流程主入口 |
| `/supperH-learn` | 代码/菜单/流程学习入口 |

---

## 关于"上下文文件让项目识别"的可行性实验（对应你的想法）

你提的思路是：**先写一个上下文文件，让 OpenCode 在项目目录里也能识别 supper 命令，先验证可行性，再决定要不要自动化**。这条路径已在本方案里覆盖，具体是：

- 方案 B 的 `<项目根>\.opencode\{agent,command,skill}` 本质就是"放进项目里的上下文"——OpenCode 官方按目录发现命令，没有"仅靠一份 md 声明就能远程指向另一个仓库"的稳定约定。
- 因此**推荐验证动作**：挑你的一个 Java 项目，跑一次方案 B，重开 OpenCode 输 `/`：
  - 出现 `/supperH-*` → 项目级识别可行，后续可把这条命令固化进 init 向导。
  - 没出现 → 说明你的 OpenCode 版本加载目录与假设不符，用 `--dest` 指到它**真实**的配置目录再试；把 `opencode` 的版本号与它文档里"custom commands 目录"的原话贴出来，我据此校正 `setup.mjs` 里的目录映射。

> 一句话：OpenCode 靠"目录里有没有定义文件"识别命令，不靠一句声明。所谓"上下文文件"= 往 `agent/command/skill` 目录里放 `.md`。可行性先按方案 B 在**单个项目**验证，通过再自动化，风险最低。

---

## MCP 取数通道（默认不启用）

OpenCode 没有“插件自带相对注册表”这个概念，所以壳 server 的配置由 `setup.mjs` 写进目标目录的 `opencode.json`：

```jsonc
// <目标目录>/opencode.json（setup 只做 merge，不覆盖你其它配置）
{
  "mcp": {
    "supperh-drivers": {
      "type": "local",
      "command": ["python", "<目标目录>\\mcp-skeleton\\shell.py"],
      "enabled": true,
      "environment": { "SUPPERH_PRIVATE_ROOT": "<私有根绝对路径>" }
    }
  }
}
```

与 Qoder 侧的区别就一句：Qoder 的 `.mcp.json` 里**只能**有插件相对路径（绝对私有根走 `mcp-skeleton/private-root.txt` 带外传），OpenCode 没这个机制，所以入口里带绝对路径与私有根值 —— 它在你的用户配置里，不在 git 仓库里，**仍然不允许出现任何凭据**。

默认状态下所有数据源都是 `kind: script`，这条注册项就算写了也不会被调起（不装 Python 依赖也不影响现有流程）。要真用 MCP 通道：

```powershell
# 1) 装壳 server 依赖（一次性）
pip install -r "<目标目录>\mcp-skeleton\requirements.txt"

# 2) 先在私有根写 drivers/<code>/adapter.py（公司专有，不进 git），
#    再在 projects/<code>.yaml 给槽位写 kind: mcp + mcp.sources 白名单

# 3) 重跑注册探测（机械定结论）：IDE 里跑 /supperH-init，或：
node "<工具仓库路径>\scripts\init-project.mjs" --write --cwd "<你的项目绝对路径>" --values <valuesFile>
```

探测不过且 `fallback` 允许时 `kind` 会被回写成 `script`；`fallback: none` 时只报 `blocked`，不默默翻写。portable 目标（没自动写权限的渠道）不会改你的配置，而是打印上面那段待粘贴片段。确认状态：

```powershell
node "<工具仓库路径>\scripts\detect-ide.mjs"   # 看 mcp.opencode.registered / reason
```

> 两条硬约束：MCP 工具**没有退出码**，不得拿它的结果做分流判断；取数工具只绑在子 agent 上（`mcpServers` 写在 agent frontmatter），主入口与命令不绑。细节见 `skills/driver-contract/SKILL.md` §调用通道与 `.qoder/rules/10-redlines.md` R3.5。

---

## 红线 rules 怎么生效（OpenCode 没有 rules 目录）

Qoder 侧红线四件套（`.qoder/rules/00-layers.md` / `10-redlines.md` / `20-workflow.md` / `30-commands.md`）随插件一起装，IDE 每轮自动注入。OpenCode 没有“rules 目录”这个概念，官方对等能力是配置里的 `instructions`（文件路径 / glob 列表，内容作为指令注入）。所以 `setup.mjs` 往 `opencode.json` 合并写：

```jsonc
// <目标目录>/opencode.json
{
  "instructions": ["<工具仓绝对路径>/.qoder/rules/*.md"]
}
```

路径用正斜杠（OpenCode 侧 glob 走 POSIX 分隔符），指回**工具仓原件**而不是拷一份出来，三个好处：

- 改红线立即生效，**不用重装**（拷件就得每次 `setup`）；
- 两边只有一份真相，不会出现“Qoder 改了红线、OpenCode 还拿旧副本办事”；
- 反复 setup 不累积：`instructions` 里自己那条 glob 是**替换**而非追加，你手写的其它条目原样保留。

代价一条：**工具仓不能删、不能改名、不能搬位置**。搬家/改名后重跑一次 `setup.mjs`（它会把 `instructions` 里的旧 glob 换成新的）。工具仓搬家前装的旧条目会被识别并丢弃（按 `/.qoder/rules/*.md` 后缀认），不会残留一堆死路径。

> 这份 `instructions` 注入在**你机器上的 OpenCode 真实会话**里是否每轮都生效，本次未跑通实测（需要模型凭据，不属适配范围）。自检方法：重开 OpenCode 问一句“我现在的红线里有几条 exit code 约定，列出来”—— 能背出 `10-redlines.md` 的内容即生效；答不上来就把 `instructions` 字段值与 `opencode --version` 贴回来。

---

## 配置文件读写边界（.json 与 .jsonc）

实测 1.18.21 可执行文件里的加载列表同时含 `opencode.json` 与 `opencode.jsonc` —— **两个都会被读**。supperH 的纪律：

| 动作 | `opencode.json` | `opencode.jsonc` |
|------|-----------------|-------------------|
| 读（探测注册状态） | 读 | 读（宽松解析：容忍 `//`、`/* */` 注释与尾逗号） |
| 写（setup 合并 mcp / instructions） | **只写这一个** | **永不改写** |

为什么不碰 `.jsonc`：那是用户文件，`JSON.stringify` dump 会把里面的注释全抹掉。带注释的 `.json` 同样拒写（提示后只打印待粘贴片段，不静默失效）。所以：

- 你只有 `.jsonc` → supperH 新建一个 `opencode.json` 放自己的两项，两边都被加载；
- 你把 supperH 的两项手写进了 `.jsonc` → setup 不会重复写（它只拥有 `.json`），但**别两边同名键都写一份**，加载顺序未实测，行为以 OpenCode 为准；
- 探测只看 `.json` 是修前的假阴性（本机恰好就只有 `.jsonc`，会永久报“未注册”），现在两个都看。

---

## 跟 Qoder 共用同一份数据（你关心的“学习产物能不能互用”）

**能。** 原因不是“两边格式兼容”，而是**可变态根本不在 IDE 侧**：

| 东西 | 存在哪 | 跟 IDE 有关吗 |
|------|--------|---------------|
| 项目注册条目 | `<私有根>/projects/<code>.yaml` | 无 |
| 菜单注册条目 | `<私有根>/menus/<code>.yaml` | 无 |
| 学习包（代码/菜单/流程） | `<私有根>/context/<code>/...` + `CURRENT` 指针 | 无 |
| 任务台账 | `<私有根>/tasks/<code>/*.jsonl` | 无 |
| 自有驱动 | `<私有根>/drivers/<code>/` | 无 |
| 个人偏好 | `<私有根>/prefs.md` | 无 |

命令正文里的路径 token（`{{CONTEXT_ROOT}}`、`{{TASKS_ROOT}}`、`{{PROJECT.db.host}}` 这一类）**不是安装时烤死的**：sync 阶段把它们改写成 `${SUPPERH.*}` 形态，由主 agent 在**步骤 0 跑 `scripts/resolve-project.mjs`** 按当前工作区解析后自己填。所以：

- Qoder 里 `/supperH-learn` 学出来的模块，OpenCode 里 `/supperH-bug` 直接能读（同一个 `context/<code>/`）；反之也一样。
- 一边跑过 `/supperH-init`，另一边不用重做：注册表在私有根，两边看的是同一份。
- 两边 cwd 解析同一个项目 code（靠 `codeRoot` / `workspaces[]` 匹配），不存在“Qoder 叫 demo、OpenCode 叫另一个”的平行宇宙。

两个**真实前提**（不满足就会拿到陈旧数据，且不会报错）：

1. **L1 资产版本差**：命令/agent/skill 正文是**拷件**（不像 rules 那样指回工具仓）。改了工具仓源码只重跑 Qoder 侧 sync，OpenCode 目录里仍是旧命令文本。规则：**改过 `commands/ agents/ skills/` 就要两边各装一次**（Qoder：`node scripts/sync-assets.mjs` + 重启；OpenCode：重跑方案 A 的 `setup.mjs`）。红线四件套不在此列（已指回工具仓）。
2. **私有根路径一致**：两边都必须用默认的 `<工具仓>/../supper-Han-private`。谁设了 `SUPPERH_PRIVATE_ROOT` 环境变量就会静默分成两份数据。自检：`node "<工具仓>\scripts\resolve-private-root.mjs"` 在两边各跑一次，比对 `privateRoot` 与 `registryCount` 完全相等。

---

## 排障

```powershell
# 1) 全局目录里到底有没有命令文件
Get-ChildItem "$env:USERPROFILE\.config\opencode\command" -ErrorAction SilentlyContinue | Select-Object Name
#    应看到 5 个：supperH-setup.md / supperH-bootstrap.md / supperH-init.md / supperH-bug.md / supperH-learn.md

# 2) 装的时候 dist 是否存在（方案 A/B 都需要工具仓库先 sync 出 dist）
Test-Path "<工具仓库路径>\dist\supper-Han-java-plugin\commands\supperH-bug.md"
#    False → 回工具仓库跑 node scripts/sync-assets.mjs

# 3) 目录名：安装器写的是单数 agent/command/skill（实测单复数都吃，但只认 SKILL.md 子目录约定）
#    skill 必须是 skill/<name>/SKILL.md 一层子目录，平铺一个 .md 不会被发现
Get-ChildItem "$env:USERPROFILE\.config\opencode\skill" | Select-Object Name

# 4) 红线没生效时看这里：instructions 有没有指向工具仓
Get-Content "$env:USERPROFILE\.config\opencode\opencode.json" | Select-String "instructions"
Test-Path "<工具仓库路径>\.qoder\rules\10-redlines.md"    # False → 工具仓被删/改名了

# 5) MCP 壳在不在（只影响 kind: mcp 的槽位，script 通道不依赖它）
Test-Path "$env:USERPROFILE\.config\opencode\mcp-skeleton\shell.py"
Get-Content "$env:USERPROFILE\.config\opencode\opencode.json" | Select-String "supperh-drivers"
#    缺任何一个 → 重跑方案 A 的 setup 命令（它先 sync 再写 mcp + instructions）

# 6) 数据层是不是两边共用
node "<工具仓库路径>\scripts\resolve-private-root.mjs"    # 看 privateRoot / registryCount
```

仍不行：贴出 `opencode --version` 与它官方文档里"自定义命令目录"的原文，我来核对加载路径与目录映射。

---

## 与 Qoder 的差异对照

| 维度 | OpenCode（本文件） | Qoder |
|------|-------------------|-------|
| 默认作用域 | 项目级默认不识别，需全局目录或项目 `.opencode/` | 全局（一次装跨项目） |
| 装法 | `node scripts/setup.mjs --target opencode --dest <dir>` | `node scripts/sync-assets.mjs` 自动装插件 |
| 命令目录 | `~/.config/opencode/{agent,command,skill}`（单数） | `~/.qoder-cn/plugins/cache/local/supper-Han-java/` |
| MCP 注册 | `setup.mjs` 往 `<目标目录>/opencode.json` 合并写 `mcp.supperh-drivers`（绝对 shell 路径 + 私有根 env） | 插件自带 `.mcp.json`（相对路径），零手工配置 |
| 红线 rules | 不做拷贝件：`opencode.json` 的 `instructions` 指向 `<工具仓>/.qoder/rules/*.md` | `plugin.json` 声明 `rules/`，随插件装载（拷件） |
| 配置文件 | `opencode.json` + `opencode.jsonc` 都加载；supperH 只写前者 | 插件目录内 `.mcp.json`，不碰用户配置 |
| 陈旧产物 | 按 `supperh-installed.json` 清单清理，用户自放文件不动 | 整目录重建（`sync-assets.mjs` 覆写插件缓存目录） |
| 数据层 | **完全共用**：私有根 `projects/ menus/ context/ tasks/ drivers/` | 同上（见§跟 Qoder 共用同一份数据） |
| 生效 | 重开 opencode；改 `instructions` 目标文件内容无需重装 | 完全退出后重开 |
| 详见 | — | 同目录 `qoder适配说明.md` |
