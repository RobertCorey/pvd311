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

**Still open (next ICs):** a full reconcile pass (orphans in My Requests with our `ref:` marker, stranded drafts, id-less submitted rows); a golden-controls drift canary per case type; sync numbers on the admin System tab (pending ids, stranded drafts, last reconcile).
