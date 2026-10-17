/**
 * The Step-3 control shape (portal dumps, goldens, drift canary, city-questions audit).
 *
 * This file used to hold the AI "scout" that filled unmapped city questions from the report; it was removed
 * (Rob, 2026-10-17: "I really don't like the AI automatically filling things in"). A city question is now
 * answered only by the reporter (in-app question → shared/categories.ts `fields`) or a fixed default, else
 * left blank and named in the description.
 */

export interface PortalControl {
  /** Stable id for mapping/diffing: per-session GUIDs in DOM ids are normalized to `{guid}`. */
  id: string;
  /** Raw DOM id (for selectors); absent on goldens/older snapshots. */
  domId?: string;
  label: string;
  tag: 'select' | 'input' | 'textarea';
  type: string | null;
  required: boolean;
  /** Whether the portal is currently SHOWING this control. Step 3 renders the whole control set and
   * toggles per case type via display:none; we dump hidden controls too (visible:false) so the drift
   * canary watches the shared set. Only visible controls are filled at submit time. */
  visible: boolean;
  options?: string[];
  name?: string; // radio group
}
