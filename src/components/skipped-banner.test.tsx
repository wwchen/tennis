import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SkippedBanner } from './shared';

/**
 * The visible half of the read-path fix. Isolating a malformed swing is only an
 * improvement if the reviewer is told the session is short — otherwise 41 of 42
 * swings still reads as a complete session, which is the same silence in a
 * smaller size.
 */
describe('SkippedBanner', () => {
  it('renders nothing when every swing was readable', () => {
    const { container } = render(<SkippedBanner skipped={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('counts one unreadable swing in the singular', () => {
    render(<SkippedBanner skipped={[{ dir: 'swings/swing_007', reason: 'bad stroke' }]} />);
    expect(screen.getByText('1 swing could not be read')).toBeInTheDocument();
  });

  it('counts several, and names them where a reviewer can find them on disk', () => {
    render(
      <SkippedBanner
        skipped={[
          { dir: 'swings/swing_007', reason: 'bad stroke' },
          { dir: 'swings/swing_031', reason: 'no frames' },
        ]}
      />,
    );
    expect(screen.getByText('2 swings could not be read')).toBeInTheDocument();
    // The dirs and reasons belong in the title: a reviewer cannot act on them,
    // but whoever they hand the tree to can.
    expect(screen.getByTitle(/swings\/swing_007: bad stroke/)).toBeInTheDocument();
    expect(screen.getByTitle(/swings\/swing_031: no frames/)).toBeInTheDocument();
  });
});
