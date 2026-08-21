import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The script is interactive by design (it breaks out to a PTY for
 * `claude setup-token`), so these tests only exercise what happens before the
 * first prompt: the CLI guards. A non-login or headless shell — the systemd
 * unit, a `ssh host 'bash …'`, a container `RUN` — starts with no
 * ~/.local/bin on PATH, which is exactly where setup installs onecli and the
 * Claude CLI. Guards that run before PATH is repaired call an installed CLI
 * missing and abort a setup that had everything it needed.
 *
 * Stubs stand in for all three binaries the script looks for, so no test here
 * runs a real onecli, a real claude, or a real PTY capture.
 */
const SCRIPT = path.join(process.cwd(), 'setup/register-claude-token.sh');
const PROMPT_COPY = 'sign in with your Claude account';

describe('register-claude-token.sh CLI guards', () => {
  let home: string;

  const stub = (name: string, body = 'exit 0') => {
    const file = path.join(home, '.local/bin', name);
    fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
    fs.chmodSync(file, 0o755);
  };

  // PATH deliberately omits ~/.local/bin: that is the environment under test,
  // not an artifact of the harness.
  const run = () =>
    spawnSync('bash', [SCRIPT], {
      encoding: 'utf8',
      env: { HOME: home, PATH: '/usr/bin:/bin', SECRET_NAME: 'Test', HOST_PATTERN: 'example.invalid' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20_000,
    });

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-token-home-'));
    fs.mkdirSync(path.join(home, '.local/bin'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('finds an onecli that is only on ~/.local/bin', () => {
    stub('onecli');
    stub('claude');
    stub('script');

    const result = run();

    expect(result.stderr).not.toContain('onecli not found');
    // got past every guard and reached the pre-prompt copy
    expect(result.stdout).toContain(PROMPT_COPY);
  });

  it('still reports a genuinely absent onecli', () => {
    stub('claude');
    stub('script');

    const result = run();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('onecli not found');
    expect(result.stdout).not.toContain(PROMPT_COPY);
  });

  it('does not run the Claude installer when claude is only on ~/.local/bin', () => {
    stub('onecli');
    stub('claude');
    stub('script');

    const result = run();

    // install-claude.sh announces itself before it touches the network
    expect(result.stdout).not.toContain('Claude Code CLI not found');
    expect(result.stdout).toContain(PROMPT_COPY);
  });
});
