import { useEffect, useState } from 'react';

/**
 * The width below which the app is a phone rather than a desktop.
 *
 * From the design, which switches layout at 840: below it the two side panels
 * stop being columns — the filters become a drawer over the content and the
 * inspector becomes a sheet rising from the bottom.
 */
export const MOBILE_WIDTH = 840;

/**
 * Whether the viewport is phone-shaped, tracked live.
 *
 * A media query in CSS cannot do this alone: the difference is structural, not
 * cosmetic. The drawer is `position: fixed` with a scrim, the sheet exists only
 * when a frame is selected and carries a drag handle nothing else has, and on a
 * phone the app opens in the catalog rather than the compare grid. Those are
 * different elements, so the decision has to reach the render.
 */
export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < MOBILE_WIDTH,
  );

  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${MOBILE_WIDTH - 1}px)`);
    const sync = () => setMobile(query.matches);
    sync();
    // `matchMedia` rather than a resize listener: it fires only when the answer
    // actually changes, instead of on every pixel of a drag.
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);

  return mobile;
}
