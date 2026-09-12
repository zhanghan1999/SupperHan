# drivers-skeleton

**这是什么**：supperH 驱动契约的**参考骨架**，不是可以直接对内网用的实现。它的存在只证明两件事：

1. `skills/driver-contract/SKILL.md` 里定义的 CLI / envelope / exit-code 协议是**可执行**的
2. 你自己的内网 driver 从这里 `cp` 起步，不需要从零搭

**这里没有的东西**（故意的）：

- 任何真实内网产品名
- 任何数据库连接串、token、账号
- 任何具体主机名 / 端口 / 域名

## 文件清单

| 文件 | 角色 |
|------|------|
| `base_driver.py` | 共享工具：`BaseDriver` 基类 + `emit_ok` / `emit_error` / `SELECT_only_guard` / Decimal-datetime-bytes JSON 序列化 / 极简 YAML 解析 |
| `example_json_driver.py` | 可运行的最小示例（读本地 JSON 当数据源；无网络无凭据） |
| `example_data.json` | 示例数据集；`demo` / `users` / `invoices` 三张表 |
| `README.md` | 本文件 |

## 快速自检

前提：sync（`node scripts/sync-assets.mjs`，仓库根目录执行）已经把整个仓库（含 `drivers-skeleton/`）拷到 `dist/`；或者你直接在源码目录跑。

```bash
# 1) 先看 CLI 形状是否合规（--dry-run 不真取数据）
python drivers-skeleton/example_json_driver.py \
    --project <your-code> --source demo --dry-run
# 期望：exit 0 + 一行 envelope

# 2) 真跑一次
python drivers-skeleton/example_json_driver.py \
    --project <your-code> --source demo --limit 3
# 期望：exit 0 + envelope 里 meta.count=3, meta.truncated=true

# 3) 触发 exit 2（未知 source）
python drivers-skeleton/example_json_driver.py \
    --project <your-code> --source notexist
# 期望：exit 2 + envelope.error.code=2

# 4) 触发 exit 1（未注册的项目 code）
python drivers-skeleton/example_json_driver.py \
    --project wrong-code --source demo
# 期望：exit 1 + envelope.error.code=1
```

## 派生你自己的内网 driver（三步走）

### 步骤 1：拷贝骨架

```bash
cp drivers-skeleton/base_driver.py \
   "{{PRIVATE_ROOT}}/drivers/base_driver.py"
cp drivers-skeleton/example_json_driver.py \
   "{{PRIVATE_ROOT}}/drivers/my_db_driver.py"
```

（`{{PRIVATE_ROOT}}` 是 `<TOOL_ROOT>/../supper-Han-private/`；bootstrap 命令已经建好）

### 步骤 2：改 `run()` 方法

`my_db_driver.py` 里 `ExampleJsonDriver.run()` 是**唯一需要动的地方**。典型改动：

```python
class MyDbDriver(BaseDriver):
    name = "my_db_driver"
    version = "1.0.0"

    def run(self, args, project_cfg, filters, params_json):
        # 从 project_cfg 读 db 配置；从 .secrets 读凭据
        db_cfg = project_cfg["db"]
        secret = json.loads((Path(__file__).parent / ".secrets" / "db.local.json").read_text())

        # SELECT-only 守卫（读操作也跑一遍防御性检查）
        # 占位符与绑定值分开返：`query` 要报的是真执行的那一条，不是拼好值的那一条
        sql, bound = build_sql_from(args, filters)
        SELECT_only_guard(sql, db_cfg["schemas"]["test"], db_cfg["forbidWriteSchemas"])

        # 真实连接
        conn = connect(host=db_cfg["host"], port=db_cfg["port"],
                       user=secret["readonly_user"], password=secret["readonly_pwd"])
        rows = conn.query(sql, bound, limit=args.limit)

        emit_ok(columns=rows.columns, rows=rows.data,
                source=args.source, truncated=rows.truncated,
                query=sql, params=bound,      # 执行了什么就得报什么
                driver_version=self.version)
```

**必守规则**（详见 `skills/driver-contract/SKILL.md`）：

- stdout 只放最终 envelope；一切 debug/traceback 走 stderr
- 成功信封必须定下语句申报状态：`query=`（真执行的那一条，占位符保留）或
  `query_omitted=`（`adapter_opaque` / `redacted` / `not_applicable` 三选一）。两个都不给
  不合法：上层只能把它报成 `query_missing`，而它的结果本就无法被任何人复核
- 未处理异常 → 基类会兜底转成 `emit_error(5, ...)`；不要吞
- 凭据只从环境变量 / `.secrets/*.local.json` 读；不从 argv / project.yaml 读

### 步骤 3：登记（不要手改 YAML）

驱动文件写好了，注册表里还没有它。**登记走 `/supperH-driver`**（它内部调 `node "{{TOOL_ROOT}}/scripts/driver-registry.mjs"`）。别手改 `{{PRIVATE_ROOT}}/projects/<code>.yaml`：那条命令会先备份、在内存里过 schema、跑探活（**探活不过就不落盘**），再按字段顺序写成合法 YAML。手改恰好能改出这三件它拦得住的事：schema 违规、两个槽位同时标 `role: database`（写保护拿不到确定出口）、以及 `healthCheck` 指向一个根本跑不通的命令。

登记完成后那一槽长这样（**槽位名由你定**，几个都行；推荐用槽位名当文件名，方便一眼对上）：

```yaml
drivers:
  <你起的槽位名>:                              # 例：bizdb / auditlog / crm
    desc: "这个源是干什么的，一句话说清"     # L1 判用途的唯一线索：新登记不给会退 2
    impl: "{{DRIVERS_ROOT}}/<你起的槽位名>.py"
    healthCheck: "python {{DRIVERS_ROOT}}/<你起的槽位名>.py --project <code> --health"
    role: database                             # 只有数据库通道写这一行，全项目最多一个
    config:
      sources: [test, uat, prod]
```

（`impl` / `healthCheck` 里的 `{{DRIVERS_ROOT}}` 会被展开成绝对路径；也可以直接写绝对路径。不写 `role` 的槽位对 L1 就是“某个用户命名的只读源”，靠 `desc` 判用途。）

**登记后不需重跑 sync、也不需重启 IDE**：`projects/<code>.yaml` 属 L2，解析器每次运行现读；sync 只烤 L1 产物（`agents/` `commands/` `skills/`）。加一个外部源永远不改 L1（那条纪律本身钉在 `tests/l1-slot-neutrality.test.mjs`）。

**探活不是 shape 检查**：`healthCheck` 必须**真说协议** —— DB 用配置里的账号真连一次（连上即关，不查业
务数据），HTTP 类发一个请求拿到**任意状态行**即算服务在场（`401/403` → exit 4，只缺凭据；拒连/超时 →
exit 3）。禁止拿 ICMP ping / 网卡或 VPN 客户端名 / 裸 TCP connect 当判据：零信任网关对 VPN 网段的
**任意端口**都本地代答 accept，那些写法在全断的情况下依旧报绿灯（实测数据与退场理由：
`docs/architecture.md` §10.8）。预算：单端点 ≤8s、总 ≤20s、绝不卡死 —— 预算按**冷启动**定，
不要压到 2–3s：同一个 HTTPS 端点冷启动首次 TLS 握手经隧道 >3s（3s 预算会把活着的服务报成不可达
= 假阻断），预热后只耗 0.2s。

## 常见错误

| 现象 | 原因 | 修法 |
|------|------|------|
| `exit 1` + `private root not found` | 从仓库里跑骨架而不是从 `{{DRIVERS_ROOT}}/` 跑 | 设 `SUPPERH_PRIVATE_ROOT=<abs path>` 环境变量，或按步骤 1 先 cp 到私有根 |
| `exit 5` + traceback | 你 `run()` 里抛异常没接住 | 基类会打完整 traceback 到 stderr；按提示修；不要 swallow |
| stdout 里出现"调试信息 + JSON"两段 | 你 print 到了 stdout | 全部改成 `sys.stderr.write`；或调用 `base_driver.trace()` |
| envelope 校验失败 | 输出结构缺 `ok` / `meta` / `data` | 必须用 `emit_ok` / `emit_error`，不要手写 JSON |
| filter key 不在 columns | `--filter` 传了不存在的列 | 先跑一次无 filter 拿 columns，或按业务侧规范修 |

## 与 sync / dist 的关系

`sync-assets.mjs` 会把整个 `drivers-skeleton/` 拷进 `dist/supper-Han-java-plugin/drivers-skeleton/`，并对 `.md/.py/.json` 做占位符替换。因此：

- 你在 `drivers-skeleton/` 里写的任何 `PROJECT.<字段>` 类占位符都会被替换成真实值
- **不要**在本目录写真实内网产品名 / 主机 / 凭据；`node scripts/sync-assets.mjs --check` 的纯度扫描会拿注册条目的专有值与本机绝对路径比对全仓上传物，命中即 **exit 5** 阻断（判据见 `docs/placeholders.md` §9，红线见 `.qoder/rules/10-redlines.md` R1）
- 用户自开发的 driver 放到 `{{DRIVERS_ROOT}}/`，**不进** `dist/`
