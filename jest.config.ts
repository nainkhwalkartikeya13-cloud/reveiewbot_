import type { Config } from 'jest';

const config: Config = {
    preset: 'ts-jest/presets/default-esm',
    testEnvironment: 'node',
    roots: ['<rootDir>/tests'],
    setupFiles: ['<rootDir>/tests/setup.ts'],
    testMatch: ['**/*.test.ts'],
    extensionsToTreatAsEsm: ['.ts'],
    collectCoverageFrom: ['src/**/*.ts', '!src/index.ts', '!src/types/**'],
    coverageDirectory: 'coverage',
    coverageReporters: ['text', 'lcov'],
    clearMocks: true,
    restoreMocks: true,
    moduleNameMapper: {
        '^(\\.{1,2}/.*)\\.js$': '$1',
        '^@octokit/app$': '<rootDir>/tests/__mocks__/@octokit/app.ts',
        '^@octokit/auth-app$': '<rootDir>/tests/__mocks__/@octokit/auth-app.ts',
        '^@octokit/rest$': '<rootDir>/tests/__mocks__/@octokit/rest.ts',
    },
    transform: {
        '^.+\\.tsx?$': [
            'ts-jest',
            {
                tsconfig: 'tsconfig.test.json',
                useESM: true,
                diagnostics: {
                    ignoreCodes: [151002],
                },
            },
        ],
    },
};

export default config;
