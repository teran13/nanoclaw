import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

// An MCP server that fails to spawn or connect is reported by the SDK in the
// init message and was then thrown away: the turn ran on whatever tools DID
// come up, and the model — asked to use a tool that no longer existed —
// answered as if it had (#2968). A capability loss the operator can't see is
// worse than a loud failure, so init must say which servers are missing.

const sdkMessages: unknown[] = [];

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: () =>
    (async function* () {
      for (const m of sdkMessages) yield m;
    })(),
}));

const { ClaudeProvider, unconnectedMcpServers } = await import('./claude.js');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');

describe('unconnectedMcpServers', () => {
  it('reports nothing when every server connected', () => {
    expect(
      unconnectedMcpServers([
        { name: 'nanoclaw', status: 'connected' },
        { name: 'rss', status: 'connected' },
      ]),
    ).toEqual([]);
  });

  it('reports a failed server', () => {
    expect(unconnectedMcpServers([{ name: 'rss', status: 'failed' }])).toEqual([{ name: 'rss', status: 'failed' }]);
  });

  it('keeps only the unconnected ones, in the order the SDK listed them', () => {
    expect(
      unconnectedMcpServers([
        { name: 'nanoclaw', status: 'connected' },
        { name: 'rss', status: 'failed' },
        { name: 'notion', status: 'connected' },
        { name: 'drive', status: 'needs-auth' },
      ]),
    ).toEqual([
      { name: 'rss', status: 'failed' },
      { name: 'drive', status: 'needs-auth' },
    ]);
  });

  // `status` is a bare string in the SDK types, so anything that isn't
  // 'connected' counts as missing — a status we've never seen must not be
  // optimistically read as healthy.
  it('treats an unrecognized status as unconnected', () => {
    expect(unconnectedMcpServers([{ name: 'rss', status: 'quiesced' }])).toEqual([
      { name: 'rss', status: 'quiesced' },
    ]);
  });

  it('ignores case and surrounding space on the status', () => {
    expect(unconnectedMcpServers([{ name: 'rss', status: ' Connected ' }])).toEqual([]);
  });

  it('names a missing status rather than dropping the entry', () => {
    expect(unconnectedMcpServers([{ name: 'rss' }])).toEqual([{ name: 'rss', status: 'unknown' }]);
  });

  it('labels a nameless entry rather than dropping it', () => {
    expect(unconnectedMcpServers([{ status: 'failed' }])).toEqual([{ name: '(unnamed)', status: 'failed' }]);
  });

  it('returns nothing for an absent, non-array or non-object payload', () => {
    expect(unconnectedMcpServers(undefined)).toEqual([]);
    expect(unconnectedMcpServers(null)).toEqual([]);
    expect(unconnectedMcpServers({ rss: 'failed' })).toEqual([]);
    expect(unconnectedMcpServers([null, 'rss', 7])).toEqual([]);
  });

  it('returns nothing for an empty list', () => {
    expect(unconnectedMcpServers([])).toEqual([]);
  });
});

describe('init MCP status logging', () => {
  let tmp: string;
  let prevHome: string | undefined;
  let errs: string[];
  let realError: typeof console.error;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-mcp-status-'));
    prevHome = process.env.HOME;
    process.env.HOME = tmp;
    errs = [];
    realError = console.error;
    console.error = (...args: unknown[]) => {
      errs.push(args.map(String).join(' '));
    };
  });

  afterEach(() => {
    console.error = realError;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function drain(messages: unknown[]): Promise<string[]> {
    sdkMessages.length = 0;
    sdkMessages.push(...messages);
    const provider = new ClaudeProvider({});
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    const q = provider.query({ prompt: 'hi', cwd: tmp });
    const events: { type: string }[] = [];
    for await (const e of q.events) events.push(e as { type: string });
    return events.map((e) => e.type);
  }

  it('names each unconnected server and its status', async () => {
    await drain([
      {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-1',
        mcp_servers: [
          { name: 'nanoclaw', status: 'connected' },
          { name: 'rss', status: 'failed' },
          { name: 'drive', status: 'needs-auth' },
        ],
      },
      { type: 'result', subtype: 'success', result: '<message to="user">hi</message>' },
    ]);

    const line = errs.find((e) => e.includes('MCP server'));
    expect(line).toBeDefined();
    expect(line).toContain('rss (failed)');
    expect(line).toContain('drive (needs-auth)');
    // The healthy one is not an incident.
    expect(line).not.toContain('nanoclaw');
  });

  it('says nothing when every server connected', async () => {
    await drain([
      {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-1',
        mcp_servers: [{ name: 'nanoclaw', status: 'connected' }],
      },
      { type: 'result', subtype: 'success', result: '<message to="user">hi</message>' },
    ]);

    expect(errs.some((e) => e.includes('MCP server'))).toBe(false);
  });

  // A missing-tools warning must not become a missing-turn: the init event
  // still carries the continuation id, and the turn still runs.
  it('still yields init and the turn result', async () => {
    const types = await drain([
      {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-1',
        mcp_servers: [{ name: 'rss', status: 'failed' }],
      },
      { type: 'result', subtype: 'success', result: '<message to="user">hi</message>' },
    ]);

    expect(types).toContain('init');
    expect(types).toContain('result');
  });
});
