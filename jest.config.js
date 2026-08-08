module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.js'],
  verbose: true,
  collectCoverage: true,
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'json-summary'],
  coveragePathIgnorePatterns: ['/node_modules/', '/generated/'],
  setupFiles: ['./jest.setup.js'],
  globalSetup: './jest.globalSetup.js',
  testTimeout: 30000,
  forceExit: true,
  coverageThreshold: {
    global: {
      branches: 45,
      functions: 50,
      lines: 60,
      statements: 60,
    },
  },
};
