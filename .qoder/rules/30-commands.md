# 命令清单（一期）

本文件加载路径：`.qoder/rules/30-commands.md`  
**约束**：本文件不得包含双花括号占位符与真实项目专有词。



## 一期启用命令

| 命令 | 承载文件 | 用途 |
|------|---------|------|
| `/supperH-setup` | `commands/supperH-setup.md` | **一键适配**：探测当前机器装了哪个 IDE（Qoder / OpenCode / 都没有），把 sync 产物拷到对应加载目录，打印下一步操作 |
| `/supperH-bootstrap` | `commands/supperH-bootstrap.md` | 私有根骨架引导。检测私有根（`supper-Han-private/`）缺失→创建 `drivers/ context/ tasks/ projects/ menus/` + `prefs.md`。**不写任何注册条目**（那是 `/supperH-init` 的唯一产物），legacy 单文件只报告、经用户同意（`--migrate`）才迁移 |
| `/supperH-init` | `commands/supperH-init.md` | **当前工作区项目注册**。扫描 cwd 预填结构字段→首次强制采集菜单来源（code/database，缺省退出 22、不可 `--force` 绕过）→只采集私密连接→`--health` 连通门禁 + 取数通道探测（机械写定 kind，探不过则回写 script）→写 `projects/<code>.yaml` + `menus/<code>.yaml`。**清场重配**：`--reinit` 先出只读计划（撤掉“已注册”这个状态，不是重刷配置），`--purge` 才执行，一律搬进 `_retired/` 隔离区不删（带 `manifest.json` 可回滚）；学习数据非空必须有 `--confirm <code>`，否则退 23 且一个文件都不动 |
| `/supperH-bug` | `commands/supperH-bug.md` | Bug 全流程主入口。步骤 0 跑解析器门禁→DB 写门禁→学习新鲜度→派 subagent 修复→验证→终判 |
| `/supperH-learn` | `commands/supperH-learn.md` | 学习入口。步骤 0 同 bug 解析器门禁→三种模式（代码/菜单/流程）学习→batch+index 落地；菜单模式按菜单来源配置建立菜单路由索引、落 `menu` 分区 |
| `/supperH-driver` | `commands/supperH-driver.md` | **数据源登记的唯一入口**（与 `/supperH-init` 解耦：源是随时长出来的，不要求首次注册时填完名单）。槽位名由用户定→描述充分性门禁→分流（驱动已存在就直接登记，否则派 `supperH-driver-author`（驱动编写） 先写驱动）→写能力归类 `writes`（`confirm`/`deny` 由用户定）→ `driver-registry.mjs` 落盘（禁止手改 YAML）|

**多项目模型**：一个窗口=一个工作区=一个 `code`；解析器按 cwd 匹配 `projects/*.yaml` 的绑定根（`identity.workspaces[]` + `codeRoot`）得出唯一 code。首次在某未注册工作区使用：`/supperH-bootstrap`（建私有根，仅需一次）→ `/supperH-init`（注册本项目）→ `/supperH-learn` 或 `/supperH-bug`。

**首次装机推荐顺序**：`git clone → npm install → /supperH-setup（装到 IDE 加载目录）→ 重启 IDE →（连私有根都没有时）/supperH-bootstrap → /supperH-init → 使用`。

## 二期规划（本仓库一期不建）

| 命令 | 用途 |
|------|------|
| `/supperH-flow` | 工作流学习：菜单级依赖关系建模 |
| `/supperH-package` | 打包脱敏产物（供团队内共享，不带真实值） |
| `/supperH-test` | 独立测试入口（当前测试只在 bug 内部派 supperH-bug-tester（测试执行） 完成） |

## 命名规范

- **前缀**：一律 `supperH-`，**大小写敏感**（`H` 必须大写）
- 不使用变体：`supper-han-` / `supper_han_` / `SupperH-` 均视为不合规
- **文件命名**与命令名严格一致：`commands/supperH-bug.md` ↔ `/supperH-bug`
- 命令名后缀使用**短横线连接的英文小写单词**，不使用数字或下划线
- **前缀覆盖三条通道**：`commands/` `agents/` `skills/` 里的标识符（文件名 stem、skill 目录名与其 `name:`）一律带前缀。
  agent 与 skill 名落在 IDE 的**全局命名空间**：别的插件导出同名资产时，谁被加载由加载顺序决定且**不报错**，
  红线里的守卫就会锁在没被加载的文件上（实案见 `docs/architecture.md` §10.18）
- **新增 subagent / skill 必须同时登记 `scripts/asset-names.mjs`**（旧名映射 + `ROLE_CN` 中文角色名）。
  标识符只用 ASCII；中文角色名只进 `description`、正文 H1 与派单文案，不进文件名/目录名。撞面门禁：`sync-assets.mjs` **exit 7**

## 硬约束

- 任何 agent 收到未识别的 `supperH-*` 前缀命令 → 立即报告"unknown supperH command"并列出当前启用清单
- 二期命令在启用前禁止在任何文档/代码/示例里以"未来支持"名义出现（避免模型幻觉调用）
