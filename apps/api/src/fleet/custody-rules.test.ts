import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../../..');
const read = (path: string): string =>
  readFileSync(resolve(ROOT, path), 'utf8').replaceAll('\r', '');
const SERVICE = read('apps/api/src/fleet/run-custody-handover.service.ts');
const CONTRACT = read('contracts/openapi.yaml');

/** The text of one operation: from its `operationId` to the next one, or the end. */
function operationText(operationId: string): string {
  const start = CONTRACT.indexOf(`operationId: ${operationId}\n`);
  expect(start, `${operationId} is in the contract`).toBeGreaterThan(-1);
  const next = CONTRACT.indexOf('operationId: ', start + 1);
  return CONTRACT.slice(start, next === -1 ? undefined : next);
}

/**
 * The `details.rule` names of the custody acts (S1.24). A client tells one `STATE_CONFLICT` from another by them, so each is named in the
 * contract, in the operation that emits it. The set the service refuses with is pinned here as well, so that a rule added in the code alone is
 * a failure to decide, and not a word a client has to guess.
 */
describe('the rules the custody acts refuse with are named in the contract', () => {
  // Break caught: a rule added to, or dropped from, the service without the contract and this list being changed with it.
  it('are exactly the four the service emits', () => {
    const emitted = [
      ...new Set([...SERVICE.matchAll(/\brule: '([a-z_]+)'/g)].map((match) => match[1] ?? '')),
    ].toSorted();

    expect(emitted).toEqual([
      'custody_handover_pending',
      'custody_with_hub',
      'no_custody_handover_pending',
      'run_not_in_progress',
    ]);
  });

  // Break caught: a rule a client would have to guess, because the contract of the act that emits it does not say it.
  it.each([
    [
      'initiateRunCustodyHandover',
      ['run_not_in_progress', 'custody_handover_pending', 'custody_with_hub'],
    ],
    ['acceptRunCustodyHandover', ['run_not_in_progress', 'no_custody_handover_pending']],
    ['failRunCustodyHandover', ['run_not_in_progress', 'no_custody_handover_pending']],
  ])('%s names its rules', (operationId, rules) => {
    const text = operationText(operationId);
    for (const rule of rules) {
      expect(text, `${operationId} names ${rule}`).toContain(`\`${rule}\``);
    }
  });

  // Break caught: a rule named in the operation of an act that does not emit it, which would promise a client an answer it never gets.
  it('does not name the rule of one act in another', () => {
    for (const operationId of ['acceptRunCustodyHandover', 'failRunCustodyHandover']) {
      // Between backticks: `no_custody_handover_pending` holds the other name as a part of its own.
      expect(operationText(operationId), operationId).not.toContain('`custody_handover_pending`');
      expect(operationText(operationId), operationId).not.toContain('`custody_with_hub`');
    }
  });
});
