/**
 * The launch hub (MIGRATION_AND_SEEDING.md section 4: at least one hub, `CONFLICT-023`). The settings inventory names it "the Accra
 * hub" throughout, and that is the only name the specifications give it. Its **default zone** is not seeded: the hub table holds an
 * id and a name, the service-zone catalogue (seven zones, settings.md section 7.2) belongs to hub, zone and pricing
 * administration (slice 014), and no zone table exists in this slice (a finding for the Product Owner in the S0.9 handoff).
 */
export interface HubSeed {
  readonly id: string;
  readonly name: string;
}

export const HUBS: readonly HubSeed[] = [
  { id: '5eed0100-0000-4000-8000-000000000001', name: 'Accra' },
];
