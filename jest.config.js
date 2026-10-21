/** API test config. Run with: npm run test:api */
module.exports = {
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.ts"],
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "tsconfig.test.json", isolatedModules: true, diagnostics: false }],
  },
  testTimeout: 60000,
  maxWorkers: 1,
  verbose: true,
};
