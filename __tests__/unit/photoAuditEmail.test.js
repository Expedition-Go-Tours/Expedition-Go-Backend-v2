/**
 * The catalogue photo-audit email.
 *
 * Rendered through the real send pipeline (inline generator → Resend mocked) so
 * the generator and the caller cannot drift: a supplier must be able to see
 * which tour and which problem, or the email is just noise.
 */
const mockSend = jest.fn();

jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({ emails: { send: mockSend } })),
}));

jest.mock('../../src/core/services/prismaClient', () => ({
  user: { findUnique: jest.fn(), findFirst: jest.fn() },
  supplierProfile: { findFirst: jest.fn() },
  notification: { findMany: jest.fn() },
  supplierNotificationRecipient: { findMany: jest.fn() },
}));

jest.mock('../../src/core/services/getConfig', () => jest.fn((key, def) => Promise.resolve(def)));
jest.mock('../../src/core/services/notificationRecipientService', () => ({
  resolveRecipients: jest.fn(() => Promise.resolve({ to: [], tagsByRecipient: {} })),
}));

process.env.RESEND_API_KEY = 'test-key';

const { sendSupplierPhotoAuditEmail } = require('../../src/core/services/emailService');

const supplier = {
  id: 'sup-1',
  name: 'Expedition-Go Tours LTD',
  email: 'ops@example.com',
  roles: ['supplier', 'ghana'],
};

const tours = [
  {
    title: 'From Accra: Waterfalls, Aburi Gardens',
    issueCount: 3,
    portrait: 2,
    tooSmall: 1,
    soft: 0,
  },
  {
    title: 'The North Safari',
    issueCount: 1,
    portrait: 0,
    tooSmall: 0,
    soft: 1,
  },
];

const sent = () => mockSend.mock.calls[0][0];

beforeEach(() => {
  mockSend.mockReset();
  mockSend.mockResolvedValue({ id: 'email-1' });
});

describe('sendSupplierPhotoAuditEmail', () => {
  it('names the tours and the exact problem', async () => {
    await sendSupplierPhotoAuditEmail({ supplier, tours, brandKey: 'ghana' });

    expect(mockSend).toHaveBeenCalledTimes(1);
    const payload = sent();

    expect(payload.to).toBe('ops@example.com');
    expect(payload.subject).toBe('4 tour photos to replace');

    const body = payload.html;
    expect(body).toContain('From Accra: Waterfalls, Aburi Gardens');
    expect(body).toContain('The North Safari');
    // The breakdown is what the supplier acts on, not just a count.
    expect(body).toContain('2 portrait');
    expect(body).toContain('1 under 1280px');
    expect(body).toContain('under 2048px');
  });

  it('links to the supplier dashboard, not the storefront', async () => {
    await sendSupplierPhotoAuditEmail({ supplier, tours, brandKey: 'ghana' });

    expect(sent().html).toContain('https://supplier.travioghana.com/products');
  });

  it('says nothing when there is nothing to report', async () => {
    const clean = await sendSupplierPhotoAuditEmail({ supplier, tours: [] });
    expect(clean).toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('refuses to send to a supplier with no email address', async () => {
    const result = await sendSupplierPhotoAuditEmail({
      supplier: { ...supplier, email: null },
      tours,
    });
    expect(result).toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('uses the singular in the subject for a single photo', async () => {
    await sendSupplierPhotoAuditEmail({
      supplier,
      tours: [{ title: 'One Tour', issueCount: 1, portrait: 1, tooSmall: 0, soft: 0 }],
      brandKey: 'ghana',
    });
    expect(sent().subject).toBe('1 tour photo to replace');
  });
});
