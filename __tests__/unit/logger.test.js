jest.mock('@logtail/node', () => {
  const mockLogtail = {
    info: jest.fn().mockResolvedValue(),
    warn: jest.fn().mockResolvedValue(),
    error: jest.fn().mockResolvedValue(),
    flush: jest.fn().mockResolvedValue(),
  };
  return { Logtail: jest.fn(() => mockLogtail) };
});

describe('logger', () => {
  let logger;
  let origEnv;

  beforeEach(() => {
    origEnv = { ...process.env };
    jest.clearAllMocks();
    jest.resetModules();
  });

  afterEach(() => {
    process.env = origEnv;
  });

  describe('without Logtail token', () => {
    beforeEach(() => {
      delete process.env.LOGTAIL_TOKEN;
      logger = require('../../utils/logger');
    });

    it('info falls back to console.log', () => {
      const spy = jest.spyOn(console, 'log').mockImplementation();
      logger.info('test message', { key: 'val' });
      expect(spy).toHaveBeenCalledWith('test message', { key: 'val' });
      spy.mockRestore();
    });

    it('warn falls back to console.warn', () => {
      const spy = jest.spyOn(console, 'warn').mockImplementation();
      logger.warn('warning');
      expect(spy).toHaveBeenCalledWith('warning', '');
      spy.mockRestore();
    });

    it('error falls back to console.error', () => {
      const spy = jest.spyOn(console, 'error').mockImplementation();
      logger.error('err msg');
      expect(spy).toHaveBeenCalledWith('err msg', '');
      spy.mockRestore();
    });

    it('httpLog formats and logs', () => {
      const spy = jest.spyOn(console, 'log').mockImplementation();
      logger.httpLog('GET', '/api/tours', 200, 45, { ip: '127.0.0.1' });
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it('flush resolves without error', async () => {
      await expect(logger.flush()).resolves.toBeUndefined();
    });
  });

  describe('with Logtail token', () => {
    let mockLogtail;

    beforeEach(() => {
      process.env.LOGTAIL_TOKEN = 'test-token';
      logger = require('../../utils/logger');
      const { Logtail } = require('@logtail/node');
      mockLogtail = new Logtail();
    });

    it('info sends to logtail', async () => {
      await logger.info('hello', { a: 1 });
      expect(mockLogtail.info).toHaveBeenCalledWith('hello', { a: 1 });
    });

    it('warn sends to logtail', async () => {
      await logger.warn('careful');
      expect(mockLogtail.warn).toHaveBeenCalledWith('careful', undefined);
    });

    it('error sends to logtail', async () => {
      await logger.error('fail');
      expect(mockLogtail.error).toHaveBeenCalledWith('fail', undefined);
    });

    it('httpLog sends formatted message', async () => {
      await logger.httpLog('POST', '/api/bookings', 201, 120, { userId: 'u1' });
      expect(mockLogtail.info).toHaveBeenCalledWith(
        'POST /api/bookings 201 120ms',
        expect.objectContaining({ method: 'POST', url: '/api/bookings', status: 201, responseTimeMs: 120 })
      );
    });

    it('flush calls logtail.flush', async () => {
      await logger.flush();
      expect(mockLogtail.flush).toHaveBeenCalled();
    });

    it('handles logtail.info failure gracefully', async () => {
      mockLogtail.info.mockRejectedValueOnce(new Error('network'));
      const spy = jest.spyOn(console, 'warn').mockImplementation();
      await logger.info('msg');
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it('handles logtail.flush failure gracefully', async () => {
      mockLogtail.flush.mockRejectedValueOnce(new Error('flush err'));
      const spy = jest.spyOn(console, 'warn').mockImplementation();
      await logger.flush();
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
  });
});
