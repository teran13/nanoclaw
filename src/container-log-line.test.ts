import { describe, expect, it } from 'vitest';

import { classifyContainerLogLine } from './container-log-line.js';

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
