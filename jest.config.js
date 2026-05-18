module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.js'],
  verbose: true,
  collectCoverage: true,
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov'],
  coveragePathIgnorePatterns: ['/node_modules/', '/generated/'],
  setupFiles: ['./jest.setup.js'],
  testTimeout: 30000,
  forceExit: true,
  coverageThreshold: {
    global: {
      branches: 3,
      functions: 5,
      lines: 10,
      statements: 10,
    },
  },
};
