// scripts/bootstrap.mjs
// CLI counterpart of /supperH-bootstrap: 它只负责一件事 —— 让私有根存在且骨架完整。
//
// 它**不生成任何项目条目**。条目一律由 /supperH-init（scripts/init-project.mjs --write --cwd <abs>）
// 产生：那里才有真实扫描（模块 / 包链 / git 分支）、外部源接入清单、探活门禁与菜单来源硬门禁。
//
// 旧形态（F-9）：本脚本从 schemas/project.example.yaml 复制一份写 <私有根>/project.yaml，
// 与注册表模型 projects/<code>.yaml 并存。两个入口都能"注册项目"，而前者是后者的劣化复制
// （无扫描、无门禁、无菜单采集，还要事后靠 migrate-registry.mjs 收尸），用户不知道该跑哪个。
// 现在两个入口分工不重叠：bootstrap 建目录，init 写条目。
//
// Usage:
//   node scripts/bootstrap.mjs              建 / 补齐私有根骨架（幂等）+ prefs.md
//   node scripts/bootstrap.mjs --check      只报状态，不写盘（未就绪 → exit 2）
//   node scripts/bootstrap.mjs --dry-run    打印将创建的路径，不写盘
//   node scripts/bootstrap.mjs --migrate    顺带跑 legacy project.yaml → projects/<code>.yaml
//
// Exit codes（与改动前同一套，未新增码值）:
//   0  骨架就绪
//   2  --check 未就绪 / 私有根不可写 / 传了已移除的 --force

import fs   from 'node:fs';
import path from 'node:path';

import { resolvePrivateRoot, ensurePrivateSkeleton, PRIVATE_SUBS } from './resolve-private-root.mjs';
import { migrate } from './migrate-registry.mjs';

const info = resolvePrivateRoot();
const args = process.argv.slice(2);
const argsSet = new Set(args);
const CHECK   = argsSet.has('--check');
const DRY     = argsSet.has('--dry-run');
const MIGRATE = argsSet.has('--migrate');

function log(...a) { console.log('[bootstrap]', ...a); }
function warnLine(...a) { console.warn('[bootstrap]', ...a); }
function die(msg, code = 2) { console.error('[bootstrap] ' + msg); process.exit(code); }

// --force 曾经的语义是"覆盖已有 project.yaml（旧文件转 .bak）"。本脚本不再写任何配置文件，
// 这个标志就没有对象了。静默忽略会比报错更糟——用户会以为覆盖已经发生。
if (argsSet.has('--force')) {
  die('--force 已随 F-9 移除：本脚本不再覆盖任何配置。重建/更新条目请用 ' +
      'node scripts/init-project.mjs --write --cwd <abs> --force（它覆盖的是 projects/<code>.yaml）');
}

if (CHECK) {
  log('private root :', info.privateRoot);
  log('privateRootExists:', info.privateRootExists, ' registryCount:', info.registryCount,
      ' legacy project.yaml:', info.projectExists ? 'present' : 'absent');
  log('ready:', info.ok, info.ok ? '' : ' (' + info.error + ')');
  process.exit(info.ok ? 0 : 2);
}

log('tool root    :', info.toolRoot);
log('private root :', info.privateRoot);

if (DRY && !info.privateRootExists) log('[dry-run] would create', info.privateRoot);
const sk = ensurePrivateSkeleton(info.privateRoot, { dryRun: DRY });
if (!DRY) log(`skeleton ok: ${info.privateRoot} (${sk.created.length ? 'created ' + sk.created.join('/') : 'all present'})`);
else log('[dry-run] would mkdir:', sk.created.map(s => path.join(info.privateRoot, s)).join(' , ') || '(nothing missing)');

// prefs.md：唯一一份"用户手写偏好"文件，缺了才从模板复制（存在就绝不覆盖 —— 它是用户资产）。
const prefsExample = path.join(info.toolRoot, 'schemas', 'prefs.example.md');
const prefsTarget  = path.join(info.privateRoot, 'prefs.md');
if (!fs.existsSync(prefsTarget) && fs.existsSync(prefsExample)) {
  if (DRY) log('[dry-run] would copy prefs.example.md ->', prefsTarget);
  else { fs.copyFileSync(prefsExample, prefsTarget); log('wrote prefs.md from schemas/prefs.example.md（用户资产，去改它：它定汇报风格；本脚本永不覆盖已存在的 prefs.md）'); }
}

// legacy 单文件：本脚本不再产出它，但老机器上可能还有。迁移会改名（→ .migrated.bak），
// 属于动用户文件，所以默认只报告，要真做请显式 --migrate 或自己跑 migrate-registry.mjs。
if (info.projectExists) {
  warnLine('检测到 legacy 单文件条目：' + info.projectFile);
  warnLine('  注册表模型是 projects/<code>.yaml。跑 node scripts/migrate-registry.mjs --dry-run 先看，' +
           '或直接给本命令加 --migrate 让它搬过去。');
  if (MIGRATE) {
    const m = migrate({ dryRun: DRY });
    if (!m.ok) die('migration failed（详见 [migrate] 输出，legacy 文件未被破坏）');
    log(`migrate: ${m.migrated.length ? 'moved -> projects/' + m.migrated.join(', ') + '.yaml' : 'nothing to do'}`);
  }
} else if (MIGRATE) {
  log('no legacy project.yaml; nothing to migrate.');
}

log('');
if (info.registryCount === 0 && !info.projectExists) {
  log('私有根里还没有任何注册条目（projects/*.yaml 为空）。注册项目在**目标工作区**里做：');
  log('  /supperH-init                                        # IDE 里跑（会扫结构并问你接哪些外部源）');
  log(`  node "${path.join(info.toolRoot, 'scripts', 'init-project.mjs')}" --write --cwd <目标项目绝对路径>`);
  log('  接不接数据库/日志由你决定，一个都不接也可以（纯代码模式，不会留下模板假值）。');
} else {
  log(`registered: ${info.registryCount} project(s) under projects/` +
      (info.projectExists ? ' (+1 legacy project.yaml)' : ''));
}
log('');
log('next  : node "' + path.join(info.toolRoot, 'scripts', 'validate-project.mjs') + '"   # 校验注册表条目');
log('        node "' + path.join(info.toolRoot, 'scripts', 'sync-assets.mjs') + '"        # 构建 L1 产物 dist/');
log('        新增/修改注册条目**不需要**重跑 sync：dist 与具体项目无关（PROJECT.* 在运行期由解析器填）。');
log('        骨架子目录清单（幂等补齐）：' + PRIVATE_SUBS.join(' / '));
