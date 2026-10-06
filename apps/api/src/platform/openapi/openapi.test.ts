import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Controller, Get, Module } from '@nestjs/common';
import { ApiExcludeController, ApiOperation, type OpenAPIObject } from '@nestjs/swagger';
import { afterEach, describe, expect, it } from 'vitest';

import { loadContract } from '../../test-support/contract.js';
import { FixtureModule } from '../../test-support/fixtures.js';
import { appWith, startTestApp, type TestApp } from '../../test-support/test-app.js';
import { TechnicalEndpoint } from '../routes/access-declaration.js';
import { inspectRoutes } from '../routes/route-inventory.js';
import { buildOpenApiDocument } from './build-openapi-document.js';
import { diffRoutes, listDocumentedRoutes } from './document-routes.js';
import { writeGeneratedArtifacts } from './generate-artifacts.js';

/** A route a developer hides from the generated description, to dodge drift detection. */
@Controller('fixture-hidden')
@TechnicalEndpoint()
@ApiExcludeController()
class HiddenFixtureController {
  @Get('secret-route')
  hidden(): { ok: boolean } {
    return { ok: true };
  }
}

/** A documented route, described the way slices will describe theirs. */
@Controller('fixture-documented')
@TechnicalEndpoint()
class DocumentedFixtureController {
  @Get('items/:itemId')
  @ApiOperation({ operationId: 'getFixtureItem', summary: 'Read one fixture item' })
  item(): { ok: boolean } {
    return { ok: true };
  }
}

@Module({ controllers: [HiddenFixtureController, DocumentedFixtureController] })
class OpenApiFixtureModule {}

let running: TestApp | undefined;
const scratch: string[] = [];

async function start(options?: Parameters<typeof startTestApp>[0]): Promise<TestApp> {
  running = await startTestApp(options);
  return running;
}

afterEach(async () => {
  await running?.stop();
  running = undefined;
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('listDocumentedRoutes', () => {
  // Break caught: a conversion that leaves OpenAPI path templates or the server prefix unrestored, so
  // the description could never be compared with the live router.
  it('restores the server prefix, writes parameters as :name and ignores non-operation keys', () => {
    const document = {
      openapi: '3.0.0',
      info: { title: 't', version: 'v' },
      servers: [{ url: '/api/v1' }],
      paths: {
        '/orders/{orderId}/lines/{lineId}': {
          get: {},
          put: {},
          parameters: [],
          summary: 'not an operation',
        },
        '/orders': { post: {} },
      },
    } as unknown as OpenAPIObject;

    expect(listDocumentedRoutes(document)).toEqual([
      { method: 'GET', path: '/api/v1/orders/:orderId/lines/:lineId' },
      { method: 'POST', path: '/api/v1/orders' },
      { method: 'PUT', path: '/api/v1/orders/:orderId/lines/:lineId' },
    ]);
  });
});

describe('diffRoutes', () => {
  const probe = { method: 'GET', path: '/livez' };
  const ghost = { method: 'GET', path: '/api/v1/ghosts/:ghostId' };
  const hidden = { method: 'POST', path: '/api/v1/hidden' };

  // Break caught: a route the description documents and the router does not serve going unreported. The
  // application test below asserts an empty `documentedButNotLive`, which an implementation that never
  // reports anything also satisfies, so this one feeds the function a documented route nobody serves.
  it('reports a documented route that is not live, and nothing else', () => {
    const diff = diffRoutes([probe], [probe, ghost]);

    expect(diff.documentedButNotLive).toEqual([ghost]);
    expect(diff.liveButNotDocumented).toEqual([]);
  });

  // Break caught: the reverse: a live route the description leaves out going unreported, which is how a
  // route hidden with an exclusion decorator would escape.
  it('reports a live route that is not documented, and nothing else', () => {
    const diff = diffRoutes([probe, hidden], [probe]);

    expect(diff.liveButNotDocumented).toEqual([hidden]);
    expect(diff.documentedButNotLive).toEqual([]);
  });

  // Break caught: a route known by its path alone. The same path under another method is another route, so
  // a documented POST does not make a live GET documented, and the reverse.
  it('tells the two directions apart when the method is the only difference', () => {
    const live = { method: 'GET', path: '/api/v1/things' };
    const documented = { method: 'POST', path: '/api/v1/things' };

    expect(diffRoutes([live], [documented])).toEqual({
      liveButNotDocumented: [live],
      documentedButNotLive: [documented],
    });
  });

  it('reports nothing when the two agree, whatever the order', () => {
    expect(diffRoutes([probe, hidden], [hidden, probe])).toEqual({
      liveButNotDocumented: [],
      documentedButNotLive: [],
    });
  });

  it('reports every route that is on one side only, in the order given', () => {
    const second = { method: 'DELETE', path: '/api/v1/ghosts/:ghostId' };

    expect(diffRoutes([], [ghost, second]).documentedButNotLive).toEqual([ghost, second]);
    expect(diffRoutes([ghost, second], []).liveButNotDocumented).toEqual([ghost, second]);
  });
});

describe('the generated description of the real application', () => {
  // Break caught: a business route documented that does not exist, or the technical probes leaking into
  // a description that is compared with the product contract.
  it('documents no operations, because there are no business routes', async () => {
    const { app } = await start();
    const document = buildOpenApiDocument(app);

    expect(document.paths).toEqual({});
    expect(document.servers).toEqual([{ url: '/api/v1' }]);
    expect(document.info.title).toContain('derived from the implementation');
  });

  // Break caught: a description in a different OpenAPI dialect from the contract's, so the semantic
  // comparison (B0.6) would silently compare 3.0 constructs with 3.1 ones.
  it('declares the same OpenAPI version as the contract', async () => {
    const { app } = await start();
    expect(buildOpenApiDocument(app).openapi).toBe(loadContract().openapi);
  });
});

describe('the generated description against the live router', () => {
  // Break caught: a registered route missing from the generated description, or a documented route that
  // is not registered. "The generated API description reflects actual registered routes."
  it('documents exactly the live routes that are not technical probes', async () => {
    const { app } = await start({ rootModule: appWith(FixtureModule, OpenApiFixtureModule) });
    const document = buildOpenApiDocument(app);
    const diff = diffRoutes(inspectRoutes(app).live, listDocumentedRoutes(document));

    expect(diff.documentedButNotLive).toEqual([]);
    expect(diff.liveButNotDocumented).toEqual([
      { method: 'GET', path: '/api/v1/fixture-hidden/secret-route' },
      { method: 'GET', path: '/livez' },
      { method: 'GET', path: '/readyz' },
    ]);
    expect(Object.keys(document.paths)).toContain('/fixture-documented/items/{itemId}');
  });

  // Break caught: a business route hidden from the description with an "exclude" decorator. It surfaces
  // here as live but undocumented, so a test that pins the technical set (the two probes) fails on it.
  it('surfaces a route hidden from the description', async () => {
    const { app } = await start({ rootModule: appWith(OpenApiFixtureModule) });
    const { liveButNotDocumented } = diffRoutes(
      inspectRoutes(app).live,
      listDocumentedRoutes(buildOpenApiDocument(app)),
    );
    const technicalProbes = ['GET /livez', 'GET /readyz'];

    const unexplained = liveButNotDocumented
      .map((route) => `${route.method} ${route.path}`)
      .filter((entry) => !technicalProbes.includes(entry));
    expect(unexplained).toEqual(['GET /api/v1/fixture-hidden/secret-route']);
  });
});

describe('writeGeneratedArtifacts', () => {
  // Break caught: artifacts that are not what the running application produced, for instance a copy of the
  // canonical contract presented as generated output (engineering-standards.md §4).
  it('writes the description and the route inventory derived from the application', async () => {
    const { app } = await start({ rootModule: appWith(OpenApiFixtureModule) });
    const outDir = mkdtempSync(join(tmpdir(), 'melarc-openapi-'));
    scratch.push(outDir);

    await writeGeneratedArtifacts(app, outDir);

    const document = JSON.parse(
      readFileSync(join(outDir, 'openapi.generated.json'), 'utf8'),
    ) as OpenAPIObject;
    const inventory = JSON.parse(
      readFileSync(join(outDir, 'route-inventory.generated.json'), 'utf8'),
    ) as { live: unknown[]; declared: unknown[] };

    expect(Object.keys(document.paths)).toEqual(['/fixture-documented/items/{itemId}']);
    expect(document.info.title).toContain('derived from the implementation');
    expect(inventory.live).toEqual(inspectRoutes(app).live);
    expect(inventory.declared).toEqual(inspectRoutes(app).declared);
  });
});
