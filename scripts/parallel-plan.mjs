#!/usr/bin/env node
// scripts/parallel-plan.mjs
// --parallel-plan 脚本出口：把「route 清单 → slices[]」收编成纯机械变换（对齐 flow-engine buildPlan）。
// 只读代码 + 只读 resolver 绑定，不写任何文件；同输入必同字节输出。
// 与 flow 侧 normalizeRoute() 的区别：flow 故意丢弃 method，而 code 侧锚点/索引必须保留 method
// （锚点 = --- route: <METHOD> <path> ---），所以本脚本的 route 键 = METHOD path 原样，与锚点字面一致。
// 裸 @RequestMapping（未限定 method）→ 规划键统一 ALL <path>（与 writer 侧 method 归一单点一致）；
// raw_method 保留代码里的原始值（null 表示裸映射），供 analyzer 如实回传。
//
// CLI: node scripts/parallel-plan.mjs [--cwd <dir>] [--module <name>] [--controller <fqn>] [--limit <n>]
//       node scripts/parallel-plan.mjs --root <dir> --entry <glob> [--module <name>]  （纯目录模式，绕开 resolver）
// 退出码：0 = 有可派发切片；36 = 入参/解析不完整；42 = 无可学路由（NOT_READY）；
//        43 = route 扫描不完整（SCAN_INCOMPLETE，incomplete_files 列出）——计划可能漏路由，不可直接派发，
//             需人工确认这些文件后重跑，或该模块改走串行 30KB 路径（禁止主 agent 静默手搓）。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolveProject } from './resolve-project.mjs';

export const GENERATOR = 'parallel-plan/v1';
export const MAX_ROUTES_PER_SLICE = 3;      // 并行契约：≤3 route / 片（route 原子切片）
export const SLICE_BYTES_BUDGET = 20 * 1024;
export const BYTES_PER_ROUTE_EST = 2048;    // 固定成本模型：每 route 估算 2KB，写入 manifest 的 est_bytes（机械预估，供派发/回执核对；打包按 ≤3 route/片，不由本模型驱动）
export const EXIT = { OK: 0, INCOMPLETE: 36, NOT_READY: 42, SCAN_INCOMPLETE: 43 };

const SHORTHAND = { GetMapping: 'GET', PostMapping: 'POST', PutMapping: 'PUT', DeleteMapping: 'DELETE', PatchMapping: 'PATCH' };
const ANN_RE = /@(RequestMapping|GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping)(?:\(([^)]*)\))?/g;
const CLASS_DECL = /(?:class|interface|enum)\s+\w+/;
const METHOD_SIG_START = /^\s*(?:public|protected|private)\b[^{;]*\(/;   // 方法签名开括号即算（参数可能跨行）

// ── 注释剥离（防幽灵路由）──────────────────────────────────────────────────
// 为什么必须有状态机而不是"看行首"：下面第 62 行那种启发式只看行首标记（`//` / `*` / `/*`），
// 而块注释**内部**的注解行是以 `@` 开头的 —— 于是一段被注释掉的
// `/* @RequestMapping(value="check") ... */` 会被当成真路由，计划里多出一条幽灵 route，
// 而 analyzer 读源码不会产出它 → writer 的"并集覆盖计划"永远对不上 → 并行路径直接判缺口。
// 实测案例：某 Controller 末尾 263–278 行是一段块注释（第 266 行还写成 `*//*`，
// javadoc 紧接块注释），planner 数出 3 条、真实只有 2 条。
// 实现要点：**保持行结构不变**（注释字符替换成空格、换行原样保留），否则 route.line 会整体错位；
// 同时尊重字符串字面量（`"..."` / `'...'` 及其反斜杠转义），避免把 `"a/*b"` 里的 `/*` 当注释起点。
export function stripComments(src) {
  const s = String(src ?? '');
  let out = '';
  let i = 0;
  let state = 'code';   // code | line | block | dq | sq
  while (i < s.length) {
    const c = s[i], c2 = s[i + 1];
    if (state === 'code') {
      if (c === '/' && c2 === '/') { state = 'line'; out += '  '; i += 2; continue; }
      if (c === '/' && c2 === '*') { state = 'block'; out += '  '; i += 2; continue; }
      if (c === '"') { state = 'dq'; out += c; i++; continue; }
      if (c === "'") { state = 'sq'; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c; i++; continue; }
      out += ' '; i++; continue;
    }
    if (state === 'block') {
      if (c === '*' && c2 === '/') { state = 'code'; out += '  '; i += 2; continue; }
      out += (c === '\n' ? '\n' : ' '); i++; continue;
    }
    if (state === 'dq') {
      if (c === '\\') { out += c + (c2 ?? ''); i += 2; continue; }
      if (c === '"') state = 'code';
      out += c; i++; continue;
    }
    // sq
    if (c === '\\') { out += c + (c2 ?? ''); i += 2; continue; }
    if (c === "'") state = 'code';
    out += c; i++; continue;
  }
  return out;
}

// ── 路由扫描（启发式，只读注解行）────────────────────────────────────────────
export function parseRouteInventory(source) {
  const lines = stripComments(source).split(/\r?\n/);
  const routes = [];
  let classPath = null;
  let incomplete = false;

  const sigAhead = (i) => {
    // 返回第一个可判定行：类声明 / 访问修饰符开头的签名（可能拆行，public @ResponseBody + 返回类型下一行）
    for (let j = i + 1; j <= i + 8 && j < lines.length; j++) {
      const t = lines[j].trim();
      if (t === '' || t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('@')) continue;
      if (CLASS_DECL.test(t)) return { level: 'class', line: j };
      if (/^\s*(?:public|protected|private)\b/.test(t)) return { level: 'method', line: j };
      return null;
    }
    return null;
  };
  const methodNameAt = (startIdx) => {
    if (startIdx == null) return null;
    for (let j = startIdx; j <= startIdx + 4 && j < lines.length; j++) {
      const toks = lines[j].match(/(\w+)\s*\(/g);
      if (toks && toks.length) return toks[toks.length - 1].match(/(\w+)\s*\(/)[1];
    }
    return null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;  // 注释行不扫（防幽灵路由）
    let m;
    ANN_RE.lastIndex = 0;
    while ((m = ANN_RE.exec(line)) !== null) {
      const kind = m[1];
      const args = m[2] ?? '';
      let paths = [], method = null, hasMethod = false;
      if (kind === 'RequestMapping') {
        paths = collectPaths(args);
        const mm = args.match(/method\s*=\s*(?:RequestMethod\.)?(\w+)/);
        if (mm) { method = mm[1].toUpperCase(); hasMethod = true; }
      } else {
        method = SHORTHAND[kind]; hasMethod = true;
        paths = collectPaths(args);
      }
      const sameLineClass = CLASS_DECL.test(line);
      const sameLineMth = /\b(?:public|protected|private)\b[^{;]*\(/.test(line);   // 注解与签名同行也可判定
      let level = null, sigLineIdx = sameLineMth ? i : null;
      if (sameLineClass) level = 'class';
      else if (sameLineMth) level = 'method';
      else {
        const a = sigAhead(i);
        if (a) { level = a.level; sigLineIdx = a.line; }
      }
      if (level === 'class') {
        if (paths.length > 0) {
          classPath = paths[0];
          if (paths.length > 1) incomplete = true;   // 类级多前缀 → 前缀覆盖可能不全
        } else {
          classPath = '';   // 裸/仅 method 约束的类级 @RequestMapping（无路径）：Spring 语义 = 空前缀（挂根），不是未知
        }
      } else if (level === 'method') {
        const java_method = methodNameAt(sigLineIdx);
        if (paths.length > 0) {
          for (const v of paths) {   // 多值数组 {"/a","/b"} → 每个值一条路由
            const pp = joinPath(classPath, v);
            routes.push({ key: (method ?? 'ALL') + ' ' + pp, method: method ?? 'ALL', raw_method: method, path: pp, java_method, line: i + 1 });
          }
        } else if (classPath) {
          // 无路径注解（裸 @RequestMapping / method-only）→ 方法级落在类路径上（method ?? ALL）
          routes.push({ key: (method ?? 'ALL') + ' ' + classPath, method: method ?? 'ALL', raw_method: method, path: classPath, java_method, line: i + 1 });
        } else incomplete = true;
      } else {
        incomplete = true;   // 归属不明（注解紧跟的方法签名跨 5 行仍未现）
      }
    }
  }
  return { routes, classPath, incomplete };
}

function joinPath(base, p) {
  if (!base) return p;
  if (p === '') return base;   // value = {"list", ""} → "" 值 = 类路径本身
  // 试点实证：类前缀 '${adminPath}' + 方法路径 '/ctContractVer/list' → '${adminPath}'/ct/ctContractVer/list，
  // 方法路径开头的 / 是拼接到类前缀上的（本项目惯例），不按 Spring 的绝对路径语义处理。
  return base.replace(/\/+$/, '') + '/' + p.replace(/^\/+/, '');
}

// 多值数组 value = {"a","b"} / 单值 value = "a" / 位置参数 "a"；无任何路径 → []
function collectPaths(args) {
  const arr = args.match(/\{\s*((?:["'][^"']*["']\s*,\s*)*["'][^"']*["'])\s*\}/);
  if (arr) return [...arr[1].matchAll(/["']([^"']*)["']/g)].map((m) => m[1]);
  const pm = args.match(/(?:value\s*=\s*|path\s*=\s*)?["']([^"']*)["']/);
  return pm ? [pm[1]] : [];
}

// ── 确定性切片 ─────────────────────────────────────────────────────────────
export function buildParallelPlan({ routes }, opts = {}) {
  const max = opts.maxRoutesPerSlice ?? MAX_ROUTES_PER_SLICE;
  const sorted = [...routes].sort((a, b) =>
    (a.controller < b.controller ? -1 : a.controller > b.controller ? 1 : 0) ||
    (a.line - b.line) ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  sorted.forEach((r, i) => { r.id = 'r' + String(i + 1).padStart(3, '0'); });
  const slices = [];
  let cur = null;
  for (const r of sorted) {
    if (!cur || cur.route_ids.length >= max) {
      cur = { slice_id: String(slices.length + 1).padStart(2, '0'), route_ids: [], window: null };
      slices.push(cur);
    }
    cur.route_ids.push(r.id);
  }
  const byId = new Map(sorted.map((r) => [r.id, r]));
  for (const s of slices) {
    const rs = s.route_ids.map((id) => byId.get(id));
    const ctrl = [...new Set(rs.map((r) => r.controller))];
    if (ctrl.length === 1 && rs.length > 0) {
      s.window = { controller: ctrl[0], start_method: rs[0].java_method, end_method: rs[rs.length - 1].java_method };
    }
    // 机械预估（固定成本模型）：随 manifest 输出，供派发/回执核对；非硬上限，不驱动打包
    s.est_bytes = s.route_ids.length * BYTES_PER_ROUTE_EST;
  }
  return { routes: sorted, slices, total_routes: sorted.length, total_slices: slices.length };
}

// ── 模块扫描 ───────────────────────────────────────────────────────────────
export function runPlan({ effectiveRoot, entryPattern, module, controller = null, limit = null } = {}) {
  const files = collectFiles(effectiveRoot, entryPattern, limit);
  const controllers = [];
  const routes = [];
  const incompleteFiles = [];
  let scan_incomplete = false;
  for (const f of files) {
    let source = '';
    try { source = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const rel = path.relative(effectiveRoot, f).split(path.sep).join('/');
    const parsed = parseRouteInventory(source);
    const fqn = fqnOf(source, rel);
    controllers.push({ fqn, file: rel, method_count: countMethods(source), routes_count: parsed.routes.length });
    if (parsed.incomplete) { scan_incomplete = true; incompleteFiles.push(rel); }
    for (const r of parsed.routes) routes.push({ ...r, controller: fqn, file: rel });
  }
  const scoped = controller
    ? routes.filter((r) => r.controller === controller || r.controller.endsWith('.' + controller))
    : routes;
  const plan = buildParallelPlan({ routes: scoped });
  return {
    ok: plan.total_routes > 0,
    generator: GENERATOR,
    module,
    entry_pattern: entryPattern,
    controller_filter: controller ?? null,
    head_commit: gitHead(effectiveRoot),
    scan_incomplete,
    incomplete_files: incompleteFiles,
    controllers_count: controllers.length,
    controllers: controllers.map((c) => ({ fqn: c.fqn, file: c.file, method_count: c.method_count, routes_count: c.routes_count })),
    routes: plan.routes.map((r) => ({ id: r.id, key: r.key, method: r.method, raw_method: r.raw_method, path: r.path, java_method: r.java_method, controller: r.controller, file: r.file, line: r.line })),
    slices: plan.slices,
    total_routes: plan.total_routes,
    total_slices: plan.total_slices,
  };
}

export function collectFiles(root, entryPattern, limit = null) {
  const re = globToRegExp(entryPattern);
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (e.name === '.git' || e.name === 'node_modules' || e.name === 'target') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        const rel = path.relative(root, full).split(path.sep).join('/');
        if (re.test(rel)) out.push(full);
      }
    }
  };
  walk(root);
  out.sort();
  return limit ? out.slice(0, limit) : out;
}

function globToRegExp(pattern) {
  const re = pattern.split(/[\\/]+/)
    .map((seg) => seg.replace(/[.+^{}()|[\]\\$]/g, '\\$&')
      .replace(/\*\*/g, '\u0000')
      .replace(/\*/g, '[^/\\\\]*')
      .replace(/\u0000/g, '.*'))
    .join('[\\\\/]');
  return new RegExp('^' + re + '$');
}

function fqnOf(source, rel) {
  const pm = source.match(/^\s*package\s+([\w.]+)\s*;/m);
  const cn = (source.match(/\bclass\s+(\w+)/) || [])[1];
  if (pm && cn) return pm[1] + '.' + cn;
  const segs = rel.split('/').filter((s) => s !== '' && !s.endsWith('.java'));
  while (segs.length && ['src', 'main', 'java'].includes(segs[0])) segs.shift();
  return segs.join('.');
}

function countMethods(source) {
  return (source.match(/^\s*(?:public|protected|private)\b[^{;]*\(/gm) || []).length;
}

function gitHead(root) {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 5000 }).trim(); }
  catch { return null; }
}

// ── CLI ────────────────────────────────────────────────────────────────────
export async function main(argv = process.argv.slice(2)) {
  let cwd = process.cwd(), moduleName = null, controller = null, limit = null, rootDir = null, entry = null;
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    if (f === '--cwd' && argv[i + 1]) cwd = argv[++i];
    else if (f === '--module' && argv[i + 1]) moduleName = argv[++i];
    else if (f === '--controller' && argv[i + 1]) controller = argv[++i];
    else if (f === '--limit' && argv[i + 1]) limit = parseInt(argv[i + 1], 10);
    else if (f === '--root' && argv[i + 1]) rootDir = argv[++i];
    else if (f === '--entry' && argv[i + 1]) entry = argv[++i];
  }
  if (rootDir) {
    const plan = runPlan({ effectiveRoot: rootDir, entryPattern: entry ?? '**/*Controller.java', module: moduleName ?? 'default', controller, limit });
    finish(plan);
    return;
  }
  const res = await resolveProject({ cwd });
  if (!res || !res.binding || !res.binding.ok) {
    emit(EXIT.INCOMPLETE, { ok: false, generator: GENERATOR, message: '项目解析失败（resolver 未绑定）' });
    return;
  }
  const b = res.binding;
  const mods = Array.isArray(b.project?.modules) ? b.project.modules : [];
  const mod = moduleName ? mods.find((m) => m.name === moduleName) : mods[0];
  if (!mod) {
    emit(EXIT.INCOMPLETE, { ok: false, generator: GENERATOR, message: moduleName ? '模块 ' + moduleName + ' 未找到' : '项目无模块' });
    return;
  }
  const plan = runPlan({ effectiveRoot: b.effectiveRoot, entryPattern: mod.entryPattern, module: mod.name, controller, limit });
  finish(plan);
}

function finish(plan) {
  if (!plan.total_routes) return emit(EXIT.NOT_READY, plan);
  if (plan.scan_incomplete) return emit(EXIT.SCAN_INCOMPLETE, plan);   // 扫描不完整：计划可能漏路由，不可直接派发（43）
  return emit(EXIT.OK, plan);
}

function emit(code, payload) {
  process.stdout.write(JSON.stringify(payload) + '\n');
  process.exit(code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => emit(EXIT.INCOMPLETE, { ok: false, generator: GENERATOR, message: 'parallel-plan 内部异常：' + (e && e.message ? e.message : String(e)) }));
}
