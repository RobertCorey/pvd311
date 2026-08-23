# Portal simulator + test harness

A Power-Pages-shaped **fake** of the Providence 311 portal, plus a real-Chromium harness, so the
production wizard driver in `worker/src/portal.ts` runs **end-to-end, deterministically, with zero
traffic to `311.providenceri.gov`**. A mutation suite then proves the driver fails **loud** when the
portal's DOM contract drifts.

## Run

```bash
cd worker && npx vitest run          # runs pure/api + portal.sim + portal.mutations
cd worker && npx vitest run test/portal.sim.test.ts test/portal.mutations.sim.test.ts   # just the sim
cd worker && npm run typecheck       # unchanged; tsconfig only covers src/
```

The sim tests take a few minutes: they launch a real headless Chromium per driver instance and the
driver's own fixed `waitForTimeout`s (login, lazy grid, modal) dominate. Nothing hits the network.

## The seam (why this is not `@cloudflare/playwright`)

The driver imports `launch` from `@cloudflare/playwright`. That `launch()` connects over a Cloudflare
**Browser Rendering** binding (`env.BROWSER`), and the package's bundled `playwright-core` deliberately
**stubs `child_process.spawn`** — locally it throws `spawn not implemented`. It also imports the
Workers-only virtual module `cloudflare:workers`, which does not resolve under Node/vitest.

So the tests:

1. `vi.mock('@cloudflare/playwright')` and route the driver's `launch()` to a **real** Playwright
   Chromium (`test/sim/browser.ts`). We do **not** add a dependency to `worker/package.json`; we
   resolve a Playwright build that already exists in the repo (`worker/` → `app/` →
   `legacy/automation/` node_modules, first found wins). If none exists the tests throw a clear error.
2. Point `PORTAL_BASE_URL` at the local sim (`http://127.0.0.1:<port>`). The real Chromium then speaks
   plain HTTP to localhost. Everything between login and `parseRow` is the **unchanged production code
   path**; only the browser transport is swapped.

`test/sim/browser.ts` is the one place that knows about this substitution.

## Files

| File | Role |
|---|---|
| `sim/server.ts` | Node `http` server rendering the portal DOM + `/_sim/*` controls. |
| `sim/browser.ts` | Resolves a real Playwright `chromium` from the repo (the seam). |
| `sim/harness.ts` | Stub `Env`, in-memory `AuthStore`, `ReportDoc` factory, a tiny data-URL JPEG. |
| `sim/fixtures/step3/<category>.html` | Per-case-type Step-3 conditional-control snapshots. |
| `../portal.sim.test.ts` | Happy path: login → wizard → submit, draft resume, `readMyRequests`, `canary`, scout. |
| `../portal.mutations.sim.test.ts` | Drift/chaos suite: every mutation must fail loud. |

## DOM contract the sim implements (keep this honest against `src/portal.ts`)

Everything below is what the driver's selectors expect. If the driver changes a selector, change the
sim to match (and vice-versa the real portal — that's what the live canary is for).

**Auth** — `GET /my-requests/` shows a `.username` element only when the `sim_auth` cookie is set;
unauthenticated it omits it, so the driver falls through to `/SignIn` (`#Username`,
`#PasswordValue`, `#submit-signin-local`). `POST /SignIn` sets the cookie and 302s to `/` (which also
carries `.username`). Auth is persisted through Playwright `storageState`, so a second driver instance
resumes logged in.

**Step 1** — `GET /my-requests/New-Request/`: `#casetypecode` (values `1/2/3/585680001`), the case-type
launcher `button[aria-label="Choose an Issue (Case Type) Launch lookup modal"]`, `#cop_methodofupdate`
(incl. `585680003`), `#NextButton`, and the honeypot `input[id^="frm_pref_"]` labeled *"Leave this
field blank"*. The launcher opens `.modal.fade.modal-lookup.in` containing `.query.form-control`,
`button[aria-label="Search Results"]`, `button[aria-label="Cancel"]`, `.primary.btn.btn-primary`
(`aria-label="Select"`), and a `<table><tbody>` seeded from
`scripts/case-type-census-2026-08-21.json` as `tr[data-id="<GUID>"]` rows, each with a
`span[role="checkbox"]`. The search box filters by name (`*wildcard*` → substring). Selecting a row +
Select writes the GUID into a hidden field and removes the modal (`.modal.in` detaches). `#NextButton`
posts the form and 302s to `?stepid=step2&id=<entityId>` (URL contains `stepid`). The step-2/3 pages
carry `#EntityFormView_EntityID`.

**Step 2** — `?stepid=step2`: `#addressIn` (JS autocomplete → `tr.suggestRow > td.suggestData`; clicking
a suggestion fills hidden `cop_address`/`cop_street1`/`cop_city`/`cop_stateorprovidence`/`cop_zip…`/
`cop_country…`/`cop_latitude`/`cop_longitude`). `#NextButton` posts and 302s to `?stepid=step3&id=…`.

**Step 3** — `?stepid=step3`: `#description` textarea, the honeypot, the per-case-type conditional
controls from `fixtures/step3/<category>.html`, `#AttachFile` (file input), and `#NextButton`
(`value="Submit"`). Submit is an **AJAX** `POST /submit` (matching Power Pages' unobtrusive postback):
200 → the page navigates to `/my-requests/New-Request/confirmation?case=PVD2026-#####`; non-200 → the
page stays put, shows `.validation-summary-errors`, and keeps `#NextButton` value `Submit` — exactly
the two branches `fillStep3` distinguishes.

**Case-id / draft model** — the portal assigns the PVD number when the **draft is created** (the Step-1
postback), not at submit. The running wizard never shows it, but `GET /my-requests/Edit-Request/?id=<GUID>`
renders it in `input#title` (`"PVD2026-##### <Case Type>"`) — which is what `readDraftCaseId` scrapes
from a side tab. On Step 1 the sim drops a **Draft** row into the grid keyed by its entity GUID; the
submit AJAX **converts** that same row (Draft → Submitted). So `extractCaseId(candidate)` confirms by an
**exact case-id row match** (never "the first row"), and a draft that never converts yields `undefined`,
not a fabricated id.

**My Requests grid** — `GET /my-requests/`: `[role="grid"]` with a header `[role="row"]` of
`[role="columnheader"]` (Request / Street / Status Reason / Created On / Actions) and data
`[role="row"]`s of `[role="gridcell"]`, each stamped with `data-id="<entity GUID>"` (the only
position-independent key). A **Draft** row renders `Draft — <Case Type>` with **no** PVD number (so
`parseRow` returns null and the driver keys it by GUID); a converted row renders `PVD2026-##### <Case
Type>`. Seeded with a Draft row, a converted-draft (Submitted) row, and an Assigned row. A disabled
`.pagination` pager keeps it single-page.

## `/_sim` control endpoints

- `GET /_sim/reset` — reset to the golden seed.
- `GET /_sim/mutate?name=<m>&<params>` — arm a mutation (see below).
- `GET /_sim/state` — JSON `{ submitPosts, casesCreated, step1Posts, step2Posts, signInPosts, mutations, cases }`.

Tests use the equivalent in-process `sim.reset()/mutate()/snapshot()` for speed; one test exercises the
HTTP endpoints directly.

## Mutations (each must fail loud — never a green submit)

| `name` | What drifts | Driver's loud failure |
|---|---|---|
| `rename-control` (`from`,`to`) | a Step-3 control id changes (`cop_size`→…) | unmapped control → real scout with no key → **`NEEDS_MAPPING`** |
| `add-required` | an unseen required Step-3 control appears | unmapped control → **`NEEDS_MAPPING`** |
| `change-label` (`from`,`to`) | a radio option's `aria-label` changes | mapped value matches no option → **`NEEDS_REVIEW`** |
| `drop-next` | Step-3 `#NextButton` disappears | submit click **times out** |
| `submit-500` | the submit postback 500s | `.validation-summary-errors` path → **"validation failed"** throw |
| `dup-case` | the draft never converts (stays Draft) | `extractCaseId` exact-match confirm fails → `caseId` **`undefined`**, `caseIdConfirmed:false` |

The suite asserts `casesCreated === 0` in **every** case (the sim converted no real city case), plus the
appropriate `submitPosts` (0 before the Submit click; 1 for `submit-500`/`dup-case`).

## Seams I needed in `worker/src`

**None.** The driver ran unmodified. The only substitution is at the module boundary
(`vi.mock('@cloudflare/playwright')`), not in `src/`.

## Note for the driver owner

- **The positional case-id gap is already closed in `src`.** This harness was written against a driver
  that now assigns the PVD at draft creation, reads it via `Edit-Request/input#title`, and confirms via
  an **exact case-id row match** (`extractCaseId(candidate)` + `findMyRequestByCaseId`), plus
  check-before-create and `caseIdConfirmed`/`alreadyFiled`. The sim implements that full contract, so the
  new safety paths are exercised (see `portal.sim.test.ts` "check-before-create" and the resume test).
- **One real dangling-promise on the failure path.** `fillStep3` arms
  `navPromise = page.waitForFunction(location.href !== before)` *before* clicking Submit and never awaits
  or cancels it on a validation/timeout failure. When the caller then `close()`s the browser, that
  promise rejects with Playwright's benign `Target ... has been closed` — an unhandled rejection. In the
  Worker's per-tick lifecycle it's swallowed by teardown, but it's a latent leak. The mutation tests
  work around it by driving one grid read (which fulfils the wait) before closing; the clean fix is in
  `src` — await/cancel `navPromise` on the throw paths. (No `src` change made here.)
