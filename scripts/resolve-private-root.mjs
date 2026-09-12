// scripts/resolve-private-root.mjs
// Locates the private root. Priority:
//   1. SUPPERH_PRIVATE_ROOT env (if it points at a directory)
//   2. sibling default <TOOL_ROOT>/../supper-Han-private
// Exports: resolvePrivateRoot() ->
//   { ok, toolRoot, privateRoot, projectFile, projectsDir,
//     privateRootExists, projectExists, registryCount, error? }
// `ok` = private root exists AND at least one project is registered, via either
// the registry (projects/*.yaml) or the legacy single project.yaml.
// 本文件同时是子目录清单的唯一真相（PRIVATE_SUBS / ensurePrivateSkeleton）：
// bootstrap.mjs（首次建骨架）与 setup.mjs（安装前幂等补齐）共用它，不得各写一份列表。
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// 私有根的子目录清单。只建目录，不建任何内容文件：条目归 /supperH-init。
// 为什么只能有一处定义：两边各写一份时漂移过一次 —— 迁移脚本建的根缺 menus/，
// 直到菜单学习首次写盘才撞上 ENOENT（距离成因三个环节）。
export const PRIVATE_SUBS = ['projects', 'menus', 'drivers', 'context', 'tasks'];

/** mkdir -p 幂等补齐骨架。返回本次真正新建的子目录名（已存在的不进列表）。 */
export function ensurePrivateSkeleton(privateRoot, { dryRun = false } = {}) {
  const created = [];
  for (const sub of PRIVATE_SUBS) {
    const dir = path.join(privateRoot, sub);
    if (fs.existsSync(dir)) continue;
    created.push(sub);
    if (!dryRun) fs.mkdirSync(dir, { recursive: true });
  }
  return { privateRoot, created };
}

function countRegistry(dir) {
  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return 0;
    return fs.readdirSync(dir).filter(n => /\.ya?ml$/i.test(n)).length;
  } catch { return 0; }
}

export function resolvePrivateRoot() {
  const toolRoot = path.resolve(__dirname, '..');
  let privateRoot;
  const env = process.env.SUPPERH_PRIVATE_ROOT;
  if (env && env.trim()) {
    privateRoot = path.resolve(env.trim());
  } else {
    privateRoot = path.resolve(toolRoot, '..', 'supper-Han-private');
  }
  const exists      = fs.existsSync(privateRoot) && fs.statSync(privateRoot).isDirectory();
  const projectFile = path.join(privateRoot, 'project.yaml');
  const projectsDir = path.join(privateRoot, 'projects');
  const projectExists = exists && fs.existsSync(projectFile);
  const registryCount = exists ? countRegistry(projectsDir) : 0;
  const ok = exists && (registryCount > 0 || projectExists);

  return {
    ok,
    toolRoot,
    privateRoot,
    projectFile,
    projectsDir,
    privateRootExists: exists,
    projectExists,
    registryCount,
    error: exists
      ? (ok ? null : `no project registered: expected projects/*.yaml or project.yaml under ${privateRoot}`)
      : `private root not found: ${privateRoot}`
  };
}

// CLI entry (used by `node scripts/resolve-private-root.mjs`)
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const r = resolvePrivateRoot();
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 2);
}
