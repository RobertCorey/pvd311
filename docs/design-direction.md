# FixMyPVD — Design Direction: "Ember & Harbor"

> Owner: design lead (2026-08-22). Supersedes `product-spec.md` §2 (brand) wherever they differ. Decided, not optioned. Product name: **FixMyPVD** (spec §1).
> Constraint set (unchanged): AA / Lighthouse 100 a11y, perf ≥ 90 (target 99), ≤ 2 font families, en/es strings in `src/i18n`, category-first flow, < 45 s happy path, no AI category guessing.

## The idea in one line

**A two-ink Providence screen print.** Harbor navy + WaterFire ember on cream paper (dark mode: the same two inks on harbor night). Providence is an art-school town with a poster-board culture — AS220, RISD, WaterFire braziers on black water, Benefit Street clapboard. That's the feel: *community-printed*, warm, a little hand-set. Not a SaaS dashboard, not a city seal.

## Palette (2 inks + paper; status colors are functional only)

| Token | Light | Dark | Role |
|---|---|---|---|
| `--bg` (paper) | `#F7F1E6` | `#0C1222` | app ground |
| `--surface` | `#FFFCF7` | `#161E33` | cards, sheets |
| `--ink` (harbor) | `#16213A` | `#F3ECE0` | text, strokes, the wordmark |
| `--ember` | `#F4652A` | `#FF7A3A` | **the** action color: Take photo / Send, selected tile, map pins, current tracking step. Text on it is always `--ember-ink` (`#16213A` / `#0C1222`) — never white. |
| `--ember-text` | `#BD3F12` | `#FF8A4F` | ember as *text* (labels, links inside ember cards) |
| `--link` (river) | `#1D5C99` | `#8FC3FF` | inline links only |
| `--muted` | `#5A6275` | `#A3ABBE` | secondary text |
| `--line` | `#E3DACB` | `#273050` | borders |
| `--success / --warn / --danger` | `#1B6B45 / #9A4B00 / #B42318` | `#4ADE96 / #F5B65B / #FF7B70` | status only |

All pairings above verified ≥ 4.5:1 (lowest: ember-text on paper 4.81, ink on ember 5.14). Light and dark are the *same two inks swapped onto different paper* — so the brand reads identically in both.

**Paper grain:** a 2–3 % opacity SVG noise overlay on `body` (one inline `feTurbulence` data-URI, no image request). Misregistration: duotone icons offset the ember plate 1.5 px down-right from the navy plate — the riso tell.

## Type

- **Display:** **Bricolage Grotesque** 700/800 (Google Fonts, optical sizes) — wordmark, tile labels, headlines, buttons. Tight tracking (`-0.02em`), large sizes. Characterful without being a novelty face.
- **Body:** **Inter** 400/500/600 — unchanged (legibility, already cached).
- **Mono moment:** the PVD case number is set in `ui-monospace` as a stamped ticket slug — the one place the "official" system pokes through.

## Motion (all gated by `prefers-reduced-motion`)

- Tile press: scale 0.97 + ember flood 120 ms; the chosen tile *becomes* the chip (shared-position feel via the chip fading in at top).
- Phase A → B: content slides up 16 px / fades 180 ms.
- Tracking rail: current step has a 2 s ember pulse ring; steps fill left-to-right on load (stagger 60 ms).
- Map: pins drop in with a 240 ms ease-out bounce, staggered 30 ms; open pins carry a slow pulse halo; list rows fade-up on load.
- Nothing loops except the pulse halos; no parallax, no spinners (skeletons only).

## Component language

- **Shell:** slim top bar (mark + wordmark, "Not the city" microtag). **Bottom tab bar** on phones — Report (ember button, center), Map, Mine — thumb-reachable; hidden while a report is in progress (the sticky Send bar takes the bottom). Footer keeps disclaimer + About/Privacy/portal/language.
- **Category tiles** are the product: 2-col grid, 120 px tall, surface card with a 2 px ink border, a 44 px *duotone* icon (navy line + ember plate offset), label in Bricolage 1.05 rem. Selected/pressed = ember fill + ink text. "Other / something else" is a wide dashed tile. Seasonal snow tiles get a small "Winter" tag.
- **Photo card:** the Take-photo button is the biggest ember element on screen (64 px). Preview gets ember corner brackets — "this spot".
- **Tracking = package tracking:** a ticket card (status headline, case slug, ETA line) over a 4-step rail **Received → Sent to city → City working → Resolved** (Cancelled/Needs attention render as a warn branch on the rail). Timeline below keeps the exact timestamps. Details card = photo with bracket frame + category + address.
- **Map:** CARTO Voyager (light) / Dark Matter (dark) raster tiles instead of default OSM, branded duotone pins colored by status (ember = open, success = resolved, warn = cancelled/needs attention), a stat strip above the map ("12 open · 3 resolved this week"), list rows with ink glyphs.
- **Illustrations / empty states:** one SVG street scene in the two-ink style (triple-decker, street light, pothole, crow on a wire) reused with masks: My reports empty, 404, map empty, offline-queued. Flat paths, no gradients, < 4 KB each.
- **Logo / mark:** harbor-ink map pin carrying an **×** — X marks the spot to fix — over an ember circle printed off-register. No camera pun anywhere (the name is FixMyPVD, decided 2026-08-22). Wordmark "FixMyPVD" in Bricolage 800, "FixMy" in ink, "PVD" in ember. App tile: cream ground, mark centered (maskable-safe), favicon = mark on ember.

## Three before → after notes

1. **Home.** Before: "What's the problem?" over eight identical white cards with a small teal glyph in a box — reads like a settings page. After: the grid is the hero; big two-ink icons, display-type labels, ember press state, tab bar with the Report button under your thumb — it reads like a poster of Providence street problems you tap.
2. **Tracking.** Before: a status card + a generic dot timeline. After: a ticket with a stamped case number, a parcel-style progress rail with the current step pulsing, an ETA line — you know *where your report is* at a glance.
3. **Map.** Before: default OSM tiles + generic pins + plain list. After: themed CARTO tiles, branded pins that drop in and pulse while open, a stat strip — the city feels alive and the page feels like ours.

## Rollout (small commits on `main`)

1. Tokens + fonts + grain + buttons (`tokens.css`, `index.css`, `index.html`).  2. Mark + wordmark + icons (`BrandMark`, `public/icons/*`, `og-image`).  3. Duotone category icon set + tiles (`CategoryIcon`, `Report.css`).  4. Shell: tab bar (`Layout.tsx`, strings).  5. Tracking rail (`Track.tsx/.css`).  6. Map tiles + pins + stat strip (`MapView`, `Feed`).  7. Illustrations + empty states.  8. Spec §2 updated to point here.
