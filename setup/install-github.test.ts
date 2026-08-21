import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The script copies the adapter out of the channels branch, so the tests give
 * it a real local origin to fetch from — a path remote, so nothing leaves the
 * machine — and stub pnpm, whose install/build steps are not what is under
 * test. The script derives its project root from its own location, so it is
 * copied into the throwaway tree rather than run from this checkout.
 */
const SCRIPT = 'install-github.sh';
const ADAPTER = 'src/channels/github.ts';
const CONTENT = 'export const github = true;\n';

describe('install-github.sh copy step', () => {
  let origin: string;
  let root: string;
  let bin: string;

  // -c rather than `git config`: the repos are throwaway, and identity must not
  // depend on whatever the ambient user config happens to be.
  const git = (cwd: string, args: string) =>
    execSync(`git -c user.email=t@example.invalid -c user.name=Test ${args}`, { cwd, stdio: 'ignore' });

  const seedOrigin = (withAdapter: boolean) => {
    git(origin, 'init -q -b channels');
    fs.mkdirSync(path.join(origin, 'src/channels'), { recursive: true });
    // something has to be on the branch for the commit to exist; the adapter
    // itself is what varies between the two cases
    fs.writeFileSync(path.join(origin, 'src/channels/other.ts'), '');
    if (withAdapter) fs.writeFileSync(path.join(origin, ADAPTER), CONTENT);
    git(origin, 'add -A');
    git(origin, 'commit -qm seed');
  };

  const run = () =>
    spawnSync('bash', [path.join('setup', SCRIPT)], {
      cwd: root,
      encoding: 'utf8',
      env: { HOME: root, PATH: `${bin}:/usr/bin:/bin` },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20_000,
    });

  beforeEach(() => {
    origin = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-gh-origin-'));
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-gh-root-'));
    bin = path.join(root, 'stub-bin');

    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'pnpm'), '#!/usr/bin/env bash\nexit 0\n');
    fs.chmodSync(path.join(bin, 'pnpm'), 0o755);

    fs.mkdirSync(path.join(root, 'setup'), { recursive: true });
    // the script derives its project root as its own parent directory
    fs.copyFileSync(path.join(process.cwd(), 'setup', SCRIPT), path.join(root, 'setup', SCRIPT));
    fs.mkdirSync(path.join(root, 'src/channels'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/channels/index.ts'), '');
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"scratch"}');

    git(root, 'init -q');
    git(root, `remote add origin ${origin}`);
  });

  afterEach(() => {
    fs.rmSync(origin, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('leaves no 0-byte adapter behind when the branch does not carry the file', () => {
    seedOrigin(false);

    const result = run();

    expect(result.status).not.toBe(0);
    // a stub here is worse than the failure: the file-present check at the top
    // of the script reads it as an installed adapter on the next run
    expect(fs.existsSync(path.join(root, ADAPTER))).toBe(false);
    expect(fs.readdirSync(path.join(root, 'src/channels'))).toEqual(['index.ts']);
  });

  it('writes the branch content and leaves no temp file on success', () => {
    seedOrigin(true);

    const result = run();

    expect(result.stdout).toContain('STATUS: installed');
    expect(fs.readFileSync(path.join(root, ADAPTER), 'utf8')).toBe(CONTENT);
    expect(fs.readdirSync(path.join(root, 'src/channels')).sort()).toEqual(['github.ts', 'index.ts']);
  });
});
