import { describe, expect, it } from 'vitest';

import type { ContentScanner, ScanVerdict } from '../platform/auth/ports/content-scanner.port.js';
import { ContentScannerError } from '../platform/evidence/content-scanner-error.js';
import { EvidenceStoreError } from '../platform/evidence/evidence-store-error.js';
import { InProcessContentScanner } from '../platform/evidence/in-process.content-scanner.adapter.js';
import { InProcessEvidenceStore } from '../platform/evidence/in-process.evidence-store.adapter.js';
import { runEvidenceSmoke, type SmokeWorld } from './evidence-smoke-run.js';

/**
 * The owner's `evidence:smoke` command (Run A2; the plan's section 7.5), against the in-process stand-ins and against stores and scanners that misbehave. What these prove: the command
 * puts a clean file and the EICAR test file through the platform's own judgement and tells the difference; it notices a store that accepts an upload that is not the one signed and a
 * scanner that does not flag the test virus; it fails closed when a scanner or a store cannot answer; and **it prints no key, address, signed address or credential, whatever happens**.
 */
const NOW = new Date('2026-11-12T09:00:00.000Z');

function standInWorld(
  over: Partial<Omit<SmokeWorld, 'store'>> = {},
  store: InProcessEvidenceStore = new InProcessEvidenceStore({ now: () => NOW }),
): SmokeWorld & { store: InProcessEvidenceStore } {
  return {
    mode: 'DRY RUN',
    storeKind: 'the in-process stand-in',
    scannerKind: 'the in-process stand-in',
    store,
    scanner: new InProcessContentScanner(),
    upload: (capability, body) =>
      Promise.resolve(
        store.redeem({
          method: capability.method,
          url: capability.url,
          headers: { ...capability.headers, 'Content-Length': String(body.length) },
          body,
        }).status,
      ),
    ...over,
  };
}

async function run(
  world: SmokeWorld | string[],
  argv: readonly string[] = [],
): Promise<{ readonly code: number; readonly lines: string[] }> {
  const lines: string[] = [];
  const code = await runEvidenceSmoke(
    argv,
    {},
    {
      out: (line) => lines.push(line),
      now: () => NOW,
      compose: () => world,
    },
  );
  return { code, lines };
}

/**
 * Nothing that could name where the store or the scanner is, or what was signed: no object key, no address, no part of a signed address (its query names: `X-Amz-Signature`,
 * `X-Amz-Credential` and the rest), no long hex run (a key, a hash of a secret). The name of the checksum header the command asks the store about is not one of these.
 */
const LEAKS = [
  /ev\//,
  /X-Amz-(Signature|Credential|Algorithm|Date|Expires|SignedHeaders|Security-Token)/i,
  /https?:/i,
  /[0-9a-f]{32}/,
  /\.invalid/,
  /Signature=/i,
  /secret/i,
];
const clean = (lines: readonly string[]): void => {
  for (const line of lines) {
    for (const pattern of LEAKS) expect(line, String(pattern)).not.toMatch(pattern);
  }
};

describe('evidence:smoke', () => {
  // Break caught: a smoke command that cannot tell the test virus from a photograph, or that reports a refusal as an acceptance.
  it('puts a clean JPEG and the EICAR test file through the platform’s check and finds each as it should be', async () => {
    const { code, lines } = await run(standInWorld());
    expect(code).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('Mode: DRY RUN');
    expect(text).toContain(
      'A clean JPEG (22 bytes): the upload was accepted by the store (status 200).',
    );
    expect(text).toContain(
      "A clean JPEG: the platform's check ACCEPTED it, scanned clean by stand-in (stand-in/1).",
    );
    expect(text).toContain(
      "The EICAR test file: the platform's check REFUSED it as malicious content.",
    );
    expect(text).toContain('The EICAR test file: its object was removed from the store.');
    expect(text).toContain('An upload longer than the length signed: the store refused it');
    expect(text).toContain(
      'An upload of the signed length that hashes otherwise: the store refused it',
    );
    expect(text).toContain('Nothing was stored by the uploads that were not the one signed.');
    expect(lines.at(-1)).toBe('RESULT: every check came out as expected.');
    expect(lines.filter((line) => line.startsWith('FAIL'))).toEqual([]);
    clean(lines);
  });

  // Break caught: a command that leaves its test files in the owner's bucket (the clean file, the test virus or the half-made uploads).
  it('removes what it made: nothing is left in the store', async () => {
    const world = standInWorld();
    const keys: string[] = [];
    const presign = world.store.presignUpload.bind(world.store);
    world.store.presignUpload = (request) => {
      keys.push(request.key);
      return presign(request);
    };
    const { code } = await run(world);
    expect(code).toBe(0);
    expect(keys.length).toBeGreaterThanOrEqual(3);
    for (const key of keys) expect(world.store.has(key), 'an object was left').toBe(false);
  });

  // Break caught: a scanner that does not flag the test virus, which would make a deployment's scanner look as if it worked.
  it('fails when the scanner does not flag the EICAR test file', async () => {
    const calm: ContentScanner = {
      scan: async (object) => {
        for await (const chunk of object) void chunk;
        return {
          verdict: 'CLEAN',
          scanner: 'clamav',
          signatureVersion: 'ClamAV 1.4.2/27836/Wed Nov 12 08:05:44 2026',
        } satisfies ScanVerdict;
      },
    };
    const { code, lines } = await run(standInWorld({ scanner: calm }));
    expect(code).toBe(1);
    expect(
      lines.some(
        (line) => line.startsWith('FAIL The EICAR test file') && line.includes('did not flag it'),
      ),
    ).toBe(true);
    clean(lines);
  });

  // Break caught: a store that accepts an upload that is not the one signed, which the design assumes it refuses (the plan's section 7.5, item 2).
  it('fails, and says so, when the store accepts an upload that is not the one signed', async () => {
    const base = standInWorld();
    let uploads = 0;
    const lax = standInWorld(
      {
        upload: (capability, body) => {
          uploads += 1;
          // The first two uploads are the files; the next two are the wrong ones, which this store accepts.
          return uploads > 2 ? Promise.resolve(200) : base.upload(capability, body);
        },
      },
      base.store,
    );
    const { code, lines } = await run(lax);
    expect(code).toBe(1);
    expect(lines.filter((line) => line.startsWith('FAIL')).length).toBeGreaterThanOrEqual(2);
    expect(lines.join('\n')).toContain('the store ACCEPTED it');
    clean(lines);
  });

  // Break caught: a scanner that cannot be reached read as a pass, or as an error whose text is printed.
  it('fails closed, without printing the scanner’s words, when the scanner cannot be reached', async () => {
    const down: ContentScanner = {
      scan: () =>
        Promise.reject(new ContentScannerError('SCANNER_UNAVAILABLE', 'refused at 10.0.4.7:3310')),
    };
    const { code, lines } = await run(standInWorld({ scanner: down }));
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('The scanner could not decide (SCANNER_UNAVAILABLE)');
    expect(lines.join('\n')).not.toContain('10.0.4.7');
    clean(lines);
  });

  it('fails closed, without printing the store’s words, when the store cannot answer', async () => {
    const world = standInWorld();
    const broken: SmokeWorld = {
      ...world,
      store: {
        presignUpload: (request) => world.store.presignUpload(request),
        presignRetrieval: (request) => world.store.presignRetrieval(request),
        inspect: () =>
          Promise.reject(
            new EvidenceStoreError('STORE_UNAVAILABLE', 'GET https://x.r2/y?X-Amz-Signature=abc'),
          ),
        read: (key) => world.store.read(key),
        remove: (key) => world.store.remove(key),
      },
    };
    const { code, lines } = await run(broken);
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('The store could not answer (STORE_UNAVAILABLE)');
    clean(lines);
  });

  it('prints nothing of an error it does not know, and fails', async () => {
    const odd: ContentScanner = {
      scan: () => Promise.reject(new Error('at https://secret.example/?token=abc')),
    };
    const { code, lines } = await run(standInWorld({ scanner: odd }));
    expect(code).toBe(1);
    expect(lines.join('\n')).not.toContain('secret.example');
    expect(lines.join('\n')).not.toContain('token');
    clean(lines);
  });

  it('refuses settings it cannot use, naming keys only, and does nothing', async () => {
    const { code, lines } = await run(['EVIDENCE_R2_BUCKET: missing', 'EVIDENCE_SCANNER: invalid']);
    expect(code).toBe(2);
    expect(lines).toContain('  EVIDENCE_R2_BUCKET: missing');
    expect(lines.join('\n')).not.toContain('RESULT');
  });

  it('takes no options', async () => {
    const { code, lines } = await run(standInWorld(), ['--to', '+233244000111']);
    expect(code).toBe(2);
    expect(lines[0]).toContain('usage: evidence:smoke');
  });
});
