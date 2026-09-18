const { requireServiceToken } = require('../../middleware/serviceToken');

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('requireServiceToken', () => {
  const ENV = 'TEST_SYNC_TOKEN';
  const original = process.env[ENV];

  afterEach(() => {
    if (original === undefined) delete process.env[ENV];
    else process.env[ENV] = original;
  });

  it('fails closed when the token is not configured', () => {
    delete process.env[ENV];
    const res = mockRes();
    const next = jest.fn();

    requireServiceToken(ENV)({ headers: {} }, res, next);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a missing or wrong bearer token', () => {
    process.env[ENV] = 'super-secret';
    const next = jest.fn();

    const resMissing = mockRes();
    requireServiceToken(ENV)({ headers: {} }, resMissing, next);
    expect(resMissing.status).toHaveBeenCalledWith(401);

    const resWrong = mockRes();
    requireServiceToken(ENV)({ headers: { authorization: 'Bearer nope' } }, resWrong, next);
    expect(resWrong.status).toHaveBeenCalledWith(401);

    expect(next).not.toHaveBeenCalled();
  });

  it('allows a matching bearer token', () => {
    process.env[ENV] = 'super-secret';
    const next = jest.fn();
    const res = mockRes();

    requireServiceToken(ENV)({ headers: { authorization: 'Bearer super-secret' } }, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});
