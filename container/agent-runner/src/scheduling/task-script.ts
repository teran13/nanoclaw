import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { MessageInRow } from '../db/messages-in.js';
import { touchHeartbeat } from '../db/connection.js';
import { createLogger } from '../log.js';

const SCRIPT_TIMEOUT_MS = 30_000;
const SCRIPT_MAX_BUFFER = 1024 * 1024;

export interface ScriptResult {
  wakeAgent: boolean;
  data?: unknown;
}

const log = createLogger('task-script');

export async function runScript(script: string, taskId: string): Promise<ScriptResult | null> {
  const scriptPath = path.join('/tmp', `task-script-${taskId}.sh`);
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  return new Promise((resolve) => {
    execFile(
      'bash',
      [scriptPath],
      { timeout: SCRIPT_TIMEOUT_MS, maxBuffer: SCRIPT_MAX_BUFFER, env: process.env },
      (error, stdout, stderr) => {
        try {
          fs.unlinkSync(scriptPath);
        } catch {
          /* best-effort cleanup */
        }

        if (stderr) {
          log.info(`[${taskId}] stderr: ${stderr.slice(0, 500)}`);
        }

        if (error) {
          log.warn(`[${taskId}] error: ${error.message}`);
          return resolve(null);
        }

        const lines = stdout.trim().split('\n');
        const lastLine = lines[lines.length - 1];
        if (!lastLine) {
          log.info(`[${taskId}] no output`);
          return resolve(null);
        }

        try {
          const result = JSON.parse(lastLine);
          if (typeof result.wakeAgent !== 'boolean') {
            log.info(`[${taskId}] output missing wakeAgent boolean: ${lastLine.slice(0, 200)}`);
            return resolve(null);
          }
          resolve(result as ScriptResult);
        } catch {
          log.info(`[${taskId}] output is not valid JSON: ${lastLine.slice(0, 200)}`);
          resolve(null);
        }
      },
    );
  });
}

/** Why a script gated its task: deliberate wakeAgent=false vs a broken script. */
export type ScriptSkipReason = 'gated' | 'error';

export interface TaskScriptOutcome {
  keep: MessageInRow[];
  skipped: Array<{ id: string; reason: ScriptSkipReason }>;
}

/**
 * Run pre-task scripts for any task messages that carry one, serially.
 * - Errors / missing output / wakeAgent=false → task id added to `skipped`,
 *   with the reason. The caller acks these as script-skips (not plain
 *   completions) so the host can count consecutive failures and back off.
 * - wakeAgent=true → content JSON is mutated to carry `scriptOutput`, so the
 *   formatter renders it into the prompt.
 * Non-task messages and tasks without scripts pass through unchanged.
 */
export async function applyPreTaskScripts(messages: MessageInRow[]): Promise<TaskScriptOutcome> {
  const keep: MessageInRow[] = [];
  const skipped: Array<{ id: string; reason: ScriptSkipReason }> = [];

  for (const msg of messages) {
    if (msg.kind !== 'task') {
      keep.push(msg);
      continue;
    }

    let content: Record<string, unknown>;
    try {
      content = JSON.parse(msg.content);
    } catch {
      keep.push(msg);
      continue;
    }

    const script = typeof content.script === 'string' ? (content.script as string) : null;
    if (!script) {
      keep.push(msg);
      continue;
    }

    log.info(`running script for task ${msg.id}`);
    touchHeartbeat();
    const result = await runScript(script, msg.id);
    touchHeartbeat();

    if (!result || !result.wakeAgent) {
      const reason: ScriptSkipReason = result ? 'gated' : 'error';
      // A gate saying no is the script working. A gate that failed to run
      // drops the task silently, which the operator wants to hear about.
      const line = `task ${msg.id} skipped: ${reason === 'gated' ? 'wakeAgent=false' : 'script error/no output'}`;
      if (reason === 'gated') log.info(line);
      else log.warn(line);
      skipped.push({ id: msg.id, reason });
      continue;
    }

    log.info(`task ${msg.id} wakeAgent=true, enriching prompt`);
    content.scriptOutput = result.data ?? null;
    keep.push({ ...msg, content: JSON.stringify(content) });
  }

  return { keep, skipped };
}
