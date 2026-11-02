/**
 * Invoice payment reminders.
 *
 * The regression this guards against: finance v3 told the SUPPLIER their
 * payment was scheduled but never told the ADMIN it was theirs to send, so an
 * invoice could sit unpaid with nobody alerted. These tests pin both the
 * generation-time alert path and the payment-date sweep, and — just as
 * important — that the sweep cannot repeat itself on its hourly cadence.
 */

jest.mock('../../src/core/services/prismaClient', () => ({
  invoice: { findMany: jest.fn(), updateMany: jest.fn() },
}));

const mockNotifyAdmin = jest.fn(() => Promise.resolve({ success: true }));
jest.mock('../../src/core/services/adminNotificationService', () => ({
  notifyAdmin: (...args) => mockNotifyAdmin(...args),
}));

const prisma = require('../../src/core/services/prismaClient');
const { remindDueInvoices } = require('../../src/core/services/invoiceService');

const invoice = (over = {}) => ({
  id: 'inv_1',
  invoiceNumber: 'INV-20261102-1',
  supplierId: 'sup_1',
  netTotal: 2918.9,
  currency: 'USD',
  status: 'INVOICED',
  paymentScheduledAt: new Date(),
  supplier: { name: 'Expedition-Go Tours LTD' },
  ...over,
});

describe('remindDueInvoices', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.invoice.updateMany.mockResolvedValue({ count: 1 });
  });

  it('does nothing when no invoice is due', async () => {
    prisma.invoice.findMany.mockResolvedValue([]);

    const result = await remindDueInvoices();

    expect(result).toEqual({ due: 0, notified: 0 });
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  it('alerts finance with the invoice number, amount and supplier', async () => {
    prisma.invoice.findMany.mockResolvedValue([invoice()]);

    const result = await remindDueInvoices();

    expect(result.notified).toBe(1);
    const call = mockNotifyAdmin.mock.calls[0][0];
    expect(call.type).toBe('PAYOUT_NEEDS_APPROVAL');
    expect(call.title).toMatch(/due today/i);
    expect(call.message).toContain('INV-20261102-1');
    expect(call.message).toContain('2918.90');
    expect(call.message).toContain('Expedition-Go Tours LTD');
    expect(call.data.invoiceIds).toEqual(['inv_1']);
    expect(call.data.supplierId).toBe('sup_1');
  });

  it('claims the reminder before sending, so the hourly run cannot repeat', async () => {
    prisma.invoice.findMany.mockResolvedValue([invoice()]);

    await remindDueInvoices();

    expect(prisma.invoice.updateMany).toHaveBeenCalledWith({
      where: { id: 'inv_1', dueReminderSentAt: null },
      data: { dueReminderSentAt: expect.any(Date) },
    });
    expect(prisma.invoice.updateMany.mock.invocationCallOrder[0])
      .toBeLessThan(mockNotifyAdmin.mock.invocationCallOrder[0]);
  });

  it('skips an invoice another worker already claimed', async () => {
    prisma.invoice.findMany.mockResolvedValue([invoice()]);
    prisma.invoice.updateMany.mockResolvedValue({ count: 0 });

    const result = await remindDueInvoices();

    expect(result.notified).toBe(0);
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  it('says "tomorrow" for an invoice due tomorrow', async () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    prisma.invoice.findMany.mockResolvedValue([invoice({ paymentScheduledAt: tomorrow })]);

    await remindDueInvoices();

    expect(mockNotifyAdmin.mock.calls[0][0].title).toMatch(/due tomorrow/i);
  });

  it('flags an approved invoice as awaiting the transfer', async () => {
    prisma.invoice.findMany.mockResolvedValue([invoice({ status: 'APPROVED' })]);

    await remindDueInvoices();

    expect(mockNotifyAdmin.mock.calls[0][0].message).toMatch(/approved, awaiting transfer/i);
  });

  it('only looks at unpaid invoices due within the next two days', async () => {
    prisma.invoice.findMany.mockResolvedValue([]);

    await remindDueInvoices();

    const where = prisma.invoice.findMany.mock.calls[0][0].where;
    expect(where.status).toEqual({ in: ['INVOICED', 'APPROVED'] });
    expect(where.dueReminderSentAt).toBeNull();
    expect(where.paymentScheduledAt.gte).toBeInstanceOf(Date);
    expect(where.paymentScheduledAt.lt.getTime())
      .toBeGreaterThan(where.paymentScheduledAt.gte.getTime());
  });
});
