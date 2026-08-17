import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { createLogger, formatLogLines } from './log.js';

// The container's stderr is the only thing the host can see from inside a
// running container, and every line of it landed at host `log.debug` — below
// the default threshold. These tests pin the severity marker the host parses,
// so a container error can reach the operator's error log.

describe('formatLogLines', () => {
  it('marks the level and tags the source module', () => {
    expect(formatLogLines('poll-loop', 'error', 'Query error: boom')).toEqual(['[poll-loop] ERROR Query error: boom']);
  });

  it('renders each level as its own uppercase marker', () => {
    expect(formatLogLines('t', 'debug', 'm')).toEqual(['[t] DEBUG m']);
    expect(formatLogLines('t', 'info', 'm')).toEqual(['[t] INFO m']);
    expect(formatLogLines('t', 'warn', 'm')).toEqual(['[t] WARN m']);
    expect(formatLogLines('t', 'error', 'm')).toEqual(['[t] ERROR m']);
  });

  it('prefixes every line of a multi-line message', () => {
    // The host splits stderr on newlines. An unmarked continuation line falls
    // back to debug, so a stack trace would lose everything below line one.
    expect(formatLogLines('claude-provider', 'error', 'Fatal:\n  at a()\n  at b()')).toEqual([
      '[claude-provider] ERROR Fatal:',
      '[claude-provider] ERROR   at a()',
      '[claude-provider] ERROR   at b()',
    ]);
  });

  it('keeps blank interior lines marked rather than dropping them', () => {
    expect(formatLogLines('t', 'warn', 'a\n\nb')).toEqual(['[t] WARN a', '[t] WARN ', '[t] WARN b']);
  });

  it('survives a non-string message rather than throwing', () => {
    // Logging is a diagnostic: it must never be the thing that fails a turn.
    expect(() => formatLogLines('t', 'info', undefined as unknown as string)).not.toThrow();
    expect(formatLogLines('t', 'info', undefined as unknown as string)).toEqual(['[t] INFO undefined']);
  });
});

describe('createLogger', () => {
  let errs: string[];
  let realError: typeof console.error;

  beforeEach(() => {
    errs = [];
    realError = console.error;
    console.error = (...args: unknown[]) => {
      errs.push(args.map(String).join(' '));
    };
  });

  afterEach(() => {
    console.error = realError;
  });

  it('writes to stderr, not stdout — stdout is unused in v2', () => {
    const log = createLogger('mcp-tools');
    log.error('nope');
    expect(errs).toEqual(['[mcp-tools] ERROR nope']);
  });

  it('tags each module separately so the host log names the source', () => {
    createLogger('poll-loop').info('Completed 3 message(s)');
    createLogger('task-script').info('running script for task t-1');
    expect(errs).toEqual(['[poll-loop] INFO Completed 3 message(s)', '[task-script] INFO running script for task t-1']);
  });

  it('emits one console.error per line of a multi-line message', () => {
    const log = createLogger('index');
    log.warn('one\ntwo');
    expect(errs).toEqual(['[index] WARN one', '[index] WARN two']);
  });

  it('exposes every level as a method', () => {
    const log = createLogger('t');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(errs).toEqual(['[t] DEBUG d', '[t] INFO i', '[t] WARN w', '[t] ERROR e']);
  });
});
