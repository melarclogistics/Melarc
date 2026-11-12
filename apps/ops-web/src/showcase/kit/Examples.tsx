import { useMemo, useState } from 'react';

import { Button as TouchButton } from '../../components/primitives/button';
import { DataTable, RowTitle, type DataColumn } from '../../components/ui/data-table/DataTable';
import { PageHeader } from '../../components/ui/page-header/PageHeader';
import { Panel } from '../../components/ui/panel/Panel';
import { showToast } from '../../components/ui/toast/Toast';
interface CountLine {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

const COUNT_LINES: readonly CountLine[] = [
  { id: 'line-1', code: 'ACC-PR-7KQ2MZ', name: 'Sample Fabrics Ltd' },
  { id: 'line-2', code: 'ACC-PR-4HT9WD', name: 'Sample Bakery' },
  { id: 'line-3', code: 'ACC-PR-2MX8RC', name: 'Sample Pharmacy' },
  { id: 'line-4', code: 'ACC-PR-9WXH4T', name: 'Sample Books' },
];

/**
 * A hub-floor task on a tablet (DESIGN_SYSTEM section 12; surfaces/ops-portal.md section 11): the blind count at 768px, one task on the screen, with rows and
 * every target at 56px. **The sender's declared count is not on the screen**, and the screen says why: it is shown only after the officer's own count is sent.
 * Nothing is added up here: what was counted is the officer's, line by line, and the server compares.
 */
export function BlindCountExample() {
  const [counts, setCounts] = useState<Readonly<Record<string, string>>>({});
  const columns = useMemo<readonly DataColumn<CountLine>[]>(
    () => [
      {
        id: 'line',
        header: 'Parcels from',
        cell: (line) => <RowTitle code={line.code} name={line.name} />,
      },
      {
        id: 'counted',
        header: 'You counted',
        align: 'end',
        cell: (line) => {
          const value = counts[line.id] ?? '';
          const set = (next: number): void => {
            setCounts((current) => ({ ...current, [line.id]: String(Math.max(0, next)) }));
          };
          return (
            <span
              className="showcase-kit-row"
              style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}
            >
              <TouchButton
                type="button"
                variant="outline"
                size="icon-lg"
                aria-label={`One fewer parcel from ${line.name}`}
                onClick={() => {
                  set((Number(value) || 0) - 1);
                }}
              >
                <span className="showcase-kit-count__step" aria-hidden="true">
                  −
                </span>
              </TouchButton>
              <input
                className="showcase-kit-count__field"
                inputMode="numeric"
                aria-label={`Parcels counted from ${line.name}`}
                value={value}
                placeholder="0"
                onChange={(event) => {
                  const digits = event.target.value.replace(/\D/g, '').slice(0, 3);
                  setCounts((current) => ({ ...current, [line.id]: digits }));
                }}
              />
              <TouchButton
                type="button"
                variant="outline"
                size="icon-lg"
                aria-label={`One more parcel from ${line.name}`}
                onClick={() => {
                  set((Number(value) || 0) + 1);
                }}
              >
                <span className="showcase-kit-count__step" aria-hidden="true">
                  +
                </span>
              </TouchButton>
            </span>
          );
        },
      },
    ],
    [counts],
  );
  const everyLineCounted = COUNT_LINES.every((line) => (counts[line.id] ?? '') !== '');
  return (
    <div className="showcase-kit-tablet">
      <PageHeader
        title="Count the parcels"
        description="Count every parcel on the bench, line by line. The sender's count is not shown until yours is sent."
      />
      <Panel padding="none">
        <DataTable<CountLine>
          label="Parcels to count"
          columns={columns}
          rows={COUNT_LINES}
          rowId={(line) => line.id}
          density="touch"
        />
      </Panel>
      <div
        className="showcase-kit-row"
        style={{ marginTop: 'var(--space-4)', justifyContent: 'flex-end' }}
      >
        <TouchButton type="button" variant="outline" size="lg">
          Save and come back
        </TouchButton>
        <TouchButton
          type="button"
          size="lg"
          disabled={!everyLineCounted}
          onClick={() => {
            showToast({
              tone: 'success',
              message: 'Your count was sent. The hub will compare it with the sender’s.',
            });
          }}
        >
          Send the count
        </TouchButton>
      </div>
      {everyLineCounted ? null : <p className="showcase-kit-opened">Count every line to send.</p>}
    </div>
  );
}
