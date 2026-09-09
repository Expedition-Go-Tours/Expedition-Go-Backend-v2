/**
 * Chat reply-by-email helpers — tokenisation, Svix signature verification and
 * reply-text stripping.
 */

process.env.RESEND_INBOUND_WEBHOOK_SECRET = 'test-webhook-secret';
process.env.RESEND_RECEIVING_DOMAIN = 'messages.example.com';

const crypto = require('crypto');
const chatInbound = require('../../utils/chatInbound');

describe('chatInbound tokens', () => {
  it('generates stable tokens per conversation and canonical c-<hex> form', () => {
    const a = chatInbound.tokenFor('conv-1');
    const b = chatInbound.tokenFor('conv-1');
    const c = chatInbound.tokenFor('conv-2');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^c[0-9a-f]{16}$/);
    expect(chatInbound.canonicalToken('conv-1')).toBe(`c-${a.slice(1)}`);
    expect(chatInbound.canonicalToken('conv-1')).toMatch(/^c-[0-9a-f]{16}$/);
  });

  it('builds a valid reply address and resolves it back', () => {
    const address = chatInbound.replyAddressFor('conv-1');
    expect(address).toBe(`c-${chatInbound.tokenFor('conv-1').slice(1)}@messages.example.com`);
    const tokens = chatInbound.tokensFromRecipients([address, 'other@x.com']);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].token).toBe(`c-${chatInbound.tokenFor('conv-1').slice(1)}`);
  });

  it('ignores addresses on other domains', () => {
    expect(chatInbound.tokensFromRecipients(['c-abcdef0123456789@other.com'])).toHaveLength(0);
  });
});

describe('chatInbound Svix verification', () => {
  function sign(body, id = 'msg_1', timestamp = String(Math.floor(Date.now() / 1000))) {
    const sig = crypto.createHmac('sha256', 'test-webhook-secret').update(`${id}.${timestamp}.${body}`).digest('base64');
    return { body, id, timestamp, header: `v1,${sig}` };
  }

  it('accepts a valid signature', () => {
    const { body, id, timestamp, header } = sign('{"type":"email.received"}');
    expect(() =>
      chatInbound.verifyWebhookSignature(body, {
        'svix-id': id,
        'svix-timestamp': timestamp,
        'svix-signature': header,
      })
    ).not.toThrow();
  });

  it('rejects a tampered body', () => {
    const { body, id, timestamp, header } = sign('{"type":"email.received"}');
    expect(() =>
      chatInbound.verifyWebhookSignature(`${body}x`, {
        'svix-id': id,
        'svix-timestamp': timestamp,
        'svix-signature': header,
      })
    ).toThrow(/mismatch/i);
  });

  it('rejects an expired timestamp (replay)', () => {
    const { body, id, header } = sign('{}', 'msg_1', String(Math.floor(Date.now() / 1000) - 600));
    expect(() =>
      chatInbound.verifyWebhookSignature(body, {
        'svix-id': id,
        'svix-timestamp': String(Math.floor(Date.now() / 1000) - 600),
        'svix-signature': header,
      })
    ).toThrow(/out of window/i);
  });
});

describe('chatInbound reply text stripping', () => {
  it('removes quoted history and returns the new reply', () => {
    const reply = `Sure, that works!\n\nOn Sep 9, 2026 at 10:00 AM, John wrote:\n> How about tomorrow?\n> Let me know.\n\n-- \nSent from my phone`;
    expect(chatInbound.stripReplyText(reply)).toContain('Sure, that works!');
    expect(chatInbound.stripReplyText(reply)).not.toContain('How about tomorrow?');
  });

  it('falls back to plain text extracted from HTML', () => {
    const html = '<html><body><p>Hi there</p><br><p>Happy to help</p></body></html>';
    const text = chatInbound.htmlToText(html);
    expect(text).toContain('Hi there');
    expect(text).toContain('Happy to help');
  });
});
