---
description: 当用户是首次使用、私有根（supper-Han-private/）还不存在，或需要补齐私有根骨架目录（说“怎么开始”“初始化私有根”）时，用本命令。它只创建/补齐 `<TOOL_ROOT>/../supper-Han-private/` 的骨架目录与 prefs.md，然后把“注册项目”这一步交给 /supperH-init。若只是想把已构好的产物装到 IDE 加载目录，改用 /supperH-setup；想给某个具体工作区建注册条目，改用 /supperH-init。
mode: primary
permission:
  edit: deny                  # 本命令不写任何配置文件，落盘动作全在 scripts/bootstrap.mjs 里
  bash: allow
  external_directory: allow   # 脚本需创建 <TOOL_ROOT>/../supper-Han-private/
---

# /supperH-bootstrap · 私有根骨架引导

## 职责边界（一句话）

**bootstrap 建目录，init 写条目。** 本命令不生成、不修改、不覆盖任何项目配置（`projects/<code>.yaml` / `menus/<code>.yaml`）——那些只能由 `/supperH-init` 在**目标项目的工作区**里扫描后生成，否则结构字段（模块清单 / 包链 / git 分支）就得靠人肉猜。

> 为什么曾经不是这样（F-9）：本命令旧版从 `schemas/project.example.yaml` 复制一份写 `<私有根>/project.yaml`，并交互式问四个字段。于是“注册项目”有两个入口，而这里是劣化复制：无扫描、无探活门禁、无菜单采集，产物还是注册表模型之前的 legacy 单文件，要事后靠 `scripts/migrate-registry.mjs` 收尸。两个入口并存时用户不知道该跑哪个 —— 现在分工不重叠。

## 前置自检

本命令**故意允许未替换的双花括号占位符出现在自身 prompt 里**（跑本命令时私有根可能还没建），但仍需 `TOOL_ROOT` 已被替换。若 `TOOL_ROOT` 未替换 → 说明连本仓库源码都没经过 sync，此时唯一动作是提示用户："请先在终端（本仓库根目录）跑 `node scripts/sync-assets.mjs` 构建产物，再重启 IDE；注册项目在目标工作区跑 `/supperH-init`"。

## 工作流

### 步骤 1 · 检测私有根

```
node "{{TOOL_ROOT}}/scripts/bootstrap.mjs" --check
```

- `0` → 骨架与条目都在：跳到步骤 4 复述现状（本命令到此就算完成，别顺手改任何配置）
- `2` → 未就绪（`message` 里会写清是"私有根不存在"还是"私有根里没有任何注册条目"）→ 步骤 2

### 步骤 2 · 创建骨架（需用户确认）

用 `question` 工具确认：

> 我将在 `<TOOL_ROOT>/../supper-Han-private/` 创建私有根骨架：`projects/` `menus/` `drivers/` `context/` `tasks/` 五个子目录 + `prefs.md`。此目录**不进 git**（私有数据只落这里）。确认？

用户确认后执行 `node "{{TOOL_ROOT}}/scripts/bootstrap.mjs"`（幂等：已存在的目录与 `prefs.md` 一律不动）。

### 步骤 3 · legacy 单文件处置（仅当脚本报告它存在）

`<私有根>/project.yaml` 是注册表模型之前的形态。脚本会打印它的路径并给出迁移命令，但**不会自作主张改名**：

- 先让用户看一眼：`node "{{TOOL_ROOT}}/scripts/migrate-registry.mjs" --dry-run`
- 用户同意后再执行：`node "{{TOOL_ROOT}}/scripts/bootstrap.mjs" --migrate`（原文保留为 `project.yaml.migrated.bak`，不删）

### 步骤 4 · 指路（本命令的收尾就是这一步）

按脚本输出复述，不改写：

1. **注册项目**：到目标 Java 项目的工作区里跑 `/supperH-init`（或 CLI：`node "{{TOOL_ROOT}}/scripts/init-project.mjs" --write --cwd <绝对路径>`）。它会扫描结构预填字段，然后问“接哪些外部源”——**一个都不接也可以**（纯代码模式，`db`/`drivers` 两段整段不写，不留模板假值）。
2. **校验条目**：`node "{{TOOL_ROOT}}/scripts/validate-project.mjs"`
3. **构建产物**：`node "{{TOOL_ROOT}}/scripts/sync-assets.mjs"` —— 只在 L1 资产（`commands/` `agents/` `skills/` `.qoder/rules/`）变化后才需要；**新增/修改注册条目不需要重跑 sync**（dist 与具体项目无关，`PROJECT.*` 在运行期由解析器填）。
4. 重启 IDE → `/supperH-bug <你的第一个 bug 描述>`。

## 边界

- **禁止**写任何 `projects/*.yaml` / `menus/*.yaml`：那是 `/supperH-init` 的唯一产物（本命令 `edit: deny` 就是这条边界的机械表达）
- **禁止**把私有根创建到本仓库内（`{{TOOL_ROOT}}/supper-Han-private/` 是错的；必须是同级 `../supper-Han-private/`，或用户显式设 `SUPPERH_PRIVATE_ROOT`）
- **禁止**覆盖已存在的 `prefs.md`（它是 L3 用户资产）
- **禁止**未经用户同意改名/删除 legacy `project.yaml`：只有 `--migrate`（= 用户点了头）才动它，且原文转 `.migrated.bak` 保留
- **禁止**把配置内容原样 dump 到终端（只回显字段名 + 校验结果，不打印值）
- 本命令**不接**任何外部数据源、不探活、不猜 VPN 状态：那些都在 `/supperH-init` 的机械门禁里做
