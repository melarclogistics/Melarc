import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { BrowserContext, Route } from '@playwright/test';
import { describe, expect, it } from 'vitest';

import { answerStandInPictures, STAND_IN_PICTURE_HOST } from './browser-guard.ts';
import { repositoryPaths } from './paths.ts';

/**
 * What the browser's boundary answers by itself (Run G2): the one host of the in-process evidence store, which can never resolve, with a picture made in the context. The browser test of the boundary
 * (`tests/browser-boundary.spec.ts`) holds what a real context does; these hold the copy of the host and what is registered.
 */
describe('the answer for the in-process evidence store’s host', () => {
  // Break caught: the host copied by hand and then changed in the API's adapter, so that the screens that draw photos would be asking a host the context no longer answers, and every photo of a journey would be an external request.
  it('is the host the API’s in-process store names in its links', () => {
    const adapter = readFileSync(
      join(
        repositoryPaths().root,
        'apps/api/src/platform/evidence/in-process.evidence-store.adapter.ts',
      ),
      'utf8',
    );
    expect(/export const STAND_IN_HOST = '([^']+)'/.exec(adapter)?.[1]).toBe(STAND_IN_PICTURE_HOST);
  });

  // Break caught: a host that can resolve, which the context would then be answering for a real server (a name under `.invalid` can never resolve: RFC 2606).
  it('is a name that can never resolve', () => {
    expect(STAND_IN_PICTURE_HOST.endsWith('.invalid')).toBe(true);
  });

  // Break caught: an answer for more than the one host (a pattern that reaches another origin), or one that is not a picture made here.
  it('registers one route, for that host over https alone, and fulfils it with a one-pixel picture', async () => {
    const registered: { pattern: string; handle: (route: Route) => Promise<void> }[] = [];
    const context = {
      route: (pattern: string, handle: (route: Route) => Promise<void>) => {
        registered.push({ pattern, handle });
        return Promise.resolve();
      },
    } as unknown as BrowserContext;

    await answerStandInPictures(context);

    expect(registered.map((each) => each.pattern)).toEqual([`https://${STAND_IN_PICTURE_HOST}/**`]);
    let fulfilled: { status?: number; contentType?: string; body?: Buffer } | undefined;
    await registered[0]?.handle({
      fulfill: (options: typeof fulfilled) => {
        fulfilled = options;
        return Promise.resolve();
      },
    } as unknown as Route);
    expect(fulfilled?.status).toBe(200);
    expect(fulfilled?.contentType).toBe('image/gif');
    expect(fulfilled?.body?.subarray(0, 6).toString('ascii')).toBe('GIF89a');
  });
});
