import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import realSwing from '@/domain/__fixtures__/swing-real.json';
import type { EtlSwingDoc } from '@/domain/etl-types';
import { adaptSwing } from '@/domain/etl';
import { DetailView } from './DetailView';

const clip = adaptSwing(realSwing as unknown as EtlSwingDoc);

describe('a clip the ETL left unlabelled', () => {
  it('says untagged where a stroke would go', () => {
    render(
      <DetailView
        clip={clip}
        selectedFrame={0}
        comments={[]}
        roster={['left']}
        playing={false}
        dispatch={() => {}}
      />,
    );
    expect(screen.getByText('untagged')).toBeInTheDocument();
  });
});
