/**
 * Container-side logging.
 *
 * Everything the runner writes to stderr is read by the host's container
 * process handler, which until now sent every line to `log.debug` — below the
 * default `info` threshold, so it went nowhere. A container that printed a
 * fatal error but kept running was invisible to the operator.
 *
 * The fix is a contract rather than host-side guesswork: each line carries its
 * own severity, `[tag] LEVEL message`, and the host promotes WARN and ERROR
 * into its own log. Sniffing the text for "error" was the alternative and it
 * is not safe — the container's stderr also carries output from child
 * processes (the provider CLI and friends), so arbitrary agent-adjacent text
 * would end up in the operator's error log.
 *
 * Levels mirror the host's `src/log.ts`. There is no threshold here: the
 * container writes everything and the host decides what to keep, so a level
 * is a claim about severity, not about whether the line is worth emitting.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/**
 * Render one log line — exported for the host-side parser's tests to build
 * fixtures against the real producer rather than a hand-copied string.
 *
 * Multi-line messages get the prefix on every line: the host splits stderr on
 * newlines, so an unmarked continuation line would silently fall back to
 * debug and a stack trace would lose everything after its first line.
 */
export function formatLogLines(tag: string, level: LogLevel, msg: string): string[] {
  const prefix = `[${tag}] ${level.toUpperCase()}`;
  return String(msg)
    .split('\n')
    .map((line) => `${prefix} ${line}`);
}

export function createLogger(tag: string): Logger {
  const write = (level: LogLevel, msg: string): void => {
    for (const line of formatLogLines(tag, level, msg)) console.error(line);
  };
  return {
    debug: (msg: string) => write('debug', msg),
    info: (msg: string) => write('info', msg),
    warn: (msg: string) => write('warn', msg),
    error: (msg: string) => write('error', msg),
  };
}
