import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FrameTile } from './shared';

const cell = {
  real: true as const,
  key: 'k',
  clip: 'IMG_0304/swing_001',
  frame: 0,
  num: 'f01',
  phase: null,
  flagged: false,
  pinCount: 0,
  selected: false,
};

describe('FrameTile', () => {
  it('renders the frame image when one is available', () => {
    render(
      <FrameTile
        cell={{ ...cell, imageUrl: '/api/media/IMG_0304/swings/swing_001/frames/frame_0020.jpg' }}
        onClick={() => {}}
      />,
    );
    const img = screen.getByRole('presentation');
    expect(img).toHaveAttribute(
      'src',
      '/api/media/IMG_0304/swings/swing_001/frames/frame_0020.jpg',
    );
    expect(img).toHaveAttribute('loading', 'lazy');
  });

  it('renders no image for a seeded clip, leaving the painted tile alone', () => {
    render(<FrameTile cell={cell} onClick={() => {}} />);
    expect(screen.queryByRole('presentation')).toBeNull();
  });
});
