/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  testMatch: ['**/src/__tests__/**/*.test.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@floors/shared-server$': '<rootDir>/../../packages/shared-server/dist/index.js',
    '^@floors/types$': '<rootDir>/../../packages/types/dist/index.js',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      useESM: true,
      diagnostics: false,
    }],
    // Transform ESM-only node_modules
    '\\.js$': ['ts-jest', {
      useESM: true,
      diagnostics: false,
    }],
  },
  transformIgnorePatterns: [],
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
};
