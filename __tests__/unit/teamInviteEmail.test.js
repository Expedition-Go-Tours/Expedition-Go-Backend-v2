/**
 * Team invite emails — rendered through the real pipeline (compiled template →
 * emailRenderer → Resend client mocked) so the template and the controller's
 * data contract cannot drift apart.
 */
const mockSend = jest.fn();

jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({ emails: { send: mockSend } })),
}));

jest.mock('../../src/core/services/prismaClient', () => ({
  user: { findUnique: jest.fn(), findFirst: jest.fn() },
  supplierProfile: { findFirst: jest.fn() },
  teamMember: { findFirst: jest.fn() },
  notification: { findMany: jest.fn() },
  supplierNotificationRecipient: { findMany: jest.fn() },
}));

jest.mock('../../src/core/services/getConfig', () => jest.fn((key, def) => Promise.resolve(def)));
jest.mock('../../src/core/services/notificationRecipientService', () => ({
  resolveRecipients: jest.fn(() => Promise.resolve({ to: [], tagsByRecipient: {} })),
}));

process.env.RESEND_API_KEY = 'test-key';

const { sendTeamInviteEmail, sendTeamInviteRevokedEmail } = require('../../src/core/services/emailService');

const INVITE_URL = 'https://supplier.travioghana.com/team/invite?token=abc123def456';

const inviteArgs = {
  to: 'secretary@example.com',
  supplierName: 'Expedition-Go Tours LTD',
  roles: ['editor', 'finance'],
  inviteUrl: INVITE_URL,
  invitedBy: 'Kwame Mensah',
  invitedByEmail: 'kwame@expeditiongotours.com',
  expiresInHours: 48,
  brandKey: 'ghana',
};

const sentPayload = () => mockSend.mock.calls[0][0];

beforeEach(() => {
  mockSend.mockReset();
  mockSend.mockResolvedValue({ data: { id: 'email-1' }, error: null });
});

describe('team invite email', () => {
  it('renders the inviter, the supplier, and every role with its capability', async () => {
    await sendTeamInviteEmail(inviteArgs);
    const { html, subject, text } = sentPayload();

    expect(subject).toContain('Kwame Mensah');
    expect(subject).toContain('Expedition-Go Tours LTD');
    expect(subject).toContain('Travio Ghana');

    // Inviter first — the human connection is what makes an invite trustworthy.
    expect(html).toContain('Kwame Mensah');
    expect(html).toContain('kwame@expeditiongotours.com');
    expect(html).toContain('KM'); // initials avatar

    expect(html).toContain('Editor');
    expect(html).toContain('Manage tours, bookings and products');
    expect(html).toContain('Finance');
    expect(html).toContain('See earnings, payouts and payout methods');

    // One button, the raw link for clients that strip it, and the security context.
    expect(html).toContain(`href="${INVITE_URL}"`);
    expect(html).toContain('expires in 48 hours');
    expect(html).toContain('secretary@example.com');
    expect(html).toContain("weren't expecting this invitation");

    expect(text).toContain(INVITE_URL);
    expect(text).toContain('Editor: Manage tours, bookings and products');
    expect(text).toContain('support@travioghana.com');
  });

  it('uses the brand identity of the inviting supplier', async () => {
    await sendTeamInviteEmail(inviteArgs);
    const ghana = sentPayload().html;

    mockSend.mockClear();
    await sendTeamInviteEmail({ ...inviteArgs, brandKey: 'africa', to: 'x@example.com' });
    const africa = sentPayload().html;

    expect(ghana).toContain('Travio Ghana');
    expect(ghana).toContain('#065F46'); // Ghana accent on avatar + CTA
    expect(africa).toContain('Travio Africa');
    expect(africa).toContain('#0E9F6E'); // Africa keeps its own accent
    expect(africa).not.toContain('#065F46');
  });

  it('renders a single-role invitation cleanly', async () => {
    await sendTeamInviteEmail({ ...inviteArgs, roles: ['support'] });
    const { html } = sentPayload();

    expect(html).toContain('Support');
    expect(html).toContain('Handle customer chat and reviews');
    expect(html).not.toContain('Finance');
  });

  it('leaves no unresolved template tokens', async () => {
    await sendTeamInviteEmail(inviteArgs);
    await sendTeamInviteRevokedEmail({ ...inviteArgs });

    for (const call of mockSend.mock.calls) {
      expect(call[0].html).not.toMatch(/\{\{[^}]+\}\}/);
    }
  });

  it('sets a preheader for the inbox preview', async () => {
    await sendTeamInviteEmail(inviteArgs);
    expect(sentPayload().html).toContain('Editor + Finance access to Expedition-Go Tours LTD');
  });
});

describe('team invite revoked email', () => {
  it('restates the revoked access and offers a way forward', async () => {
    await sendTeamInviteRevokedEmail({ ...inviteArgs });

    const { html, subject } = sentPayload();
    expect(subject).toContain('revoked');
    expect(html).toContain('cancelled');
    expect(html).toContain('Editor');
    expect(html).toContain('Finance');
    expect(html).toContain('Ask Kwame Mensah to send a new invitation');
  });
});
