// @ts-check
import eslint from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

// What the Ops Portal's application code may not import. The API client is the one door to the API, the icon registry (and the shadcn/ui
// primitives, which are generated source that imports its icons) the door to the icon library, `components/ui/` the one door to Motion, and
// `components/primitives/` the one door to Radix UI and the libraries beside it (DESIGN_SYSTEM section 24a).
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

// Motion (the `motion` package: layout, presence and counted numbers) is imported by the components of `components/ui/` and nowhere else, through
// `components/ui/motion/motion.ts`, so that a duration and an easing are always the motion tokens and nothing moves under reduced motion
// (DESIGN_SYSTEM section 9 and 24a).
const MOTION_MESSAGE =
  'Motion is imported by the components of components/ui only, through components/ui/motion/motion.ts (DESIGN_SYSTEM section 24a): a page names a component, and a duration or an easing is a motion token.';
const MOTION_PATHS = ['motion', 'framer-motion', 'motion-dom', 'motion-utils'].map((name) => ({
  name,
  message: MOTION_MESSAGE,
}));
const MOTION_PATTERNS = [
  {
    group: ['motion/*', 'framer-motion/*', 'motion-dom/*', 'motion-utils/*'],
    message: MOTION_MESSAGE,
  },
];

// TanStack Table is imported by the kit's `DataTable` (`components/ui/data-table/`) and nowhere else (task R5.2, M12; COMPONENT_PATTERNS section 37): a screen
// hands the table its rows and columns, and the table keeps the row model, so that a second, hand-built grid cannot appear beside it.
const TANSTACK_MESSAGE =
  'TanStack Table is imported by the DataTable of components/ui/data-table only (COMPONENT_PATTERNS section 37): a screen gives the DataTable its columns and rows and never builds a grid of its own.';
const TANSTACK_PATHS = ['@tanstack/react-table', '@tanstack/table-core'].map((name) => ({
  name,
  message: TANSTACK_MESSAGE,
}));
const TANSTACK_PATTERNS = [
  {
    group: ['@tanstack/react-table/*', '@tanstack/table-core/*'],
    message: TANSTACK_MESSAGE,
  },
];

// The page header of the redesign is `components/ui/page-header/PageHeader`. The older `components/PageHeader` stays only for the screens that are not rebuilt
// yet: each of them names it on a line that carries its own `eslint-disable-next-line no-restricted-imports`, so that the list is the lines of that
// directive, can only shrink (an unused directive is an error), and a new screen cannot import the old one without saying so (task R5.2, M12).
const OLD_PAGE_HEADER_PATTERNS = [
  {
    group: ['**/components/PageHeader', '@/components/PageHeader'],
    message:
      'Use the PageHeader of components/ui/page-header (the redesign). The older components/PageHeader is kept only by the screens that are not rebuilt yet (each carries an eslint-disable-next-line for it); it is not imported by a new one.',
  },
];

// The packages that only the components of the design system (and the icon registry, for lucide-react) may name, by any way of naming them.
// (A slash cannot be written inside the selector's regular expression, so it is written as its code.)
const DOOR_PACKAGES =
  '^(motion|framer-motion|motion-dom|motion-utils|lucide-react|radix-ui|@radix-ui|cmdk|vaul|sonner|react-day-picker|@tanstack\\x2f(?:react-table|table-core))(\\x2f|$)';
const DATE_HELPERS_MESSAGE =
  'The date helpers of the DatePicker read and write the date as the control types it. A page holds a date as text (YYYY-MM-DD); today in Accra as text is todayText in platform/time.';
const DATE_PATTERNS = [
  {
    group: [
      '**/date-picker/date-value',
      '**/date-picker/date-value.ts',
      '**/date-picker/day-first',
      '**/date-picker/day-first.ts',
    ],
    message: DATE_HELPERS_MESSAGE,
  },
];

// What the Ops Portal's application code may not name, in lists, so that the one module that keeps the person's choice of theme can be given
// `localStorage` and nothing else (the block for it, below the Ops Portal's own): a flat-config rule is replaced, not merged, by a later block,
// so that block states the same rule again, from these lists, with the one name taken out.
const TRANSPORT_GLOBALS = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource'];
const STORAGE_GLOBALS = ['localStorage', 'sessionStorage', 'indexedDB'];
const WINDOW_OBJECTS = ['window', 'globalThis', 'self'];
const WINDOW_PROPERTIES = [
  'fetch',
  'open',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
];
const restrictedGlobals = (names) =>
  names.map((name) => ({
    name,
    message:
      'The Ops Portal reaches the API only through the generated client (@melarc/api-client/browser), and keeps nothing in the browser storage: a session is an HttpOnly cookie.',
  }));
const restrictedWindowProperties = (properties) =>
  WINDOW_OBJECTS.flatMap((object) =>
    properties.map((property) => ({
      object,
      property,
      message: `${object}.${property} is not for application code: requests go through the generated client, and nothing is kept in browser storage.`,
    })),
  );
const OTHER_RESTRICTED_PROPERTIES = [
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
        ...restrictedGlobals([...TRANSPORT_GLOBALS, ...STORAGE_GLOBALS]),
      ],
      'no-restricted-properties': [
        'error',
        ...restrictedWindowProperties(WINDOW_PROPERTIES),
        ...OTHER_RESTRICTED_PROPERTIES,
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            ...OPS_RESTRICTED_PATHS,
            ...MOTION_PATHS,
            ...PRIMITIVE_LIBRARY_PATHS,
            ...TANSTACK_PATHS,
          ],
          patterns: [
            ...DATE_PATTERNS,
            ...MOTION_PATTERNS,
            ...PRIMITIVE_LIBRARY_PATTERNS,
            ...PRIMITIVE_FILES_PATTERNS,
            ...TANSTACK_PATTERNS,
            ...OLD_PAGE_HEADER_PATTERNS,
          ],
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
          message: `${MOTION_MESSAGE} ${PRIMITIVE_LIBRARIES_MESSAGE} ${TANSTACK_MESSAGE} A dynamic import is a second door; the icon library is reached through the registry.`,
        },
        {
          selector: `CallExpression[callee.name='require'][arguments.0.value=/${DOOR_PACKAGES}/]`,
          message: `${MOTION_MESSAGE} ${PRIMITIVE_LIBRARIES_MESSAGE} ${TANSTACK_MESSAGE} A require is a second door; the icon library is reached through the registry.`,
        },
      ],
      'no-eval': 'error',
      'no-new-func': 'error',
      'no-script-url': 'error',
    },
  },
  {
    // **The one exception to the ban on web storage** (PRODUCT_DESIGN_DIRECTION section 7; the Product Owner, 5 November 2026, and 6 November 2026, A11):
    // the person's choice of theme, `light` or `dark`, a non-sensitive preference under one key of `localStorage`. It is for this one module and for
    // the bare name `localStorage` alone (the module uses no other form: `window.localStorage`, `globalThis.localStorage` and `self.localStorage`
    // stay refused in it, so the rule it relaxes is the one rule, `no-restricted-globals`, and no other): `sessionStorage`, `indexedDB`, the cookie,
    // every transport and every other rule above still apply to it, and every other file of the application is refused as before
    // (`scripts/eslint-rules.test.ts` holds both). A session, a token or anything about a person is never stored there.
    files: ['apps/ops-web/src/platform/theme/theme-choice.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        ...restrictedGlobals([
          ...TRANSPORT_GLOBALS,
          ...STORAGE_GLOBALS.filter((name) => name !== 'localStorage'),
        ]),
      ],
    },
  },
  {
    // The one place that may import Motion: the components of the design system, which give a page a panel, a list or a figure that moves in the
    // portal's own times and easings. Everything else above still applies to them.
    files: ['apps/ops-web/src/components/ui/**/*.{ts,tsx}'],
    ignores: ['**/*.test.{ts,tsx}'],
    rules: {
      // They may import a primitive, but not the libraries under it: a component composes the primitive and never names Radix.
      'no-restricted-imports': [
        'error',
        {
          paths: [...OPS_RESTRICTED_PATHS, ...PRIMITIVE_LIBRARY_PATHS, ...TANSTACK_PATHS],
          patterns: [
            ...PRIMITIVE_LIBRARY_PATTERNS,
            ...TANSTACK_PATTERNS,
            ...OLD_PAGE_HEADER_PATTERNS,
          ],
        },
      ],
    },
  },
  {
    // The one place that may import TanStack Table: the DataTable. It is a component of `components/ui`, so it states that block's rule again (a later block
    // replaces the rule, it does not merge) with TanStack taken out.
    files: ['apps/ops-web/src/components/ui/data-table/**/*.{ts,tsx}'],
    ignores: ['**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [...OPS_RESTRICTED_PATHS, ...PRIMITIVE_LIBRARY_PATHS],
          patterns: [...PRIMITIVE_LIBRARY_PATTERNS, ...OLD_PAGE_HEADER_PATTERNS],
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
          paths: [
            ...OPS_RESTRICTED_PATHS,
            ...MOTION_PATHS,
            ...PRIMITIVE_LIBRARY_PATHS,
            ...TANSTACK_PATHS,
          ],
          patterns: [
            ...DATE_PATTERNS,
            ...MOTION_PATTERNS,
            ...PRIMITIVE_LIBRARY_PATTERNS,
            ...TANSTACK_PATTERNS,
            ...OLD_PAGE_HEADER_PATTERNS,
          ],
        },
      ],
    },
  },
  {
    // The one place that may import Radix UI and the libraries beside it (cmdk, vaul, sonner, react-day-picker): the shadcn/ui primitives, which
    // are generated source from the official registry, restyled through the tokens. They import their icons from the icon library directly
    // (the generated code does), which no other file may; Motion and the API client stay out of them.
    files: ['apps/ops-web/src/components/primitives/**/*.{ts,tsx}'],
    ignores: ['**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [...API_RESTRICTED_PATHS, ...MOTION_PATHS, ...TANSTACK_PATHS],
          patterns: [...MOTION_PATTERNS, ...TANSTACK_PATTERNS, ...OLD_PAGE_HEADER_PATTERNS],
        },
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
