// @ts-check
import eslint from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

// What the Ops Portal's application code may not import. The API client is the one door to the API, the icon registry (and the shadcn/ui
// primitives, which are generated source that imports its icons) the door to the icon library, `components/ui/` the one door to React Aria
// Components and the date library it uses, and `components/primitives/` the one door to Radix UI and the libraries beside it (DESIGN_SYSTEM
// section 24a).
const API_RESTRICTED_PATHS = [
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
}));

const ICON_RESTRICTED_PATH = {
  name: 'lucide-react',
  message:
    'Icons come from the one registry of the design system (components/ui/icon/icons.ts): name an icon by its meaning with <Icon name=... />.',
};
const OPS_RESTRICTED_PATHS = [...API_RESTRICTED_PATHS, ICON_RESTRICTED_PATH];

// Radix UI and the libraries beside it under the shadcn/ui primitives: imported by `components/primitives/` and nowhere else. And a primitive is
// imported by the components of `components/ui/` (and the dev-only showcase) and by nothing else: a page uses the Melarc component.
const PRIMITIVE_LIBRARIES_MESSAGE =
  'Radix UI, cmdk, vaul, sonner and react-day-picker are imported by components/primitives only (DESIGN_SYSTEM section 24a): use a component of components/ui, or add the primitive from the official shadcn registry into components/primitives and compose it in components/ui.';
const PRIMITIVE_LIBRARY_PATHS = ['radix-ui', 'cmdk', 'vaul', 'sonner', 'react-day-picker'].map(
  (name) => ({ name, message: PRIMITIVE_LIBRARIES_MESSAGE }),
);
const PRIMITIVE_LIBRARY_PATTERNS = [
  {
    group: ['radix-ui/*', '@radix-ui/*', 'cmdk/*', 'vaul/*', 'sonner/*', 'react-day-picker/*'],
    message: PRIMITIVE_LIBRARIES_MESSAGE,
  },
];
const PRIMITIVE_FILES_PATTERNS = [
  {
    group: [
      '**/components/primitives',
      '**/components/primitives/*',
      '@/components/primitives',
      '@/components/primitives/*',
      '**/primitives/*',
    ],
    message:
      'A primitive (components/primitives) is generated source over Radix UI: the components of components/ui import it, and the dev-only showcase. A page uses the Melarc component, never the primitive (DESIGN_SYSTEM section 24a).',
  },
];

const ARIA_MESSAGE =
  'Behaviour a native element does not give (a calendar, a menu, a combobox) comes from React Aria Components through the components of components/ui only (DESIGN_SYSTEM section 24a): use or add a component there, and take a date as text from <DatePicker>.';
const ARIA_PATHS = ['react-aria-components', 'react-aria', 'react-stately'].map((name) => ({
  name,
  message: ARIA_MESSAGE,
}));
// The packages that only the components of the design system (and the icon registry, for lucide-react) may name, by any way of naming them.
// (A slash cannot be written inside the selector's regular expression, so it is written as its code.)
const DOOR_PACKAGES =
  '^(react-aria-components|react-aria|react-stately|@react-aria|@react-stately|@react-types|@internationalized|lucide-react|radix-ui|@radix-ui|cmdk|vaul|sonner|react-day-picker)(\\x2f|$)';
const DATE_HELPERS_MESSAGE =
  'The date helpers of the DatePicker hand out objects of the date library. A page holds a date as text (YYYY-MM-DD); today in Accra as text is todayText in platform/time.';
const ARIA_PATTERNS = [
  {
    group: ['**/date-picker/date-value', '**/date-picker/date-value.ts'],
    message: DATE_HELPERS_MESSAGE,
  },
  {
    group: [
      'react-aria-components/*',
      'react-aria/*',
      'react-stately/*',
      '@react-aria/*',
      '@react-stately/*',
      '@react-types/*',
      '@internationalized/*',
    ],
    message: ARIA_MESSAGE,
  },
];

export default defineConfig(
  // The generated API client is machine output, checked for freshness rather than for style. So is what Gradle writes below the attestation
  // verifier (its build folders hold an HTML test report with JavaScript of its own, and `.gradle` its caches).
  globalIgnores([
    '**/dist/',
    '**/coverage/',
    '**/.turbo/',
    'packages/api-client/src/generated/',
    'apps/attestation-verifier/**/build/',
    'apps/attestation-verifier/.gradle/',
  ]),
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
          paths: [...OPS_RESTRICTED_PATHS, ...ARIA_PATHS, ...PRIMITIVE_LIBRARY_PATHS],
          patterns: [...ARIA_PATTERNS, ...PRIMITIVE_LIBRARY_PATTERNS, ...PRIMITIVE_FILES_PATTERNS],
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
        {
          // `no-restricted-imports` looks at import declarations only; a dynamic import is a door of its own.
          selector: `ImportExpression[source.value=/${DOOR_PACKAGES}/]`,
          message: `${ARIA_MESSAGE} ${PRIMITIVE_LIBRARIES_MESSAGE} A dynamic import is a second door; the icon library is reached through the registry.`,
        },
        {
          selector: `CallExpression[callee.name='require'][arguments.0.value=/${DOOR_PACKAGES}/]`,
          message: `${ARIA_MESSAGE} ${PRIMITIVE_LIBRARIES_MESSAGE} A require is a second door; the icon library is reached through the registry.`,
        },
      ],
      'no-eval': 'error',
      'no-new-func': 'error',
      'no-script-url': 'error',
    },
  },
  {
    // The one place that may import React Aria Components and the date library: the components of the design system, which give a page a
    // calendar, a menu or a combobox in the portal's own look and API. Everything else above still applies to them.
    files: ['apps/ops-web/src/components/ui/**/*.{ts,tsx}'],
    ignores: ['**/*.test.{ts,tsx}'],
    rules: {
      // They may import a primitive, but not the libraries under it: a component composes the primitive and never names Radix.
      'no-restricted-imports': [
        'error',
        {
          paths: [...OPS_RESTRICTED_PATHS, ...PRIMITIVE_LIBRARY_PATHS],
          patterns: PRIMITIVE_LIBRARY_PATTERNS,
        },
      ],
    },
  },
  {
    // The dev-only showcase draws every primitive beside the Melarc components, so it may import a primitive; it names no library under one.
    files: ['apps/ops-web/src/showcase/**/*.{ts,tsx}'],
    ignores: ['**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [...OPS_RESTRICTED_PATHS, ...ARIA_PATHS, ...PRIMITIVE_LIBRARY_PATHS],
          patterns: [...ARIA_PATTERNS, ...PRIMITIVE_LIBRARY_PATTERNS],
        },
      ],
    },
  },
  {
    // The one place that may import Radix UI and the libraries beside it (cmdk, vaul, sonner, react-day-picker): the shadcn/ui primitives, which
    // are generated source from the official registry, restyled through the tokens. They import their icons from the icon library directly
    // (the generated code does), which no other file may; React Aria and the API client stay out of them.
    files: ['apps/ops-web/src/components/primitives/**/*.{ts,tsx}'],
    ignores: ['**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [...API_RESTRICTED_PATHS, ...ARIA_PATHS], patterns: ARIA_PATTERNS },
      ],
    },
  },
  {
    // The one file that may import the icon library: the registry that names every icon of the application by its meaning.
    files: ['apps/ops-web/src/components/ui/icon/icons.ts'],
    rules: { 'no-restricted-imports': 'off' },
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
