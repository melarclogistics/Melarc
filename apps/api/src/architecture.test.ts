import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  findPlatformBoundaryViolations,
  type SourceFile,
} from './test-support/platform-boundary.js';

describe('findPlatformBoundaryViolations', () => {
  const file = (path: string, text: string): SourceFile => ({ path, text });

  // Break caught: a rule so strict that ordinary platform code, or any package import, is flagged.
  // Climbing "../" from inside platform/ to a sibling platform folder is fine; only leaving platform/ is not.
  it('accepts imports of packages and of other platform files', () => {
    const files = [
      file(
        'platform/health/health.controller.ts',
        [
          "import { Controller } from '@nestjs/common';",
          "import type { Logger } from 'pino';",
          "import { LOGGER } from '../platform.tokens.js';",
          "import { ReadinessRegistry } from './readiness.registry.js';",
          "import { TechnicalEndpoint } from '../routes/access-declaration.js';",
        ].join('\n'),
      ),
    ];
    expect(findPlatformBoundaryViolations(files)).toEqual([]);
  });

  // Break caught: platform code reaching up into the composition root or sideways into a domain module.
  // The file sits at src/platform/auth/session.ts, so "../../" is src/ and "../" is still platform/.
  it.each([
    [
      'the composition root',
      "import { AppModule } from '../../app.module.js';",
      '../../app.module.js',
    ],
    [
      'a domain module',
      "import { Pickup } from '../../pickup/requests/create.js';",
      '../../pickup/requests/create.js',
    ],
    ['a re-export', "export * from '../../pickup/index.js';", '../../pickup/index.js'],
    ['a dynamic import', "const m = await import('../../hub/intake.js');", '../../hub/intake.js'],
    ['a side-effect import', "import '../../pickup/register.js';", '../../pickup/register.js'],
    [
      'a type import',
      "import type { Order } from '../../pricing/order.js';",
      '../../pricing/order.js',
    ],
  ])('flags %s', (_label, line, specifier) => {
    const violations = findPlatformBoundaryViolations([file('platform/auth/session.ts', line)]);
    expect(violations).toEqual([
      `platform/auth/session.ts imports ${specifier}, which is outside platform/`,
    ]);
  });

  // Break caught: the rule applied to tests, which legitimately build the whole application.
  it('does not apply to test files or to code outside platform/', () => {
    const files = [
      file('platform/health/health.test.ts', "import { createApp } from '../../create-app.js';"),
      file('main.ts', "import { AppModule } from './app.module.js';"),
      file('pickup/pickup.module.ts', "import { LOGGER } from '../platform/platform.tokens.js';"),
    ];
    expect(findPlatformBoundaryViolations(files)).toEqual([]);
  });
});

describe('the platform directory', () => {
  // Break caught: a platform file depending on a domain module, which would let authorization or audit
  // be bypassed per feature. This is the dependency direction SOLUTION_ARCHITECTURE.md §5 requires.
  it('depends on nothing outside itself', () => {
    const sourceRoot = import.meta.dirname;
    const files: SourceFile[] = readdirSync(sourceRoot, { recursive: true, encoding: 'utf8' })
      .map((path) => path.replaceAll('\\', '/'))
      .filter((path) => path.startsWith('platform/') && path.endsWith('.ts'))
      .map((path) => ({ path, text: readFileSync(join(sourceRoot, path), 'utf8') }));

    expect(files.length).toBeGreaterThan(10);
    expect(findPlatformBoundaryViolations(files)).toEqual([]);
  });
});
