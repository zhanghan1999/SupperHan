# Qoder 适配说明 · 在自己的项目里用 /supperH

> 本文件**只解决一件事**：当你用 Qoder 打开**自己的 Java 项目**（不是 supper-Han-java 工具仓库本身）时，怎么让那组 `/supperH` 命令出现在输入框的斜杠菜单里、能在当前项目上下文中调用。
>
> 这与配置向导（建私有根骨架、按工作区注册项目、连通检测）**是两件事**，互不依赖。那份见 `commands/supperH-setup.md`、`commands/supperH-bootstrap.md` 与 `commands/supperH-init.md`；本文件只讲**命令在 Qoder 里的加载路径与作用域**。

---

## 一句话结论

Qoder 的 supperH 是**全局安装**的：装一次，之后**任意项目**打开 Qoder 都能直接用 `/supperH-*`，**不需要**在每个项目里单独放文件。这跟 OpenCode 的"项目级默认不识别"正好相反（见同目录 `opencode适配说明.md`）。

---

## 为什么会这样（原理）

supper-Han-java 通过 `node scripts/sync-assets.mjs`（仓库根目录执行；别名 `npm run sync`）打包成一个 **Qoder 插件**，安装到：

```
~/.qoder-cn/plugins/cache/local/supper-Han-java/
```

并登记进全局清单：

```
~/.qoder-cn/plugins/installed_plugins_v2.json
```

Qoder 启动时读的是这个**用户级全局目录**，与"当前打开哪个 workspace"无关。所以只要插件装好 + Qoder 重启过一次，`/supperH-*` 在你打开的**任何**项目里都可用。

---

## 前置：先确保插件已装（在本工具仓库里执行一次）

在 `supper-Han-java` 仓库根目录：

```powershell
# 若从没装过：
npm install
node scripts/sync-assets.mjs   # 产出 dist 并自动安装 Qoder 插件到全局缓存目录
```

`sync` 成功后会在末尾打印类似：

```
[sync] qoder installed: C:\Users\<你>\.qoder-cn\plugins\cache\local\supper-Han-java
```

看到这一行即代表插件已落到全局。

---

## 生效步骤（在你的 Java 项目里）

1. **完全退出 Qoder** —— 不是关窗口。任务栏右下角托盘图标也要**右键 → 退出**，确保进程结束。
2. 重新打开 Qoder。
3. 用 Qoder 打开**你自己的 Java 项目**（例如某个 `xxx-service` 目录），而不是 supper-Han-java 工具仓库。
4. 在底部输入框敲 `/sup`。

**预期**：下拉里出现下面这些命令：

| 命令 | 用途 |
|------|------|
| `/supperH-setup` | 一键适配：探测 IDE + 把产物装到加载目录 |
| `/supperH-bootstrap` | 建私有根**骨架**（五个子目录 + `prefs.md`）。不写任何注册条目，也不跑 sync |
| `/supperH-init` | 当前工作区注册：落 `projects/<code>.yaml` + `screens/<code>.yaml`（exit 10 未注册时跑它）|
| `/supperH-bug` | Bug 全流程主入口 |
| `/supperH-learn` | 代码/页面/流程学习入口 |
| `/supperH-driver` | 数据源登记：往已注册条目里加 / 改 / 删 / 看一个外部数据源（槽位名由用户定）|

---

## 验证判据

在你项目的输入框敲 `/supperH-learn --module <你项目里的一个模块>` 冒烟：

- 能看到命令、且回车后主 agent 开始派发子任务 → **适配成功**。
- 注意：首次用 `/supperH-bug` / `/supperH-learn` 前，当前工作区必须已在私有根注册（注册表条目 `<PRIVATE_ROOT>/projects/<code>.yaml` 的 `codeRoot` / `identity.workspaces` 指向**你当前打开的这个项目**），否则会命中步骤 0 的项目门禁报错（退出码 **10** = 本目录未注册）。这是配置问题，不是加载问题 —— **跑 `/supperH-init` 把当前工作区注册进去**（只有连私有根目录都还不存在时才先跑 `/supperH-bootstrap`）。

---

## 看不到命令时的排障（按序）

```powershell
# 1) 插件到底装没装
Test-Path "$env:USERPROFILE\.qoder-cn\plugins\cache\local\supper-Han-java\.qoder-plugin\plugin.json"
#    False → 从没 sync 成功过。回工具仓库跑： node scripts/sync-assets.mjs

# 2) 装了但没登记
Get-Content "$env:USERPROFILE\.qoder-cn\plugins\installed_plugins_v2.json" | Select-String "supper-Han-java"
#    无输出 → 重跑 node scripts/sync-assets.mjs 让它写清单

# 3) 登记了也重启了还是没有
#    → 确认 Qoder 是"彻底退出"（托盘图标消失），不是只关窗口
```

仍不行：把 `Test-Path` 与 `Get-Content` 两条命令的输出贴出来定位。

---

## MCP 取数通道（默认不启用，也不用你配置）

插件**自带**一条 MCP 注册表，sync（`node scripts/sync-assets.mjs`）会一并产出到安装目录：

```
~/.qoder-cn/plugins/cache/local/supper-Han-java/.mcp.json      # 只有一条 supperh-drivers
                                                       # 内容是插件相对路径 + env 变量名单，无凭据无盘符
```

所以 Qoder 这边**不需要手工粘配置**（跟 OpenCode 不同，见 `opencode适配说明.md`）。默认状态下所有数据源都是 `kind: script`（走 bash 跑脚本），MCP 通道完全闲置 —— 不装 Python 依赖也不影响任何现有流程。

想把某个源改走 MCP 通道时（先决条件：私有根里已有 `drivers/<code>/adapter.py`）：

```powershell
# 1) 装壳 server 的 Python 依赖（一次性）
pip install -r "$env:USERPROFILE\.qoder-cn\plugins\cache\local\supper-Han-java\mcp-skeleton\requirements.txt"

# 2) 在该项目的 projects/<code>.yaml 里给槽位写 kind: mcp + mcp.sources 白名单

# 3) 重跑注册探测（机械定结论，不靠模型判断）
#    在 IDE 里跑 /supperH-init，或在工具仓库里：
node scripts\init-project.mjs --write --cwd "<你的项目绝对路径>" --values <valuesFile>
```

探测不过且 `fallback` 允许时，`kind` 会被**回写成 `script`** 再落盘；`fallback: none` 时只报 `blocked`（不默默翻写）。确认注册状态用只读探测：

```powershell
node scripts\detect-ide.mjs | Select-String '"mcp"' -Context 0,6
#    mcp.qoder.registered: true → 壳已注册；false + reason → 按 reason 修（通常是该重跑 node scripts/sync-assets.mjs）
```

> 两条硬约束：MCP 工具**没有退出码**，所以不得拿它的结果做分流判断；取数工具只绑在子 agent 上，主入口与命令不绑。细节见 `skills/supperH-driver-contract/SKILL.md` §调用通道与 `.qoder/rules/10-redlines.md` R3.5。

---

## 可选：让某个项目用"专属配置"

Qoder 是 **全局优先、项目可覆盖** 的模型：

- 全局装的插件对所有项目生效（默认就是你要的"跨项目公用"）。
- 反过来说要当心**同名遮蔽**：agent / skill 名落在 IDE 的**全局命名空间**，另一个 enabled 插件导出同名文件时，
  谁被加载取决于加载顺序且**不报错**。本插件 `agents/` `skills/` 的标识符因此一律带 `supperH-` 前缀
  （实案与门禁见 `docs/architecture.md` §10.18），且 `node scripts/sync-assets.mjs --check` 会替你盯着（exit 7）。
- 若某个项目想用**不同的命令/规则**，可在**该项目根**放一个 `.qoder/` 目录承载项目级定义；它会与全局插件叠加。绝大多数场景不需要——因为"哪个项目"这件事是靠注册表 `projects/<code>.yaml` 的 `codeRoot` + `identity.code` 区分的，而不是靠给每个项目装一份插件。

> 换项目时你**不需要重装插件**，只需要在**新工作区**跑一次 `/supperH-init`（它按当前 cwd 扫描并落一份 `projects/<code>.yaml`，多项目就是多份条目，互不覆盖）。旧的单文件 `project.yaml` 已被注册表取代，多项目不再靠改同一个文件切换。

---

## 两边共用同一份数据（Qoder ↔ OpenCode）

所有**可变态**都在私有根，不在 IDE 侧：`projects/<code>.yaml`、`screens/<code>.yaml`、`context/<code>/`（学习包）、`tasks/<code>/*.jsonl`、`drivers/<code>/`、`prefs.md`。命令正文里的 `{{CONTEXT_ROOT}}` 一类 token 在 sync 时被改写成 `${SUPPERH.*}`，由主 agent 步骤 0 跑 `scripts/resolve-project.mjs` 按当前工作区现填 —— 不依赖任何 IDE 变量。所以：

- Qoder 里 `/supperH-learn` 学出来的模块，OpenCode 里 `/supperH-bug` 直接能读（反之亦同）；
- 一边跑过 `/supperH-init`，另一边不需重做；
- 前提是两边都用默认私有根（谁设了 `SUPPERH_PRIVATE_ROOT` 就会静默分成两份），且两边都装过最新资产。

唯一**不共用**的是 L1 文本拷贝件：命令/agent/skill 在两边各存一份，改了工具仓源码要两边各重装一次（Qoder：`node scripts/sync-assets.mjs` + 重启；OpenCode：重跑 `setup.mjs --target opencode`）。**红线四件套例外** —— OpenCode 侧不做拷贝件，靠 `instructions` 指回 `<工具仓>/.qoder/rules/*.md`，改一次两边同时生效。细节见 `opencode适配说明.md`。

---

## 与 OpenCode 的差异对照

| 维度 | Qoder（本文件） | OpenCode |
|------|----------------|----------|
| 默认作用域 | 全局（一次装，跨项目） | 项目级默认不识别，需全局目录或项目 `.opencode/` |
| 装法 | `node scripts/sync-assets.mjs` 自动装插件 | `node scripts/setup.mjs --target opencode --dest <dir>` 拷贝 |
| 红线 rules | `plugin.json` 声明 `rules/`，随插件装载（**拷贝件**，改完要重装） | 无 rules 目录概念：`opencode.json` 的 `instructions` 指向 `<工具仓>/.qoder/rules/*.md`（**单一真相**，改完即生效） |
| MCP 注册 | 插件自带 `.mcp.json`，零手工配置 | 写进 `<目标目录>/opencode.json` 的 `mcp` 块（portable 只打印待粘贴片段）|
| 配置文件 | 不碰用户配置 | `opencode.json` / `opencode.jsonc` 都加载；supperH 只写前者，.jsonc 永不改写 |
| 陈旧产物 | 整目录重建（rm + copy，用户放进插件目录的东西会被抹） | 按 `supperh-installed.json` 清单只删自己放的，用户文件不动 |
| 数据层 | **完全共用**：私有根 `projects/ screens/ context/ tasks/ drivers/` | 同上 |
| 生效 | 完全退出后重开 | 重开 opencode CLI / 面板 |
| 详见 | — | 同目录 `opencode适配说明.md` |
