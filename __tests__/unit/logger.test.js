let mockLogtailInstance;
let mockLogtailCtor;

function createMocks() {
  mockLogtailInstance = {
    info: jest.fn().mockResolvedValue(),
    warn: jest.fn().mockResolvedValue(),
    error: jest.fn().mockResolvedValue(),
    flush: jest.fn().mockResolvedValue(),
  };
  mockLogtailCtor = jest.fn(() => mockLogtailInstance);
}

createMocks();

jest.mock('@logtail/node', () => ({ Logtail: mockLogtailCtor }));

describe('logger', () => {
  let logger;

  beforeAll(() => {
    delete process.env.LOGTAIL_TOKEN;
  });

  beforeEach(() => {
    jest.resetModules();
    createMocks();
    process.env.LOGTAIL_TOKEN = '';
    logger = require('../../utils/logger');
  });

  describe('info', () => {
    it('falls back to console.log when no token', () => {
      const spy = jest.spyOn(console, 'log').mockImplementation();
      logger.info('test message', { key: 'val' });
      expect(spy).toHaveBeenCalledWith('test message', { key: 'val' });
      spy.mockRestore();
    });
  });

  describe('warn', () => {
    it('falls back to console.warn when no token', () => {
      const spy = jest.spyOn(console, 'warn').mockImplementation();
      logger.warn('warn message', { severity: 'low' });
      expect(spy).toHaveBeenCalledWith('warn message', { severity: 'low' });
      spy.mockRestore();
    });
  });

  describe('error', () => {
    it('falls back to console.error when no token', () => {
      const spy = jest.spyOn(console, 'error').mockImplementation();
      logger.error('error message', { code: 500 });
      expect(spy).toHaveBeenCalledWith('error message', { code: 500 });
      spy.mockRestore();
    });
  });

  describe('httpLog', () => {
    it('falls back to console.log with formatted message', () => {
      const spy = jest.spyOn(console, 'log').mockImplementation();
      logger.httpLog('GET', '/api', 200, 150);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('GET /api 200 150ms'));
      spy.mockRestore();
    });
  });

  describe('flush', () => {
    it('resolves without error when no token', async () => {
      await expect(logger.flush()).resolves.not.toThrow();
    });
  });

  describe('when LOGTAIL_TOKEN is set', () => {
    beforeEach(() => {
      jest.resetModules();
      createMocks();
      process.env.LOGTAIL_TOKEN = 'test-token';
      logger = require('../../utils/logger');
    });

    afterEach(() => {
      delete process.env.LOGTAIL_TOKEN;
    });

    it('creates Logtail with token', () => {
      const { Logtail } = require('@logtail/node');
      expect(Logtail).toHaveBeenCalledWith('test-token', expect.any(Object));
    });

    it('calls logtail.info', () => {
      logger.info('test');
      expect(mockLogtailInstance.info).toHaveBeenCalledWith('test', undefined);
    });
  });
});
