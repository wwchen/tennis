// Single entry point for the design system, so no component file has to know
// where the sprite sheet lives or repeat the event-target casts below.
import iconsHref from '@lew-ds/open-icons/icons.svg?url';

export {
  Avatar,
  Button,
  Icon,
  Menu,
  SegmentedControl,
  Select,
  Tag,
  Textarea,
  TextField,
  Toggle,
} from '@lew-ds/lds-react';

export type { Hue } from '@lew-ds/lds/templates';

/** `iconHref`/`href` value every LDS icon consumer needs. */
export const ICONS: string = iconsHref;

// LDS types its change handlers as taking a bare DOM `Event` — the templates are
// framework-free, so there is no synthetic-event layer to carry a typed target.
// These two narrow it once, here, instead of at ~20 call sites.
export const valueOf = (e: Event): string =>
  (e.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value;

export const checkedOf = (e: Event): boolean => (e.target as HTMLInputElement).checked;
