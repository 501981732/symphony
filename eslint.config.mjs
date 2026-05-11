// Flat ESLint config for the IssuePilot monorepo.
//
// Notes:
// - Built on the new flat config format introduced in ESLint v9.
// - typescript-eslint is consumed via the typed-recommended subset to keep
//   feedback fast in CI; once `@issuepilot/core` grows real source files
//   we will revisit "type-checked" linting.
// - Tests opt out of `@typescript-eslint/no-explicit-any` because vitest
//   fixtures occasionally need to express JSON-RPC envelopes loosely.

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import importPlugin from "eslint-plugin-import";

export default [
  {
    ignores: [
      "**/dist/**",
      "**/.next/**",
      "**/.turbo/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/*.tsbuildinfo",
      "**/next-env.d.ts",
      "elixir/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { import: importPlugin },
    rules: {
      "import/order": [
        "warn",
        {
          "newlines-between": "always",
          alphabetize: { order: "asc", caseInsensitive: true },
        },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "warn",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
    },
  },
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "import/order": "off",
    },
  },
  {
    files: ["apps/dashboard/**/*.{ts,tsx}"],
    languageOptions: {
      globals: { React: "readonly" },
    },
  },
];
