/**
 * The people of the journeys (S0.45). They exist in no database until a journey makes them, except the two bootstrap administrators,
 * whom the stack seeds with the real `bootstrap:seed` (MIGRATION_AND_SEEDING.md §3.2: "two bootstrap Platform Admins, each with their
 * own work email"). Names and addresses are fixed so that a failure can be read and reproduced; they belong to nobody, and the address
 * domain is the reserved `.example`, so no message could ever reach anyone (and nothing leaves the machine anyway: the capture sink
 * reaches nobody).
 */
export interface Person {
  readonly fullName: string;
  readonly workEmail: string;
}

/** The two bootstrap Platform Admins of every journey run, in the order the seed receives them. */
export const ADMINISTRATORS: readonly [Person, Person] = [
  { fullName: 'Ada Admin', workEmail: 'ada.admin@melarc.example' },
  { fullName: 'Bola Admin', workEmail: 'bola.admin@melarc.example' },
];

/** A custodian as `bootstrap:seed --custodian` takes one: `Full Name <work@email>`. */
export function custodianArgument(person: Person): string {
  return `${person.fullName} <${person.workEmail}>`;
}

/** Both administrators as the two `--custodian` arguments of `bootstrap:seed`. */
export const ADMINISTRATOR_ARGUMENTS: readonly [string, string] = [
  custodianArgument(ADMINISTRATORS[0]),
  custodianArgument(ADMINISTRATORS[1]),
];
