// scripts/migrate-registry.mjs
// One-time migration: legacy single <PRIVATE_ROOT>/project.yaml
//                -> registry <PRIVATE_ROOT>/projects/<code>.yaml
//
// - Idempotent: skips if projects/<code>.yaml already exists.
// - Preserves the user's file (comments included) by copying text and only
//   inserting an `identity.workspaces: [<codeRoot>]` block if none exists.
//   (The resolver also binds on codeRoot, so workspaces is an optional extra.)
// - Ensures context/<code>/ and tasks/<code>/ partitions exist.
// - Backs up the legacy file to project.yaml.migrated.bak (never deletes source).
//
// Usage:
//   node scripts/migrate-registry.mjs [--dry-run]
import fs   from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { pathToFileURL } from 'node:url';
import { resolvePrivateRoot } from './resolve-private-root.mjs';

function log(...a) { console.log('[migrate]', ...a); }

function ensureWorkspaces(text, codeRoot) {
  if (/^\s{2}workspaces:/m.test(text)) return { text, inserted: false };
  if (!codeRoot) return { text, inserted: false };
  const lines = text.split(/\r\n?|\n/);
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const idx = lines.findIndex(l => /^identity:\s*$/.test(l));
  const block = ['  workspaces:', `    - "${String(codeRoot).replace(/"/g, '\\"')}"`];
  if (idx >= 0) {
    lines.splice(idx + 1, 0, ...block);
  } else {
    // No identity: block — prepend one.
    lines.unshift(...block.reverse(), 'identity:');
  }
  return { text: lines.join(eol), inserted: true };
}

export function migrate({ dryRun = false } = {}) {
  const info = resolvePrivateRoot();
  const privateRoot = info.privateRoot;
  if (!info.privateRootExists) {
    log('private root not found at', privateRoot, '— nothing to migrate.');
    return { ok: true, migrated: [], skipped: ['no-private-root'] };
  }
  const projectsDir = path.join(privateRoot, 'projects');
  const legacy = path.join(privateRoot, 'project.yaml');

  if (!fs.existsSync(legacy)) {
    const have = fs.existsSync(projectsDir)
      ? fs.readdirSync(projectsDir).filter(n => /\.ya?ml$/i.test(n)) : [];
    log('no legacy project.yaml; registry has', have.length, 'project(s). Nothing to do.');
    return { ok: true, migrated: [], skipped: ['already-or-nothing'] };
  }

  let text = fs.readFileSync(legacy, 'utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  let data;
  try { data = YAML.parse(text); }
  catch (e) { log('cannot parse legacy project.yaml:', e.message, '— abort.'); return { ok: false, error: 'parse' }; }

  const code = data?.identity?.code;
  const codeRoot = data?.codeRoot;
  if (!code) { log('legacy project.yaml has no identity.code — abort.'); return { ok: false, error: 'no-code' }; }

  const target = path.join(projectsDir, code + '.yaml');
  const result = { ok: true, migrated: [], skipped: [] };

  if (fs.existsSync(target)) {
    log('projects/' + code + '.yaml already exists — skipping copy (idempotent).');
    result.skipped.push(code);
  } else {
    const { text: out, inserted } = ensureWorkspaces(text, codeRoot);
    log((dryRun ? '[dry-run] would write ' : 'writing ') + target + (inserted ? ' (+workspaces)' : ''));
    if (!dryRun) {
      fs.mkdirSync(projectsDir, { recursive: true });
      fs.writeFileSync(target, out, 'utf8');
    }
    result.migrated.push(code);
  }

  for (const sub of ['context', 'tasks']) {
    const d = path.join(privateRoot, sub, code);
    if (!fs.existsSync(d)) {
      log((dryRun ? '[dry-run] would mkdir ' : 'mkdir ') + d);
      if (!dryRun) fs.mkdirSync(d, { recursive: true });
    }
  }

  if (result.migrated.length && !dryRun) {
    const bak = legacy + '.migrated.bak';
    if (!fs.existsSync(bak)) {
      fs.renameSync(legacy, bak);
      log('moved legacy ->', bak, '(restore any time; resolver ignores it once projects/ is populated)');
    }
  } else if (result.migrated.length && dryRun) {
    log('[dry-run] would move legacy ->', legacy + '.migrated.bak');
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const dryRun = process.argv.slice(2).includes('--dry-run');
  const r = migrate({ dryRun });
  process.exit(r.ok ? 0 : 2);
}
