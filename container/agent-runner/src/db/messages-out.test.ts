import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, getInboundDb, getOutboundDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';
import { getMessageIdBySeq, stripAgentGroupSuffix } from './messages-out.js';

const GROUP = 'ag-1111111111111-aaaaaa';

/** An inbound row as the host writes it: platform id namespaced by agent group. */
function seedInbound(id: string, seq: number): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, content)
       VALUES (?, ?, 'chat', ?, '{}')`,
    )
    .run(id, seq, new Date().toISOString());
}

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

describe('stripAgentGroupSuffix', () => {
  it('removes the agent-group suffix the host appended', () => {
    expect(stripAgentGroupSuffix(`1234567890.123456:${GROUP}`, GROUP)).toBe('1234567890.123456');
  });

  it('keeps colons that belong to the platform id itself', () => {
    // Telegram ids are "<chatId>:<messageId>". Cutting at the first colon would
    // hand the platform half an id; only the suffix the host added comes off.
    expect(stripAgentGroupSuffix(`6037840640:42:${GROUP}`, GROUP)).toBe('6037840640:42');
  });

  it('leaves an id that carries no suffix alone', () => {
    expect(stripAgentGroupSuffix('6037840640:42', GROUP)).toBe('6037840640:42');
  });

  it('leaves an id suffixed with a different group alone', () => {
    const other = 'ag-2222222222222-bbbbbb';
    expect(stripAgentGroupSuffix(`1234567890.123456:${other}`, GROUP)).toBe(`1234567890.123456:${other}`);
  });

  it('does nothing when the group id is unknown, rather than guessing', () => {
    expect(stripAgentGroupSuffix(`1234567890.123456:${GROUP}`, '')).toBe(`1234567890.123456:${GROUP}`);
  });

  it('only strips at the end — a group id appearing mid-id is left in place', () => {
    expect(stripAgentGroupSuffix(`${GROUP}:1234567890.123456`, GROUP)).toBe(`${GROUP}:1234567890.123456`);
  });
});

describe('getMessageIdBySeq — inbound', () => {
  it('returns the bare platform id, not the namespaced row id', () => {
    // The row id is unique per agent group so fan-out cannot collide; the
    // platform has never seen that composite and answers message_not_found.
    seedInbound(`1234567890.123456:${GROUP}`, 2);

    expect(getMessageIdBySeq(2, GROUP)).toBe('1234567890.123456');
  });

  it('returns the id unchanged when it carries no suffix', () => {
    seedInbound('1234567890.123456', 4);

    expect(getMessageIdBySeq(4, GROUP)).toBe('1234567890.123456');
  });
});

describe('getMessageIdBySeq — outbound', () => {
  it('still resolves through the delivered table', () => {
    // Outbound ids were never namespaced: the host records the real platform id
    // on delivery. Guard that the inbound fix leaves this path alone.
    getOutboundDb()
      .prepare(
        `INSERT INTO messages_out (id, seq, timestamp, kind, content)
         VALUES ('msg-out-1', 3, ?, 'chat', '{}')`,
      )
      .run(new Date().toISOString());
    getInboundDb()
      .prepare(
        `INSERT INTO delivered (message_out_id, platform_message_id, delivered_at)
         VALUES ('msg-out-1', '9999999999.000001', ?)`,
      )
      .run(new Date().toISOString());

    expect(getMessageIdBySeq(3, GROUP)).toBe('9999999999.000001');
  });

  it('returns null for a seq that matches nothing', () => {
    expect(getMessageIdBySeq(99, GROUP)).toBeNull();
  });
});
