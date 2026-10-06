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
        {
          // `new Pool(url)`, `new pg.Client('postgres://...')` and `drizzle(url)` hand the driver the same string
          // without the property that the selector above looks for.
          selector:
            "NewExpression:matches([callee.name=/^(Pool|Client)$/], [callee.property.name=/^(Pool|Client)$/])[arguments.0.type=/^(Literal|TemplateLiteral|BinaryExpression)$/], CallExpression[callee.name='drizzle'][arguments.0.type=/^(Literal|TemplateLiteral|BinaryExpression)$/]",
          message:
            'Do not give the driver a connection string: build the settings with postgresConnectionSettings(url) (API) or clientSettings(url) (e2e harness) and pass those.',
        },
      ],
    },
  },
  {
    // The Ops Portal reaches the API through one door, the generated client, whose send boundary adds the CSRF
    // header, refuses another origin and keeps credentials where they belong. A request made any other way skips
    // all of that, and so does an HTML string put into the page, a script built from text, or a credential kept
    // in the browser's storage (SECURITY_DESIGN.md: opaque cookie sessions, no token in storage).
    files: ['apps/ops-web/src/**/*.{ts,tsx}'],
    ignores: ['**/*.test.{ts,tsx}', 'apps/ops-web/src/test-support/**'],
    rules: {
      'no-restricted-globals': [
        'error',
        ...[
          'fetch',
          'XMLHttpRequest',
          'WebSocket',
          'EventSource',
          'localStorage',
          'sessionStorage',
          'indexedDB',
        ].map((name) => ({
          name,
          message:
            'The Ops Portal reaches the API only through the generated client (@melarc/api-client/browser), and keeps nothing in the browser storage: a session is an HttpOnly cookie.',
        })),
      ],
      'no-restricted-properties': [
        'error',
        ...['window', 'globalThis', 'self'].flatMap((object) =>
          [
            'fetch',
            'open',
            'localStorage',
            'sessionStorage',
            'indexedDB',
            'XMLHttpRequest',
            'WebSocket',
            'EventSource',
          ].map((property) => ({
            object,
            property,
            message: `${object}.${property} is not for application code: requests go through the generated client, and nothing is kept in browser storage.`,
          })),
        ),
        {
          object: 'navigator',
          property: 'sendBeacon',
          message: 'navigator.sendBeacon sends a request that skips the generated client.',
        },
        {
          object: 'document',
          property: 'write',
          message: 'document.write puts text into the page as HTML.',
        },
        {
          object: 'document',
          property: 'cookie',
          message: 'The session and CSRF cookies are read by the client and by nothing else.',
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            'axios',
            'ky',
            'superagent',
            'node-fetch',
            'cross-fetch',
            'got',
            'undici',
            'isomorphic-fetch',
          ].map((name) => ({
            name,
            message:
              'The Ops Portal reaches the API only through the generated client (@melarc/api-client/browser).',
          })),
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: 'dangerouslySetInnerHTML puts text into the page as HTML. Render text as text.',
        },
        {
          selector: 'AssignmentExpression[left.property.name=/^(innerHTML|outerHTML)$/]',
          message:
            'Assigning innerHTML or outerHTML puts text into the page as HTML. Render text as text.',
        },
        {
          selector: "CallExpression[callee.property.name='insertAdjacentHTML']",
          message: 'insertAdjacentHTML puts text into the page as HTML. Render text as text.',
        },
      ],
      'no-eval': 'error',
      'no-new-func': 'error',
      'no-script-url': 'error',
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
