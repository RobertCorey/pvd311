# Engine ↔ portal sync — how we stay consistent (2026-08-23)

The city portal is the source of truth; our DB is a cache of intent + what we last saw. These are the rules that keep them from disagreeing (from `docs/research-facade-apps-2026-08.md` P0s, verified live 2026-08-23).

**Facts about the portal we rely on**
- A draft is created on Step 1 submit and is the case record itself (same GUID). Drafts are undeletable by constituents.
- The PVD number is assigned at draft creation. The running New-Request wizard does not show it; `my-requests/Edit-Request/?id=<GUID>` does (`input#title` = "PVD2026-87687 Pothole Report"). We read it from a side tab at draft-save time and again right before Submit → `portalDraft.caseId`, `portalCaseIdCandidate`.
- My Requests is a Fluent DetailsList with no GUIDs in the markup; rows are matched by PVD number only. Drafts appear there with status "Draft".

**Rules**
1. **Check-before-create.** If a report has `portalDraft.caseId`, look it up in My Requests first. Status ≠ Draft ⇒ an earlier attempt already filed it: record `submitted` with that number, log `submit.already_filed`, never run the wizard again.
2. **Case id is confirmed, never guessed.** After Submit we confirm the known number left Draft. No "first row" reads. If we can't confirm, the report is `submitted` with `caseIdPending: true` (admin shows it), detail "case number pending".
3. **Watcher reconciles pending ids** every 30 min by the candidate number: left Draft ⇒ confirm (`watcher.case_confirmed`); still Draft ⇒ the submit did not take ⇒ re-queue to resume the draft (`watcher.draft_not_submitted`).
4. **One tick at a time.** The engine lock is a compare-and-set on `meta/engine` (Firestore `currentDocument.updateTime` precondition); overlapping crons cannot both submit.
5. **Terminal statuses** are `Resolved|Closed|Completed|Cancelled|Canceled|Rejected|Withdrawn` (`TERMINAL_PORTAL_STATUS`): they drive the resolved mail, photo retention (30 days after), and `/api/stats.resolved`.
6. **Proofs** (viewport JPEG at submit / already-filed / inspect) live in Firestore `proofs/{reportId}_{name}`; failures are logged as `proof.failed` events; admin reads them at `GET /api/admin/reports/:id/proofs[/:name]`.
7. **Reconcile pass** (`runReconcile`, in `runWatcher` after the status diff; **flagged `RECONCILE_ENABLED`**, default off). A full My Requests scan → three typed discrepancies, keyed on the PVD number (rows expose no GUIDs; the write-only `ref:<report.id>` in each description is the guarantee a numbered row is ours, and every candidate report already carries that number as `portalCaseIdCandidate`/`portalDraft.caseId`, so we join on it):
   - **(a) Adopt.** A non-submitted report (`failed`/`rejected`/`auto-rejected`/`awaiting_review`, never the in-flight `pending`/`processing`) whose number shows as a **non-Draft** row ⇒ bind the number, set `submitted`, patch `portalStatus` from the row, record a `review` (`by: 'reconcile'`), log `reconcile.adopted`. Reporter-cancelled reports are never resurrected.
   - **(b) Stranded drafts.** A **Draft** row older than 24h whose report is `failed`/`rejected` ⇒ listed (drafts are undeletable — we cannot clean them), log `reconcile.stranded`. No status write.
   - **(c) Missing.** A `submitted` report with a `portalCaseId` no longer in the scan ⇒ flagged, log `reconcile.missing`. No status write.
   - Writes a snapshot to **`meta/reconcile`** `{ at, adopted: string[], stranded: string[], missing: string[], scanned }` — all three arrays are **PVD case numbers**; per-report `reconcile.*` events carry the `reportId` for drill-down. **Never writes `failed`.** Idempotent across ticks: adopt leaves the candidate set once submitted; stranded/missing events fire only on first appearance (diffed against the prior `meta/reconcile`). A **0-row scan** is treated as a transient error (`reconcile.empty_scan`), never as "everything vanished". Caveat: the scan shares the watcher's `MAX_PAGES=20` horizon, so a case past page 20 can transiently appear `missing` and self-heals (`reconcile.reappeared`) when it comes back into view.

**Still open (next ICs):** wire `RECONCILE_ENABLED` on after a supervised first run; a golden-controls drift canary per case type; sync numbers on the admin System tab (pending ids, stranded drafts, last reconcile — reads `meta/reconcile`).
