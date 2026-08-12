import { describe, it, expect } from 'vitest';

import { parseDiff, auditDeletions } from './merge-audit.js';

// Minimal unified-diff builder: hunk header contents are irrelevant to the
// audit, only the +/- content lines matter.
function diff(file: string, ...lines: string[]): string {
  return [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, '@@ -1,3 +1,3 @@', ...lines].join('\n');
}

describe('parseDiff', () => {
  it('separates added and removed content per file', () => {
    const d = [diff('src/a.ts', '-gone', '+new', ' context'), diff('src/b.ts', '-also gone')].join('\n');
    expect(parseDiff(d)).toEqual([
      { file: 'src/a.ts', added: ['new'], removed: ['gone'] },
      { file: 'src/b.ts', added: [], removed: ['also gone'] },
    ]);
  });

  it('does not mistake file headers for content', () => {
    // `--- a/x` and `+++ b/x` sit before the first @@, so nothing outside a
    // hunk is ever read as a changed line.
    const parsed = parseDiff(diff('src/a.ts', '-gone'));
    expect(parsed[0].removed).toEqual(['gone']);
    expect(parsed[0].added).toEqual([]);
  });

  it('keeps a deleted line whose own text starts with a dash', () => {
    // A deleted SQL comment renders as `--- foo`, which is indistinguishable
    // from a file header by prefix alone — hunk position is what tells them
    // apart, and src/db/migrations/ is full of these.
    const parsed = parseDiff(diff('src/db/migrations/007.sql', '--- keep the old index', '+++ two'));
    expect(parsed[0].removed).toEqual(['-- keep the old index']);
    expect(parsed[0].added).toEqual(['++ two']);
  });

  it('ignores the no-newline marker', () => {
    expect(parseDiff(diff('src/a.ts', '-gone', '\\ No newline at end of file'))[0].removed).toEqual(['gone']);
  });

  it('returns nothing for an empty diff', () => {
    expect(parseDiff('')).toEqual([]);
  });
});

describe('auditDeletions', () => {
  it('flags a line the merge dropped from a file upstream never touched', () => {
    const merge = diff('src/container-runner.ts', '-  sdkEnv[key] = value;');
    expect(auditDeletions(merge, '')).toEqual([
      { file: 'src/container-runner.ts', dropped: ['  sdkEnv[key] = value;'] },
    ]);
  });

  it('does not flag a deletion upstream made itself', () => {
    const line = '-  const legacy = true;';
    expect(auditDeletions(diff('src/index.ts', line), diff('src/index.ts', line))).toEqual([]);
  });

  it('flags only the fork-owned deletion when upstream explains the rest', () => {
    const merge = diff('src/index.ts', '-  const legacy = true;', '-  injectSecrets(env);');
    const upstream = diff('src/index.ts', '-  const legacy = true;');
    expect(auditDeletions(merge, upstream)).toEqual([{ file: 'src/index.ts', dropped: ['  injectSecrets(env);'] }]);
  });

  it('does not flag a line that merely moved within the file', () => {
    // Removed and re-added at another offset: a restructure, not a loss.
    expect(auditDeletions(diff('src/index.ts', '-  await init();', '+  await init();'), '')).toEqual([]);
  });

  it('ignores whitespace-only deletions', () => {
    expect(auditDeletions(diff('src/index.ts', '-', '-   '), '')).toEqual([]);
  });

  it('reports an identical dropped line once', () => {
    const merge = diff('src/index.ts', '-  close(db);', '-  close(db);');
    expect(auditDeletions(merge, '')).toEqual([{ file: 'src/index.ts', dropped: ['  close(db);'] }]);
  });

  it('matches upstream deletions per file, not across files', () => {
    // The same text deleted from a different file upstream explains nothing.
    const merge = diff('src/index.ts', '-  injectSecrets(env);');
    const upstream = diff('src/other.ts', '-  injectSecrets(env);');
    expect(auditDeletions(merge, upstream)).toEqual([{ file: 'src/index.ts', dropped: ['  injectSecrets(env);'] }]);
  });

  it('omits files with nothing to report', () => {
    const merge = [diff('src/a.ts', '+added only'), diff('src/b.ts', '-  gone();')].join('\n');
    expect(auditDeletions(merge, '')).toEqual([{ file: 'src/b.ts', dropped: ['  gone();'] }]);
  });

  it('returns nothing when the merge changed nothing', () => {
    expect(auditDeletions('', '')).toEqual([]);
  });
});
