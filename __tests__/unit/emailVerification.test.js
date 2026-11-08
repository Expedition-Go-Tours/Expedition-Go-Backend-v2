/**
 * Email verification.
 *
 * The account email is the identity the guest-claim flow trusts, so these
 * tests pin the gate: a 24-hour signed link bound to the current address,
 * idempotent confirmation, and no second email for an account that is already
 * verified.
 */
jest.mock('../../src/core/services/prismaClient', () => ({
  user: { findUnique: jest.fn(), update: jest.fn() },
}));
jest.mock('../../src/core/services/emailService', () => ({
  sendEmail: jest.fn(() => Promise.resolve({ success: true })),
}));

const prisma = require('../../src/core/services/prismaClient');
const { sendEmail } = require('../../src/core/services/emailService');
const { signEmailVerifyToken, signPasswordResetToken } = require('../../config/jwt');
const {
  sendVerificationEmail,
  confirmEmailVerificationToken,
  brandForOrigin,
} = require('../../src/core/services/emailVerification');

const user = {
  id: 'u1',
  email: 'ada@example.com',
  name: 'Ada Mensah',
  emailVerified: false,
};

describe('email verification', () => {
  beforeEach(() => jest.clearAllMocks());

  it('brands the link from the storefront that asked', () => {
    expect(brandForOrigin('https://www.travioghana.com')).toBe('ghana');
    expect(brandForOrigin('https://www.expeditiongotours.com')).toBe('expedition');
    expect(brandForOrigin('https://travioafrica.com')).toBe('africa');
    expect(brandForOrigin('not a url')).toBe('ghana');
  });

  it('sends the verify-email template with a 24-hour token', async () => {
    const result = await sendVerificationEmail(user, 'https://www.travioghana.com');

    expect(result).toEqual({ sent: true });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const payload = sendEmail.mock.calls[0][0];
    expect(payload.to).toBe('ada@example.com');
    expect(payload.template).toBe('verify-email');
    expect(payload.opts.brandKey).toBe('ghana');
    expect(payload.data.customerName).toBe('Ada Mensah');
    expect(payload.data.verifyUrl).toMatch(
      /^https:\/\/www\.travioghana\.com\/verify-email\?token=/,
    );
  });

  it('does not mail an account that is already verified', async () => {
    const result = await sendVerificationEmail({ ...user, emailVerified: true }, 'https://www.travioghana.com');

    expect(result).toEqual({ alreadyVerified: true });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('confirms a valid token and records the timestamp', async () => {
    prisma.user.findUnique.mockResolvedValue(user);
    prisma.user.update.mockResolvedValue({ id: 'u1', email: 'ada@example.com', emailVerified: true });

    const token = signEmailVerifyToken({ userId: 'u1', email: 'ada@example.com' });
    const result = await confirmEmailVerificationToken(token);

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { emailVerified: true, emailVerifiedAt: expect.any(Date) },
      select: { id: true, email: true, emailVerified: true },
    });
    expect(result.alreadyVerified).toBe(false);
    expect(result.user.emailVerified).toBe(true);
  });

  it('is idempotent for an already-verified account', async () => {
    prisma.user.findUnique.mockResolvedValue({ ...user, emailVerified: true });

    const token = signEmailVerifyToken({ userId: 'u1', email: 'ada@example.com' });
    const result = await confirmEmailVerificationToken(token);

    expect(result.alreadyVerified).toBe(true);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('refuses a link sent to an address the account no longer uses', async () => {
    prisma.user.findUnique.mockResolvedValue(user);

    const token = signEmailVerifyToken({ userId: 'u1', email: 'old@example.com' });

    await expect(confirmEmailVerificationToken(token)).rejects.toMatchObject({
      statusCode: 400,
      errorCode: 'EMAIL_VERIFY_EMAIL_CHANGED',
    });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('rejects a token minted for another purpose', async () => {
    await expect(
      confirmEmailVerificationToken(signPasswordResetToken({ userId: 'u1' })),
    ).rejects.toMatchObject({ statusCode: 400, errorCode: 'EMAIL_VERIFY_INVALID' });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a malformed token without touching the database', async () => {
    await expect(confirmEmailVerificationToken('not-a-token')).rejects.toMatchObject({
      statusCode: 400,
      errorCode: 'EMAIL_VERIFY_INVALID',
    });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });
});
