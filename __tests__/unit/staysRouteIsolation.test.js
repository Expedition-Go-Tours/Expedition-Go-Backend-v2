jest.mock('../../src/core/services/prismaClient', () => ({
  conversation: { findFirst: jest.fn() },
}));

const prisma = require('../../src/core/services/prismaClient');
const router = require('../../src/brands/ghana/staysRoutes');

const guard = router._assertStayConversation;

describe('Stays by-ID conversation isolation', () => {
  let req;
  let res;
  let next;

  beforeEach(() => {
    jest.clearAllMocks();
    req = { params: { id: 'c-1' }, supplierId: 'sup-1', user: { id: 'user-1' } };
    res = {};
    next = jest.fn();
  });

  it('rejects a conversation that is not on the STAYS domain', async () => {
    prisma.conversation.findFirst.mockResolvedValue(null);

    await guard(req, res, next);

    expect(prisma.conversation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'c-1',
          domain: 'STAYS',
          participants: { some: { userId: { in: ['sup-1', 'user-1'] } } },
        }),
      })
    );
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0].statusCode).toBe(404);
  });

  it('allows a STAYS conversation the supplier participates in', async () => {
    prisma.conversation.findFirst.mockResolvedValue({ id: 'c-1' });

    await guard(req, res, next);

    expect(next).toHaveBeenCalledWith();
  });
});
