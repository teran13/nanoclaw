import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { classifyContainerLogLine, hardeningArgs, resolveProviderName } from './container-runner.js';

describe('resolveProviderName', () => {
  it('prefers session over container config', () => {
    expect(resolveProviderName('codex', 'claude')).toBe('codex');
  });

  it('falls back to container config when session is null', () => {
    expect(resolveProviderName(null, 'opencode')).toBe('opencode');
  });

  it('defaults to claude when nothing is set', () => {
    expect(resolveProviderName(null, undefined)).toBe('claude');
  });

  it('lowercases the resolved name', () => {
    expect(resolveProviderName('CODEX', null)).toBe('codex');
    expect(resolveProviderName(null, 'Claude')).toBe('claude');
  });

  it('treats empty string as unset (falls through)', () => {
    expect(resolveProviderName('', 'opencode')).toBe('opencode');
    expect(resolveProviderName(null, '')).toBe('claude');
  });
});

describe('buildContainerArgs ordering invariant (structural)', () => {
  // The OneCLI gateway apply (SDK applyContainerConfig) appends credential-stub
  // mounts — e.g. the codex auth.json sentinel nested INSIDE our RW
  // /home/node/.codex mount. Docker applies binds in argument order, so the
  // stub must land AFTER its parent mount or the parent shadows it and the
  // agent silently degrades to loginless auth. Driving the real
  // buildContainerArgs needs a live gateway + container runtime, so this
  // guards the invariant structurally: the gateway apply must appear after
  // the volume-mounts loop in the source.
  it('applies the OneCLI gateway after the volume mounts', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    const mountsLoop = src.indexOf('for (const mount of mounts)');
    const gatewayApply = src.indexOf('onecli.applyContainerConfig');
    expect(mountsLoop).toBeGreaterThan(-1);
    expect(gatewayApply).toBeGreaterThan(-1);
    expect(gatewayApply).toBeGreaterThan(mountsLoop);
  });
});

describe('plugins read-only mount (structural)', () => {
  // Stamped plugin content must be immutable inside the container (Agent
  // Plugins contract: writes go to plugin-data/). Driving buildMounts needs a
  // provider registry + composed group surfaces, so guard the wiring
  // structurally: the plugins dir must be mounted at CONTAINER_PLUGINS_DIR
  // with readonly: true.
  it('mounts groups/<folder>/plugins read-only', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    const idx = src.indexOf("path.join(groupDir, 'plugins')");
    expect(idx).toBeGreaterThan(-1);
    const mountExpr = src.slice(idx, idx + 200);
    expect(mountExpr).toContain('CONTAINER_PLUGINS_DIR');
    expect(mountExpr).toContain('readonly: true');
  });
});

describe('per-container resource limits (structural)', () => {
  // CONTAINER_CPU_LIMIT / CONTAINER_MEMORY_LIMIT pass through to `docker run` as
  // --cpus / --memory, but only when set. The default is empty string → no flag →
  // today's unbounded behavior (don't OOM existing OSS workloads). Swap is not
  // managed here (a swapless host makes --memory a hard cap). buildContainerArgs
  // needs a live gateway to drive, so guard the wiring structurally: the flags
  // must be pushed, and each must be guarded by its env knob so empty emits nothing.
  it('reads both limit knobs from config', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    expect(src).toContain('CONTAINER_CPU_LIMIT');
    expect(src).toContain('CONTAINER_MEMORY_LIMIT');
  });

  it('guards --cpus behind a truthy CONTAINER_CPU_LIMIT', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    expect(src).toMatch(/if \(CONTAINER_CPU_LIMIT\)[\s\S]*?args\.push\('--cpus', CONTAINER_CPU_LIMIT\)/);
  });

  it('guards --memory behind a truthy CONTAINER_MEMORY_LIMIT (and sets no swap flag)', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    expect(src).toMatch(/if \(CONTAINER_MEMORY_LIMIT\) args\.push\('--memory', CONTAINER_MEMORY_LIMIT\)/);
    expect(src).not.toContain('--memory-swap');
  });

  it('defaults both knobs to empty string in config (no flag = unbounded)', () => {
    const cfg = fs.readFileSync(path.join(process.cwd(), 'src', 'config.ts'), 'utf-8');
    expect(cfg).toContain(
      "CONTAINER_CPU_LIMIT = process.env.CONTAINER_CPU_LIMIT || envConfig.CONTAINER_CPU_LIMIT || ''",
    );
    expect(cfg).toContain(
      "CONTAINER_MEMORY_LIMIT = process.env.CONTAINER_MEMORY_LIMIT || envConfig.CONTAINER_MEMORY_LIMIT || ''",
    );
  });
});

describe('container boot-failure tripwire (structural)', () => {
  // A container that dies at boot (unknown provider, missing CLI binary, bad
  // config) explains itself only on stderr — which logs at debug, below the
  // default level. The spawn handler must keep a stderr tail and surface it
  // at warn on a non-zero exit, or the operator sees only "exited code 1" on
  // repeat. Driving a real failing spawn needs a container runtime, so this
  // guards the wiring structurally, matching the invariant test above.
  it('surfaces the stderr tail when the container exits non-zero', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    expect(src).toContain('stderrTail.push(line)');
    expect(src).toMatch(/Container exited non-zero.*stderrTail/s);
  });
});

describe('syncSkillSymlinks blocked-entry warning (structural)', () => {
  // Real directories in .claude-shared/skills/ block the managed symlinks:
  // the prune loop only removes symlinks and the create loop skips any
  // existing entry. Template overlays depend on surviving that (see
  // src/group-skills.ts); stale pre-refactor skill copies (#3001) get served
  // forever with no trace. Driving syncSkillSymlinks needs a real group
  // filesystem, and importing more of the module pulls the provider side
  // effects, so guard the wiring structurally: the create loop must warn
  // when a non-symlink entry occupies a desired skill path.
  it('warns instead of silently skipping when a real entry blocks a desired skill', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    const createLoop = src.indexOf('// Create symlinks for desired skills');
    expect(createLoop).toBeGreaterThan(-1);
    const tail = src.slice(createLoop);
    expect(tail).toMatch(/else if \(!entry\.isSymbolicLink\(\)\)/);
    expect(tail).toMatch(/log\.warn\(\s*'Shared skill not symlinked/);
  });
});

describe('hardeningArgs', () => {
  it('always emits the three unconditional flags', () => {
    const args = hardeningArgs('2048');
    expect(args).toContain('--cap-drop=ALL');
    expect(args.join(' ')).toContain('--security-opt no-new-privileges');
    expect(args).toContain('--init');
  });

  it('emits the pids limit when positive', () => {
    expect(hardeningArgs('2048').join(' ')).toContain('--pids-limit 2048');
  });

  // cgroups v2 rejects `--pids-limit 0` with EINVAL, killing the spawn.
  it('omits the pids limit for 0, negatives, blank and garbage', () => {
    for (const v of ['0', '-1', '', '   ', 'lots']) {
      expect(hardeningArgs(v).join(' ')).not.toContain('--pids-limit');
    }
  });

  it('floors fractional values', () => {
    expect(hardeningArgs('2048.7').join(' ')).toContain('--pids-limit 2048');
  });
});

describe('classifyContainerLogLine', () => {
  // The container marks its own stderr (container/agent-runner/src/log.ts);
  // the fixtures below are the exact shape formatLogLines() produces.
  it('promotes a marked ERROR line so it reaches the error log', () => {
    expect(classifyContainerLogLine('[poll-loop] ERROR Query error: boom')).toEqual({
      level: 'error',
      message: '[poll-loop] Query error: boom',
    });
  });

  it('promotes a marked WARN line', () => {
    expect(classifyContainerLogLine('[poll-loop] WARN no <message> blocks — nothing was sent')).toEqual({
      level: 'warn',
      message: '[poll-loop] no <message> blocks — nothing was sent',
    });
  });

  // Per-poll bookkeeping from every live session. Promoting it would bury the
  // host's own log, which is the reason the marker exists at all.
  it('keeps container INFO and DEBUG at host debug', () => {
    expect(classifyContainerLogLine('[poll-loop] INFO Completed 3 message(s)').level).toBe('debug');
    expect(classifyContainerLogLine('[claude-provider] DEBUG raw event').level).toBe('debug');
  });

  // This stream also carries output from child processes the runner inherits.
  // Anything we did not mark stays where it was, verbatim.
  it('leaves unmarked lines at debug and unchanged', () => {
    for (const line of [
      'Error: connect ECONNREFUSED 127.0.0.1:443',
      'FATAL something from a child process',
      '   [poll-loop] ERROR leading whitespace is not our format',
      '[poll-loop]ERROR missing space',
      '[poll-loop] ERRORmissing space',
      '[Poll-Loop] ERROR tag is not lowercase',
      '[poll loop] ERROR tag has a space',
      '[] ERROR empty tag',
      '',
    ]) {
      expect(classifyContainerLogLine(line)).toEqual({ level: 'debug', message: line });
    }
  });

  it('does not promote a marker that appears mid-line', () => {
    // Only the start of the line is ours to trust.
    expect(classifyContainerLogLine('agent said: [poll-loop] ERROR fake').level).toBe('debug');
  });

  it('keeps an empty message body rather than dropping the line', () => {
    // A blank interior line of a multi-line error still carries the marker.
    expect(classifyContainerLogLine('[poll-loop] ERROR ')).toEqual({
      level: 'error',
      message: '[poll-loop] ',
    });
  });

  it('preserves a message that itself contains brackets and levels', () => {
    expect(classifyContainerLogLine('[mcp-tools] ERROR send_message: [WARN] in body')).toEqual({
      level: 'error',
      message: '[mcp-tools] send_message: [WARN] in body',
    });
  });
});
