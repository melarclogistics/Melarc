// @ts-check
import eslint from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default defineConfig(
  // The generated API client is machine output, checked for freshness rather than for style.
  globalIgnores(['**/dist/', '**/coverage/', '**/.turbo/', 'packages/api-client/src/generated/']),
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          // node:test returns promises from describe/it/test that the test runner itself awaits.
          allowForKnownSafeCalls: [
            { from: 'package', package: 'node:test', name: ['describe', 'it', 'test'] },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/api/**/*.ts'],
    rules: {
      // Nest modules and providers are classes whose behaviour lives in their decorators.
      '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }],
    },
  },
  {
    // The driver is never handed a connection string. It reads the query string too, and a `user`, `host` or
    // `port` in it replaces what was checked (audit F01). Clients are built from the settings read out of the
    // URL: postgresConnectionSettings() in the API, clientSettings() in the e2e harness.
    files: ['apps/api/**/*.ts', 'e2e/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "Property[key.name='connectionString'], Property[key.value='connectionString']",
          message:
            'Do not give the driver a connection string: it reads the query string too and lets it replace the user, host or port that were checked. Build the settings with postgresConnectionSettings(url) (API) or clientSettings(url) (e2e harness).',
        },
      ],
    },
  },
  {
    // Production React code. Test fixtures, such as a component that fails on purpose, break the purity
    // rules by design, so tests and test support are left out.
    files: ['apps/ops-web/**/*.{ts,tsx}'],
    ignores: ['**/*.test.{ts,tsx}', 'apps/ops-web/src/test-support/**'],
    extends: [reactHooks.configs.flat.recommended],
  },
  {
    // Plain JavaScript (this config file) sits outside every tsconfig, so type-aware rules cannot run on it.
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
