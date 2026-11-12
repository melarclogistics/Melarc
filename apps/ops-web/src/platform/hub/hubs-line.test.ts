import { describe, expect, it } from 'vitest';

import { hubsLine } from './hubs-line';

const hub = (name: string): { readonly display_name: string } => ({ display_name: name });

describe('where a person acts, in a few words', () => {
  // Break caught: a session of one hub that is told "1 hub", or its name left out, so the foot of the sidebar and My work do not say where the person works.
  it('names the hub of a session that lists one', () => {
    expect(hubsLine([hub('Accra Central')])).toBe('Accra Central');
  });

  // Break caught: a session of several hubs that is given the name of the first, as if it worked in that one alone.
  it('counts the hubs of a session that lists more than one, and names none of them', () => {
    expect(hubsLine([hub('Accra Central'), hub('Tema')])).toBe('2 hubs');
    expect(hubsLine([hub('Accra Central'), hub('Tema'), hub('Kumasi')])).toBe('3 hubs');
  });

  // Break caught: a session that lists no hub that is shown an empty place, "0 hubs" or "undefined".
  it('says nothing for a session that lists none', () => {
    expect(hubsLine([])).toBeNull();
  });
});
