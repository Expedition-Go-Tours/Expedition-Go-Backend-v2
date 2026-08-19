const {
  payoutMethodInputSchema,
  payoutMethodPatchSchema,
  verifyPayoutMethodSchema,
  ibanIsValid,
  accountNumberIsValid,
  routingNumberIsValid,
  sortCodeIsValid,
  BIC_REGEX,
} = require('../../utils/payoutMethodValidation');

describe('payoutMethodValidation helpers', () => {
  it.each([
    ['GB29 NWBK 6016 1331 9268 19', true],
    ['DE89370400440532013000', true],
    ['GB29NWBK60161331926819', true],
    ['GB29NWBK60161331926818', false], // bad check digits
    ['GB29 NWBK', false], // too short
    ['', false],
    [undefined, false],
    ['not-an-iban', false],
  ])('ibanIsValid(%j) -> %s', (iban, expected) => {
    expect(ibanIsValid(iban)).toBe(expected);
  });

  it('accountNumberIsValid accepts digits with separators but rejects short/non-digit', () => {
    expect(accountNumberIsValid('1234 5678')).toBe(true);
    expect(accountNumberIsValid('12-3456')).toBe(true);
    expect(accountNumberIsValid('1234')).toBe(false); // too short
    expect(accountNumberIsValid('abc')).toBe(false);
    expect(accountNumberIsValid('123456789012345678901234567890123')).toBe(false); // too long (>32)
  });

  it('routingNumberIsValid accepts 9 digits and rejects letters', () => {
    expect(routingNumberIsValid('021000021')).toBe(true);
    expect(routingNumberIsValid('021-000-021')).toBe(true);
    expect(routingNumberIsValid('123')).toBe(false);
    expect(routingNumberIsValid('02100002a')).toBe(false);
  });

  it('sortCodeIsValid accepts 12-34-56 and 123456', () => {
    expect(sortCodeIsValid('12-34-56')).toBe(true);
    expect(sortCodeIsValid('123456')).toBe(true);
    expect(sortCodeIsValid('12-34-5')).toBe(false);
  });

  it('BIC_REGEX validates 8- and 11-char codes', () => {
    expect(BIC_REGEX.test('DEUTDEFF')).toBe(true);
    expect(BIC_REGEX.test('CHASUS33XXX')).toBe(true);
    expect(BIC_REGEX.test('BOFAUS6S')).toBe(true);
    expect(BIC_REGEX.test('short')).toBe(false);
    expect(BIC_REGEX.test('deutdeff')).toBe(false); // lowercase rejected
  });
});

describe('payoutMethodInputSchema (POST)', () => {
  const bankPayload = {
    body: {
      type: 'BANK_TRANSFER',
      currency: 'usd',
      bankName: 'Test Bank',
      bankCountry: 'ng',
      accountName: 'Supplier',
      accountNumber: '12345678',
      branchName: 'Oxford Circus',
      branchCode: '20-33-44',
    },
  };

  it('accepts a valid BANK_TRANSFER method', () => {
    const result = payoutMethodInputSchema.safeParse(bankPayload);
    expect(result.success).toBe(true);
    expect(result.data.body.currency).toBe('USD'); // normalized to upper
    expect(result.data.body.bankCountry).toBe('NG');
  });

  it('accepts IBAN instead of account number, with country', () => {
    const result = payoutMethodInputSchema.safeParse({
      body: {
        type: 'BANK_TRANSFER',
        currency: 'EUR',
        bankName: 'Deutsche Bank',
        bankCountry: 'DE',
        iban: 'DE89 3704 0044 0532 0130 00',
      },
    });
    expect(result.success).toBe(true);
    expect(result.data.body.iban).toBe('DE89370400440532013000'); // spaces stripped
  });

  it('accepts a valid PAYPAL method', () => {
    const result = payoutMethodInputSchema.safeParse({
      body: { type: 'PAYPAL', paypalEmail: 'supplier@paypal.com' },
    });
    expect(result.success).toBe(true);
  });

  it('defaults currency to USD when omitted', () => {
    const result = payoutMethodInputSchema.safeParse({
      body: { type: 'PAYPAL', paypalEmail: 'a@b.com' },
    });
    expect(result.success).toBe(true);
    expect(result.data.body.currency).toBe('USD');
  });

  it('rejects an unsupported type', () => {
    const result = payoutMethodInputSchema.safeParse({ body: { type: 'BITCOIN' } });
    expect(result.success).toBe(false);
    expect(result.error.issues[0].path).toEqual(['body', 'type']);
  });

  it('requires account number or IBAN for BANK_TRANSFER', () => {
    const result = payoutMethodInputSchema.safeParse({
      body: { type: 'BANK_TRANSFER', accountName: 'Supplier' },
    });
    expect(result.success).toBe(false);
    expect(result.error.issues.some((i) => i.path.join('.') === 'body.accountNumber')).toBe(true);
    expect(result.error.issues[0].message).toMatch(/account number/i);
  });

  it('requires paypalEmail for PAYPAL', () => {
    const result = payoutMethodInputSchema.safeParse({ body: { type: 'PAYPAL' } });
    expect(result.success).toBe(false);
    expect(result.error.issues.some((i) => i.path.join('.') === 'body.paypalEmail')).toBe(true);
  });

  it('rejects an invalid IBAN (bad mod-97)', () => {
    const result = payoutMethodInputSchema.safeParse({
      body: {
        type: 'BANK_TRANSFER',
        currency: 'EUR',
        bankCountry: 'DE',
        iban: 'DE89 3704 0044 0532 0130 01',
      },
    });
    expect(result.success).toBe(false);
    expect(result.error.issues[0].message).toMatch(/invalid IBAN/i);
  });

  it('rejects an invalid SWIFT/BIC code', () => {
    const result = payoutMethodInputSchema.safeParse({
      body: { type: 'BANK_TRANSFER', accountName: 'S', accountNumber: '123456', swiftCode: 'NOT-A-BIC' },
    });
    expect(result.success).toBe(false);
    expect(result.error.issues[0].message).toMatch(/SWIFT\/BIC/i);
  });

  it('rejects account number shorter than 6 digits', () => {
    const result = payoutMethodInputSchema.safeParse({
      body: { type: 'BANK_TRANSFER', accountName: 'S', accountNumber: '1234' },
    });
    expect(result.success).toBe(false);
    expect(result.error.issues[0].message).toMatch(/6–32 digits/i);
  });

  it('requires bankCountry when IBAN is supplied', () => {
    const result = payoutMethodInputSchema.safeParse({
      body: { type: 'BANK_TRANSFER', iban: 'GB29NWBK60161331926819' },
    });
    expect(result.success).toBe(false);
    expect(result.error.issues.some((i) => i.path.join('.') === 'body.bankCountry')).toBe(true);
  });

  it('requires accountName when accountNumber is supplied', () => {
    const result = payoutMethodInputSchema.safeParse({
      body: { type: 'BANK_TRANSFER', accountNumber: '12345678' },
    });
    expect(result.success).toBe(false);
    expect(result.error.issues.some((i) => i.path.join('.') === 'body.accountName')).toBe(true);
  });

  it('rejects an invalid PayPal email', () => {
    const result = payoutMethodInputSchema.safeParse({
      body: { type: 'PAYPAL', paypalEmail: 'not-an-email' },
    });
    expect(result.success).toBe(false);
    expect(result.error.issues[0].message).toMatch(/PayPal email/i);
  });

  it('rejects a malformed country code', () => {
    const result = payoutMethodInputSchema.safeParse({
      body: { type: 'BANK_TRANSFER', accountName: 'S', accountNumber: '12345678', bankCountry: 'worldwide' },
    });
    expect(result.success).toBe(false);
    expect(result.error.issues[0].message).toMatch(/2-letter ISO/i);
  });

  it('collapses whitespace-only strings to undefined (ignored by controller spread)', () => {
    const result = payoutMethodInputSchema.safeParse({
      body: { type: 'BANK_TRANSFER', accountName: 'S', accountNumber: '12345678', branchName: '   ' },
    });
    expect(result.success).toBe(true);
    expect(result.data.body.branchName).toBeUndefined();
  });
});

describe('payoutMethodPatchSchema (PATCH)', () => {
  it('accepts a partial bank update with valid formats', () => {
    const result = payoutMethodPatchSchema.safeParse({
      params: { id: 'pm-1' },
      body: { accountNumber: '1234 5678', swiftCode: 'DEUTDEFF' },
    });
    expect(result.success).toBe(true);
    expect(result.data.body.accountNumber).toBe('1234 5678');
  });

  it('rejects an invalid IBAN on partial update', () => {
    const result = payoutMethodPatchSchema.safeParse({
      params: { id: 'pm-1' },
      body: { iban: 'DENOTANIBAN' },
    });
    expect(result.success).toBe(false);
    expect(result.error.issues[0].message).toMatch(/invalid IBAN/i);
  });

  it('rejects changing the payout method type', () => {
    const result = payoutMethodPatchSchema.safeParse({
      params: { id: 'pm-1' },
      body: { type: 'PAYPAL' },
    });
    expect(result.success).toBe(false);
    expect(result.error.issues[0].path.join('.')).toBe('body.type');
    expect(result.error.issues[0].message).toMatch(/cannot be changed/i);
  });

  it('requires a valid id param', () => {
    const result = payoutMethodPatchSchema.safeParse({ params: {}, body: {} });
    expect(result.success).toBe(false);
  });
});

describe('verifyPayoutMethodSchema (admin verify)', () => {
  it('defaults verified to true when omitted', () => {
    const result = verifyPayoutMethodSchema.safeParse({ params: { id: 'pm-1' }, body: {} });;
    expect(result.success).toBe(true);
    expect(result.data.body.verified).toBe(true);
  });

  it('accepts an explicit verified boolean', () => {
    const result = verifyPayoutMethodSchema.safeParse({ params: { id: 'pm-1' }, body: { verified: false } });
    expect(result.success).toBe(true);
    expect(result.data.body.verified).toBe(false);
  });

  it('rejects a non-boolean verified value', () => {
    const result = verifyPayoutMethodSchema.safeParse({
      params: { id: 'pm-1' },
      body: { verified: 'yes' },
    });
    expect(result.success).toBe(false);
  });
});
