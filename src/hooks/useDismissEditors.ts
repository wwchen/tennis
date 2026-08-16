import { useEffect } from 'react';

/** Chip titles that open an editor — a click on one must not also close it. */
const OPENERS = '[title="Click to change player"], [title="Click to change stroke"]';

/**
 * Closes the inline stroke/player editors when the pointer or Escape lands
 * outside them.
 *
 * Listeners are attached in the capture phase on `document` rather than via an
 * overlay: the editors are `<select>`s scattered through a scrolling table, and
 * a blur handler alone misses the case where one opens while another is already
 * open. `mousedown` and `click` are both bound because the native select
 * swallows one or the other depending on platform.
 */
export function useDismissEditors(active: boolean, dismiss: () => void): void {
  useEffect(() => {
    if (!active) return;

    const onPointer = (e: Event) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      if (target.closest(OPENERS)) return;
      if (target.closest('[data-stroke-edit], [data-player-edit]')) return;
      dismiss();
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss();
    };

    document.addEventListener('mousedown', onPointer, true);
    document.addEventListener('click', onPointer, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onPointer, true);
      document.removeEventListener('click', onPointer, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [active, dismiss]);
}
