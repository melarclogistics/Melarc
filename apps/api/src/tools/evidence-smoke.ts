import { SystemClock } from '../platform/auth/clock/system.clock.adapter.js';
import { loadConfig } from '../platform/config/load-config.js';
import { ClamavContentScanner } from '../platform/evidence/clamav.content-scanner.adapter.js';
import { InProcessContentScanner } from '../platform/evidence/in-process.content-scanner.adapter.js';
import { InProcessEvidenceStore } from '../platform/evidence/in-process.evidence-store.adapter.js';
import {
  fetchStreamTransport,
  fetchTransport,
  R2EvidenceStore,
} from '../platform/evidence/r2.evidence-store.adapter.js';
import { runEvidenceSmoke, type SmokeWorld } from './evidence-smoke-run.js';

/**
 * The owner's first contact with a bucket and a scanner (Run A2, D-A6; the plan's section 7.5): `pnpm --filter @melarc/api run evidence:smoke`, after a build. The logic is
 * `evidence-smoke-run.ts`; this file is where the real adapters are composed from the API's own settings (`EVIDENCE_STORE`, `EVIDENCE_R2_*`, `EVIDENCE_SCANNER`, `EVIDENCE_CLAMAV_*`
 * of `apps/api/.env`, loaded by the package script) and bound to it, so it is on the architecture test's list of composition-root files.
 */
function compose(env: Readonly<Record<string, string | undefined>>): SmokeWorld | string[] {
  const loaded = loadConfig({ ...env });
  if (!loaded.ok) return loaded.problems.map((problem) => `${problem.key}: ${problem.problem}`);
  const { evidenceStore, contentScanner } = loaded.config.adapters;
  if (contentScanner.kind === 'none') {
    return [
      'EVIDENCE_SCANNER: no scanner is configured, so there is nothing to put the files through',
    ];
  }
  const scanner =
    contentScanner.kind === 'clamav'
      ? new ClamavContentScanner({
          host: contentScanner.host,
          port: contentScanner.port,
          timeoutMs: contentScanner.timeoutMs,
        })
      : new InProcessContentScanner();
  const scannerKind = contentScanner.kind === 'clamav' ? 'ClamAV' : 'the in-process stand-in';

  if (evidenceStore.kind === 'in-process') {
    const store = new InProcessEvidenceStore();
    return {
      mode: 'DRY RUN',
      storeKind: 'the in-process stand-in',
      scannerKind,
      store,
      scanner,
      upload: (capability, body) =>
        Promise.resolve(
          store.redeem({
            method: capability.method,
            url: capability.url,
            headers: { ...capability.headers, 'Content-Length': String(body.length) },
            body,
          }).status,
        ),
    };
  }

  const store = new R2EvidenceStore({
    accountId: evidenceStore.accountId,
    bucket: evidenceStore.bucket,
    accessKeyId: evidenceStore.accessKeyId,
    secretAccessKey: evidenceStore.secretAccessKey,
    transport: fetchTransport,
    streamTransport: fetchStreamTransport,
  });
  return {
    mode: contentScanner.kind === 'clamav' ? 'REAL' : 'DRY RUN',
    storeKind: 'Cloudflare R2',
    scannerKind,
    store,
    scanner,
    // The call a handset makes with the capability it was given: a plain `fetch`, following no redirect, whose answer's text is read and thrown away (it may name an address).
    upload: async (capability, body) => {
      const response = await fetch(capability.url, {
        method: capability.method,
        headers: { ...capability.headers },
        body: new Uint8Array(body),
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
      await response.arrayBuffer();
      return response.status;
    },
  };
}

const clock = new SystemClock();
process.exitCode = await runEvidenceSmoke(process.argv.slice(2), process.env, {
  out: (line) => {
    process.stdout.write(`${line}\n`);
  },
  now: () => clock.now(),
  compose,
});
