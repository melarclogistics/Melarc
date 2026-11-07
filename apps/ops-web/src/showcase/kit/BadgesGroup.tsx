import { MANIFEST_STATE_MAP } from '../../app/pages/manifests/manifest-presentation';
import { PICKUP_STATE_MAP } from '../../app/pages/pickup/pickup-presentation';
import { STATUS_ROWS, STATUS_TABLE } from '../../app/status/status-table';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/primitives/table';
import { Avatar } from '../../components/ui/avatar/Avatar';
import { CountBadge } from '../../components/ui/count-badge/CountBadge';
import { StatusBadge } from '../../components/ui/status-badge/StatusBadge';
import { KitSection, Specimen } from './Section';

/** Every state the portal shows, as the one table has it (`app/status/status-table.ts`), each drawn by the badge. */
function StatusTable() {
  return (
    <Table aria-label="Every state the portal shows, and how it is drawn">
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Domain</TableHead>
          <TableHead scope="col">State</TableHead>
          <TableHead scope="col">Drawn as</TableHead>
          <TableHead scope="col">Pair</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {STATUS_ROWS.map((row) => (
          <TableRow key={`${row.domain}/${row.state}`}>
            <TableCell>
              <code className="showcase-kit-token">{row.domain}</code>
            </TableCell>
            <TableCell>
              <code className="showcase-kit-token">{row.state}</code>
            </TableCell>
            <TableCell>
              <StatusBadge<string> status={row.state} map={STATUS_TABLE[row.domain]} />
            </TableCell>
            <TableCell>{row.pair}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function StatusBadgeSpecimens() {
  return (
    <KitSection
      title="StatusBadge"
      note="The status of a record, in words, with a 6px dot in the colour of its pair. The words carry the meaning and the colour supports them. There are five pairs (waiting, success, info, neutral and danger), and one table says which pair and which words every state of the portal has. A value the page has no words for is neutral and says so, and is never shown as it came."
    >
      <div className="showcase-kit-grid">
        <Specimen label="The five pairs, each with a state it is used for">
          <div className="showcase-kit-row">
            <StatusBadge status="PENDING" map={PICKUP_STATE_MAP} />
            <StatusBadge status="CONFIRMED" map={PICKUP_STATE_MAP} />
            <StatusBadge status="IN_PROGRESS" map={MANIFEST_STATE_MAP} />
            <StatusBadge status="CANCELLED" map={PICKUP_STATE_MAP} />
            <StatusBadge status="DECLINED" map={PICKUP_STATE_MAP} />
          </div>
        </Specimen>
        <Specimen label="A state this page has no words for">
          <StatusBadge status="ON_HOLD_FOR_REVIEW" map={PICKUP_STATE_MAP} />
        </Specimen>
        <Specimen label="In running text">
          <p className="showcase-kit-line">
            Request <span className="showcase-kit-token">ACC-PR-7KQ2MZ</span> is{' '}
            <StatusBadge status="PENDING" map={PICKUP_STATE_MAP} /> and its run is{' '}
            <StatusBadge status="DISPATCHED" map={MANIFEST_STATE_MAP} />.
          </p>
        </Specimen>
      </div>
      <Specimen label="Every state of the portal: the one table, drawn" width="56rem">
        <StatusTable />
      </Specimen>
    </KitSection>
  );
}

function CountBadgeSpecimens() {
  return (
    <KitSection
      title="CountBadge"
      note="A number the server counted, beside a name. Three looks: subtle (the default), strong (Ink, for the count of the view you are in) and on-crimson (for a count on the crimson of the menu). A 0 that was read is drawn quiet, and a count that was not given is not drawn at all, never as 0. The figure is never capped."
    >
      <div className="showcase-kit-grid">
        <Specimen label="Subtle, the default: 0, 7 and 12,480">
          <div className="showcase-kit-row">
            <CountBadge count={0} meaning="waiting for confirmation" />
            <CountBadge count={7} meaning="waiting for confirmation" />
            <CountBadge count={12480} meaning="waiting for confirmation" />
          </div>
        </Specimen>
        <Specimen label="Strong, for the current view: 0, 7 and 12,480">
          <div className="showcase-kit-row">
            <CountBadge variant="strong" count={0} meaning="confirmed" />
            <CountBadge variant="strong" count={7} meaning="confirmed" />
            <CountBadge variant="strong" count={12480} meaning="confirmed" />
          </div>
        </Specimen>
        <Specimen label="On crimson, as on the current entry of the menu: 7 and 0">
          <div className="showcase-kit-row">
            <span className="showcase-kit-crimson">
              Pickup requests
              <CountBadge variant="on-crimson" count={7} meaning="waiting for confirmation" />
            </span>
            <span className="showcase-kit-crimson">
              Manifests
              <CountBadge variant="on-crimson" count={0} meaning="waiting for a rider" />
            </span>
          </div>
        </Specimen>
        <Specimen label="No count given: nothing is drawn, and it is not a 0">
          <div className="showcase-kit-row">
            <span>Needs decision</span>
            <span>All</span>
          </div>
        </Specimen>
      </div>
    </KitSection>
  );
}

const PEOPLE = [
  { name: 'Ama Mensah', role: 'Hub officer, Accra Central' },
  { name: 'Kofi Boateng', role: 'Rider' },
  { name: 'Esi Ama Owusu', role: 'Platform Admin' },
] as const;

function AvatarSpecimens() {
  return (
    <KitSection
      title="Avatar"
      note="A person's tile, with the radius of the controls and not a circle. The initials are the first letter of the first and of the last word of the name, in text.secondary on surface.selected; a picture is drawn once it has loaded and is never required. Beside a name an avatar is decoration, so the name is read once."
    >
      <div className="showcase-kit-grid">
        <Specimen label="Sizes: 24, 32 and 40px">
          <div className="showcase-kit-row">
            <Avatar name="Ama Mensah" size="sm" />
            <Avatar name="Ama Mensah" size="md" />
            <Avatar name="Ama Mensah" size="lg" />
          </div>
        </Specimen>
        <Specimen label="Initials: two words, one word, three words, and no name">
          <div className="showcase-kit-row">
            <Avatar name="Ama Mensah" />
            <Avatar name="Kofi" />
            <Avatar name="Esi Ama Owusu" />
            <Avatar name={null} />
          </div>
        </Specimen>
        <Specimen label="Beside a name in a list (sample people)">
          <ul className="showcase-kit-people">
            {PEOPLE.map((person) => (
              <li key={person.name}>
                <Avatar name={person.name} />
                <span>
                  <strong>{person.name}</strong>
                  <span className="showcase-kit-people__role">{person.role}</span>
                </span>
              </li>
            ))}
          </ul>
        </Specimen>
        <Specimen label="A picture, once it has loaded (the favicon stands in for a photograph)">
          <div className="showcase-kit-row">
            <Avatar name="Ama Mensah" src="/favicon.svg" size="lg" />
            <Avatar name="Ama Mensah" src="/favicon.svg" />
          </div>
        </Specimen>
        <Specimen label="Standing on its own, named for a screen reader">
          <div className="showcase-kit-row">
            <Avatar name="Ama Mensah" alone />
            <Avatar name={null} alone />
          </div>
        </Specimen>
      </div>
    </KitSection>
  );
}

/** Badges and avatars (COMPONENT_PATTERNS, *StatusBadge*, *CountBadge* and *Avatar*; the second half of redesign step R5). */
export function BadgesGroup() {
  return (
    <>
      <StatusBadgeSpecimens />
      <CountBadgeSpecimens />
      <AvatarSpecimens />
    </>
  );
}
