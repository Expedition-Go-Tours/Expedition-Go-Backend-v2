const AppError = require('../utils/appError');

describe('AppError', () => {
  test('creates error with 404 status code', () => {
    const err = new AppError('Not found', 404);
    expect(err.message).toBe('Not found');
    expect(err.statusCode).toBe(404);
    expect(err.status).toBe('fail');
    expect(err.isOperational).toBe(true);
  });

  test('creates error with 500 status code', () => {
    const err = new AppError('Server error', 500);
    expect(err.message).toBe('Server error');
    expect(err.statusCode).toBe(500);
    expect(err.status).toBe('error');
    expect(err.isOperational).toBe(true);
  });

  test('captures stack trace', () => {
    const err = new AppError('Stack test', 400);
    expect(err.stack).toBeDefined();
  });

  test('is instance of Error', () => {
    const err = new AppError('Instance test', 403);
    expect(err).toBeInstanceOf(Error);
  });
});
