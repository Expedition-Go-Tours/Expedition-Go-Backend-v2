/**
 * Admin notification field formatting. Decision notifications carry both the
 * actor id and name; Discord must show the name, not the cuid.
 */

const { formatFields } = require('../../src/core/services/adminNotificationService');

describe('admin notification decision fields', () => {
  it('shows the admin name exactly once and hides the raw id', () => {
    const fields = formatFields({
      requestId: 'req_1',
      bookingNumber: 'TRG-1',
      decision: 'APPROVED',
      decidedBy: 'cmpfl3m2y0009ik25p967hay6',
      decidedByName: 'EXP Developer',
    });

    const decided = fields.filter((field) => field.name === 'Decided By');
    expect(decided).toHaveLength(1);
    expect(decided[0].value).toBe('EXP Developer');
    expect(JSON.stringify(fields)).not.toContain('cmpfl3m2y0009ik25p967hay6');
  });

  it('falls back to the id when no name is available', () => {
    const fields = formatFields({ decidedBy: 'cmpfl3m2y0009ik25p967hay6' });

    expect(fields).toEqual([
      expect.objectContaining({ name: 'Decided By', value: 'cmpfl3m2y0009ik25p967hay6' }),
    ]);
  });
});
