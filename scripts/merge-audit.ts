/**
 * scripts/merge-audit.ts — find code an upstream merge dropped in silence.
 *
 * Usage:
 *   pnpm exec tsx scripts/merge-audit.ts <backup-ref> [<upstream-ref>]
 *
 * git only raises a conflict when both sides touch the same lines. When
 * upstream restructures a region a fork had added to, the merge succeeds and
 * the fork's lines are simply gone — the build still compiles and the tests
 * still pass, because nothing references what is no longer there.
 *
 * The audit compares what the merge removed (<backup-ref>..HEAD) against what
 * upstream itself removed. A deletion upstream also made is intended; a
 * deletion nobody upstream asked for is the silent drop. Exits 1 when there is
 * something to look at, so `/update-nanoclaw` can stop before the build.
 */
import { spawnSync } from 'node:child_process';

export interface FileDiff {
  file: string;
  added: string[];
  removed: string[];
}

export interface FileAudit {
  file: string;
  dropped: string[];
}

/**
 * Split a unified diff into per-file added/removed content lines.
 *
 * Content is only read inside a hunk. Deleted text starting with `--` renders
 * as `--- …`, which no prefix test can tell from a file header — position
 * relative to the `@@` line can.
 */
export function parseDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: FileDiff | undefined;
  let inHunk = false;

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      current = { file: m ? m[2] : line.slice('diff --git '.length), added: [], removed: [] };
      files.push(current);
      inHunk = false;
    } else if (line.startsWith('@@')) {
      inHunk = true;
    } else if (inHunk && current) {
      if (line.startsWith('+')) current.added.push(line.slice(1));
      else if (line.startsWith('-')) current.removed.push(line.slice(1));
    }
  }
  return files;
}

/**
 * Deletions in `mergeDiff` that `upstreamDiff` does not account for, per file.
 *
 * Dropped from the report: whitespace-only lines, and any line the same file
 * also added — removed here and re-added there is a move, not a loss. Upstream
 * is matched per file, since the same text deleted from some other file
 * explains nothing.
 */
export function auditDeletions(mergeDiff: string, upstreamDiff: string): FileAudit[] {
  const upstreamRemoved = new Map<string, Set<string>>();
  for (const f of parseDiff(upstreamDiff)) upstreamRemoved.set(f.file, new Set(f.removed));

  const audits: FileAudit[] = [];
  for (const f of parseDiff(mergeDiff)) {
    const explained = upstreamRemoved.get(f.file) ?? new Set<string>();
    const added = new Set(f.added);
    const dropped = [...new Set(f.removed)].filter(
      (line) => line.trim() !== '' && !explained.has(line) && !added.has(line),
    );
    if (dropped.length > 0) audits.push({ file: f.file, dropped });
  }
  return audits;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const MAX_LINES_PER_FILE = 20;

/**
 * Run git, or exit 2 — never 1. "The audit could not run" must not be
 * indistinguishable from "the audit found nothing".
 */
function git(...args: string[]): string {
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) {
    console.error(`merge-audit could not run \`git ${args.join(' ')}\`:`);
    console.error((r.stderr || r.error?.message || 'unknown error').trim());
    process.exit(2);
  }
  return r.stdout;
}

function main(backupRef: string, upstreamRef: string): number {
  const base = git('merge-base', backupRef, upstreamRef).trim();
  const audits = auditDeletions(git('diff', `${backupRef}..HEAD`), git('diff', `${base}..${upstreamRef}`));

  if (audits.length === 0) {
    console.log(`No unexplained deletions between ${backupRef} and HEAD.`);
    return 0;
  }

  const total = audits.reduce((n, a) => n + a.dropped.length, 0);
  console.log(`${total} line(s) across ${audits.length} file(s) were removed without upstream removing them:\n`);
  for (const a of audits) {
    console.log(`${a.file} (${a.dropped.length})`);
    for (const line of a.dropped.slice(0, MAX_LINES_PER_FILE)) console.log(`  - ${line}`);
    if (a.dropped.length > MAX_LINES_PER_FILE) {
      console.log(`  … ${a.dropped.length - MAX_LINES_PER_FILE} more — git diff ${backupRef}..HEAD -- ${a.file}`);
    }
    console.log('');
  }
  console.log('Review each one: restore what the merge dropped, or confirm it was meant to go.');
  return 1;
}

if (process.argv[1]?.endsWith('merge-audit.ts')) {
  const [, , backupRef, upstreamRef = 'upstream/main'] = process.argv;
  if (!backupRef) {
    console.error('Usage: pnpm exec tsx scripts/merge-audit.ts <backup-ref> [<upstream-ref>]');
    process.exit(2);
  }
  process.exit(main(backupRef, upstreamRef));
}
