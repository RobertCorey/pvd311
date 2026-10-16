# City questions that heal themselves — plan (Rob, 2026-10-16)

**Goal.** Every live filing teaches us about that category's city form. The system compares what it learned against how the app handles that category, shows the gaps, and lets one click turn a gap into an in-app question. No per-category code. ("Every time a reporter triggers a noise complaint run we have more data about noise complaints; check it against the app and update.")

## What we already have

- **The full map, today.** The city's Step-3 page carries one inline switch: case-type GUID → the questions it shows. 30 case types; 27 of our 88 categories map to one. Each question comes with its exact choices. Readable any time, read-only: `GET /admin/controls?entityId=<draft>&page=1`.
- **Per-filing confirmation.** Every live submit dumps the Step-3 controls it saw. The first one for a category mints `controls_<category>` ("Minted live golden for noise from submit").
- **Per-filing outcome.** For each question we see:
  - answered from the app (`category.fields`, 4 categories);
  - answered by the AI scout (≥ 0.7 sure);
  - left blank: the scout was unsure, logged as the `submit.left_blank` event.

## Design

1. **One record per category: `cityQuestions/{category}`.**
   - **Seeded once** from the page's switch, so all 27 are known now, before any filing.
   - **Each question** `{ id, cityLabel, cityOptions[], lastSeenLive, mode }`, where `mode` is one of `app | ai`.
   - **Optional app overrides:** `appLabel` and `appOptions[]`, each mapped 1:1 to a city option. These are friendlier words for users, e.g. "A business" → `Business (add name to description)`.
2. **Audit after every filing**, comparing that filing's live controls with the record. It flags:
   - **new question:** the city added one;
   - **gone:** the city removed one;
   - **options changed:** any app option whose city value no longer exists;
   - **stale test copy:** the sim fixture disagrees with live, as with noise today (`cop_noisesource` vs live `cop_whereisthenoisefrom`). This check runs in CI against the stored snapshots.

   Each flag is logged as a `questions.drift` event and shows up in the daily digest.
3. **Auto-heal = never send a stale answer.** If a question in `app` mode has an option the city no longer offers, it suspends itself back to `ai` mode (the AI guesses, or the question is left blank) and alerts Rob. Filing never breaks, and the city never gets a value it doesn't accept.
4. **One generic mapping in the engine.** If `report.extra[<city question id>]` holds one of the current city options, set that control. This replaces per-category `fields` for new questions; the 4 existing mappings keep working.
5. **The app reads questions from the API.** `GET /api/questions` is cached. After the address, ask each `app`-mode question for the chosen category as taps, plus **"Not sure"**, which leaves it to the AI, then blank. The answer is sent in `extra`.
6. **/admin → "City questions" tab.**
   - **Table:** one row per category × question, ranked by `blanks × demand`, with columns:
     - how it's answered today (app / AI / blank, with counts);
     - last seen live;
     - drift flags.
   - **Row actions:** "Ask in app" (with editable friendly labels) and "Stop asking".

## Phases

1. **See it.** Seed `cityQuestions` from the page switch; per-filing audit + drift events; the read-only /admin table; the digest line. *No user-facing change.*
2. **Heal it.**
   - the generic engine mapping;
   - `/api/questions`;
   - app rendering + "Not sure";
   - the "Ask in app" / "Stop asking" toggles;
   - auto-suspend on stale options.

   **First use: noise** ("Where is the noise coming from?": a house · a business · a car · a park · somewhere else · not sure).
3. **Tidy.** Move the 4 hand-coded mappings (pothole size, carts, animal type, vehicle details) into the same records; fix the sim fixtures from the stored live snapshots.

## Decisions for Rob

- **Spanish.** City choices are English only. Should the toggle auto-translate the friendly labels for review, or ask in English until a translation is entered?
- **Business or park name.** When the city's option says "(add name to description)", should the app add a short text prompt for the name? (Proposed: yes.)
- **Default for newly discovered questions.** Stay in `ai` mode until someone clicks? (Proposed: yes; nothing reaches users unseen.)
