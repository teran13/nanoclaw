/**
 * What this step does when signal-cli cannot answer.
 *
 * `listAccounts` is a best-effort probe: every way it can fail — no binary,
 * junk on stdout, a non-zero exit — is deliberately swallowed into "no
 * accounts linked", because that is the safe reading when the answer is
 * merely unavailable. One failure is not like the others. signal-cli takes an
 * exclusive lock on its config file, and setup starts the NanoClaw service
 * (which runs its own `signal-cli … daemon`) before it reaches this step, so
 * the probe can block on that lock indefinitely. Read as "no accounts", a
 * held lock sends an already-linked host into a fresh `link` and a three
 * minute wait for a QR nobody needs to scan.
 *
 * So the probe is bounded, and a hit on that bound is reported as its own
 * outcome rather than folded into the empty case. Every test drives a stub
 * `signal-cli` from a temporary directory via SIGNAL_CLI_PATH: no real
 * signal-cli is invoked and no config lock is touched.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const emitted = vi.hoisted(() => [] as Array<Record<string, string | number | boolean>>);

vi.mock('./status.js', () => ({
  emitStatus: vi.fn((_step: string, fields: Record<string, string | number | boolean>) => {
    emitted.push(fields);
  }),
}));

import { CONFIG_LOCKED_ERROR, listAccounts, run, type AccountsProbe } from './signal-auth.js';

/** What the stub does when asked for `-o json listAccounts`. */
type ListBehaviour = 'locked' | 'linked' | 'empty' | 'garbage' | 'error';

const LIST_BODY: Record<ListBehaviour, string> = {
  // `exec`, so SIGTERM reaches the sleep itself: a bash parent would defer the
  // signal until its foreground child finished, and spawnSync waits for the
  // process to actually close.
  locked: 'exec sleep 3',
  linked: `echo '[{"number":"+15550100","registered":true}]'; exit 0`,
  empty: `echo '[]'; exit 0`,
  garbage: `echo 'Config file is in use by another instance'; exit 0`,
  error: 'exit 1',
};

const dirs: string[] = [];
let logPath = '';

/**
 * Install a stub signal-cli that logs every invocation. `--version` always
 * succeeds — the step's own preflight probe runs before anything under test.
 */
function stubCli(list: ListBehaviour, linkExit = 1): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-auth-'));
  dirs.push(dir);
  logPath = path.join(dir, 'argv.log');
  const cli = path.join(dir, 'signal-cli');
  fs.writeFileSync(
    cli,
    [
      '#!/usr/bin/env bash',
      `printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}`,
      'if [[ "$*" == *--version* ]]; then echo "signal-cli 0.13.4"; exit 0; fi',
      `if [[ "$*" == *listAccounts* ]]; then ${LIST_BODY[list]}; fi`,
      `if [[ "$*" == *link* ]]; then echo "signal-cli: link cancelled" >&2; exit ${linkExit}; fi`,
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  vi.stubEnv('SIGNAL_CLI_PATH', cli);
}

/** Every argv the stub was called with, one per line. */
function invocations(): string {
  try {
    return fs.readFileSync(logPath, 'utf-8');
  } catch {
    return '';
  }
}

// The step exits the process 500ms after it emits its terminal block, which
// would take the test worker with it — and the timer outlives the test that
// armed it, so the stand-in stays installed for the whole file.
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
});

afterAll(() => {
  exitSpy.mockRestore();
});

beforeEach(() => {
  emitted.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('the listAccounts probe', () => {
  it('reports a held config lock as its own outcome, within the bound', () => {
    stubCli('locked');

    const started = Date.now();
    const probe = listAccounts(200);
    const elapsed = Date.now() - started;

    expect(probe).toEqual({ ok: false, reason: 'config-locked' });
    // The bound is the point: the stub would otherwise hold the lock for 3s.
    expect(elapsed).toBeLessThan(2_000);
  });

  it('returns the linked accounts when signal-cli answers', () => {
    stubCli('linked');

    expect(listAccounts(5_000)).toEqual({ ok: true, accounts: ['+15550100'] });
  });

  it.each([
    ['output it cannot parse', 'garbage' as const],
    ['a non-zero exit', 'error' as const],
    ['an empty list', 'empty' as const],
  ])('still reads %s as no accounts linked', (_label, behaviour) => {
    stubCli(behaviour);

    expect(listAccounts(5_000)).toEqual({ ok: true, accounts: [] });
  });
});

describe('run()', () => {
  it('fails the step on a locked config instead of starting a pointless link', async () => {
    stubCli('linked');

    await run([], () => ({ ok: false, reason: 'config-locked' }));

    expect(emitted.at(-1)).toEqual({ STATUS: 'failed', ERROR: CONFIG_LOCKED_ERROR });
    // A three minute wait for a QR the operator has no reason to scan.
    expect(invocations()).not.toContain('link');
  });

  it('does not blame the link when the lock is what went quiet afterwards', async () => {
    stubCli('linked', 0);
    const answers: AccountsProbe[] = [
      { ok: true, accounts: [] },
      { ok: false, reason: 'config-locked' },
    ];

    await run([], () => answers.shift() ?? { ok: true, accounts: [] });

    // The link may well have worked; "no account registered" would send the
    // operator looking at the wrong thing.
    expect(emitted.at(-1)).toEqual({ STATUS: 'failed', ERROR: CONFIG_LOCKED_ERROR });
  });

  it('skips the link when an account is already linked', async () => {
    stubCli('linked');

    await run([]);

    expect(emitted.at(-1)).toEqual({
      STATUS: 'skipped',
      ACCOUNT: '+15550100',
      REASON: 'already-authenticated',
    });
    expect(invocations()).not.toContain('link');
  });
});
