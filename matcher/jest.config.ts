/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
  preset: "ts-jest/presets/default-esm",
  testEnvironment: "node",
  moduleNameMapper: { "^(\\.{1,2}/.*)\\.js$": "$1" },
  extensionsToTreatAsEsm: [".ts"],
  testPathIgnorePatterns: ["/dist/", "/node_modules/"],
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: { module: "nodenext", moduleResolution: "nodenext", target: "es2022", esModuleInterop: true }, diagnostics: false }]
  },
};
