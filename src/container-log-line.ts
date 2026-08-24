/**
 * Route one line of container stderr to a host log level.
 *
 * The agent-runner marks each line it writes as `[tag] LEVEL message`
 * (container/agent-runner/src/log.ts). Without that marker every line landed
 * at `log.debug`, which the default `info` threshold drops — so a container
 * that printed a fatal error and kept running was invisible to the operator.
 *
 * Only WARN and ERROR are promoted. The container's INFO is per-poll
 * bookkeeping from every live session; forwarding it at host `info` would bury
 * the host's own log, so it stays at debug alongside DEBUG and anything
 * unmarked. Unmarked is the important default: this stream also carries output
 * from child processes the runner inherits (the provider CLI and friends), and
 * sniffing that text for the word "error" would let arbitrary agent-adjacent
 * output into the operator's error log. Only lines we produced are trusted.
 *
 * The level marker is stripped — the host prints its own — but the `[tag]`
 * stays, so the operator still sees which module spoke.
 *
 * Lives in its own module rather than beside its caller: the only consumer is
 * a session driver, and `container-runner.ts` already imports `drivers/` — so
 * defining it there would make the driver import back into a cycle.
 */
const CONTAINER_LOG_LINE = /^(\[[a-z][a-z0-9-]*\]) (DEBUG|INFO|WARN|ERROR) ([\s\S]*)$/;

export function classifyContainerLogLine(line: string): {
  level: 'debug' | 'warn' | 'error';
  message: string;
} {
  const m = CONTAINER_LOG_LINE.exec(line);
  if (!m) return { level: 'debug', message: line };
  const level = m[2] === 'WARN' ? 'warn' : m[2] === 'ERROR' ? 'error' : 'debug';
  return { level, message: `${m[1]} ${m[3]}` };
}
