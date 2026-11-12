import { useState } from 'react';

import { OperationalCode } from '../../components/ui/code/OperationalCode';
import { ReorderList, type ReorderItem } from '../../components/ui/reorder-list/ReorderList';
import { KitSection, Specimen } from './Section';

const STOPS = [
  { id: 'stop-1', code: 'ACC-PR-7KQ2MZ', place: 'Sample Fabrics Ltd, Osu' },
  { id: 'stop-2', code: 'ACC-PR-4HT9WD', place: 'Sample Bakery, Labone' },
  { id: 'stop-3', code: 'ACC-PR-2MX8RC', place: 'Sample Pharmacy, Cantonments' },
  { id: 'stop-4', code: 'ACC-PR-9WXH4T', place: 'Sample Books, Airport Residential' },
] as const;

function stopItems(order: readonly string[], fixedId?: string): ReorderItem[] {
  return order.flatMap((id, index) => {
    const stop = STOPS.find((candidate) => candidate.id === id);
    if (stop === undefined) return [];
    return [
      {
        id,
        label: `Stop ${String(index + 1)}, ${stop.code}`,
        fixed: id === fixedId,
        ...(id === fixedId ? { fixedNote: 'Already collected, so it keeps its place.' } : {}),
        content: (
          <>
            <OperationalCode>{stop.code}</OperationalCode>
            <p>{stop.place}</p>
          </>
        ),
      },
    ];
  });
}

/** The stop-reordering control with its move animated (Motion's layout animation, off under reduced motion). */
export function ListsGroup() {
  const [order, setOrder] = useState<readonly string[]>(STOPS.map((stop) => stop.id));
  const [withFixed, setWithFixed] = useState<readonly string[]>(STOPS.map((stop) => stop.id));
  return (
    <KitSection
      title="ReorderList"
      note="The order of the stops of a run, changed with two buttons for each stop, from the keyboard and with a pointer alike. A move glides to its place over 200ms; nothing moves under reduced motion. The stops are samples."
    >
      <div className="showcase-kit-grid">
        <Specimen label="Four stops (sample data)">
          <ReorderList
            label="Stops of the sample run"
            items={stopItems(order)}
            onChange={setOrder}
          />
        </Specimen>
        <Specimen label="A stop that keeps its place">
          <ReorderList
            label="Stops of the sample run with one collected"
            items={stopItems(withFixed, 'stop-2')}
            onChange={setWithFixed}
          />
        </Specimen>
        <Specimen label="Nothing can be moved now (the order is being sent)">
          <ReorderList
            label="Stops of the sample run being sent"
            items={stopItems(STOPS.map((stop) => stop.id))}
            onChange={() => undefined}
            disabled
          />
        </Specimen>
      </div>
    </KitSection>
  );
}
