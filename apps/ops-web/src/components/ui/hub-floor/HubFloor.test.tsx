import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { HubFloor } from './HubFloor';

describe('HubFloor', () => {
  // Break caught: a scope that draws none of its children, or one whose class is not the one the stylesheet's rules are written against (the touch height would then be drawn nowhere).
  it('draws its children inside the floor’s scope and adds nothing else', () => {
    render(
      <HubFloor>
        <p>Inside the floor</p>
      </HubFloor>,
    );

    const inside = screen.getByText('Inside the floor');
    expect(inside.parentElement).toHaveClass('ui-hub-floor');
    expect(inside.parentElement?.children).toHaveLength(1);
    expect(inside.parentElement?.getAttributeNames()).toEqual(['class']);
  });
});
