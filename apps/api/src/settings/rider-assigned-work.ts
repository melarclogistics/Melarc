/**
 * Whether a Rider holds a stop or a run (S0.35; `AC-SLICE-000-132`): the Rider's grant of `settings.reason.read` is scoped to
 * **assigned** work, so a Rider reads the reason catalogue only while there is work assigned to them. **No stop or run exists in this
 * slice**, so the answer is false for every Rider and a Rider's read is `PERMISSION_DENIED`: the narrowest reading, and the one the
 * acceptance criterion states ("false while no stop or run exists"). The slice that builds the assignment replaces this one function
 * with a read of it (which will take the Rider's session), in the same change as the table; the use case's one call changes with it.
 */
export function riderHoldsAssignedWork(): boolean {
  return false;
}
