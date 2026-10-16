# Reporter quota (Rob, 2026-10-16)

**Why.** Every report is filed under FixMyPVD's one city 311 account. One person flooding the city makes *FixMyPVD* look like a spam source and can cost everyone the account. The quota exists to protect that standing ("we don't want to be a spam platform"). It is enforced by the server and visible to the reporter.

## Rules

| | Standard | Raised (admin-granted) |
|---|---|---|
| Per day (resets 00:00 America/New_York) | **5** | 20 |
| Per week (resets Monday 00:00 America/New_York) | **15** | 60 |
| Min gap between reports | **60 s** | 60 s |

- **Identity.** Keep the existing `paceIdentity` (mailbox: lowercase, `+tag` stripped, gmail dots collapsed) so alias accounts share one quota.
- **IP backstop.** Keep a per-IP check, but loose: 30/day, no weekly limit, no gap. Shared networks (libraries, offices, cell carrier NAT) must not block real people.
- **What counts.** Every accepted `POST /api/report`, including reports later rejected (in review or by moderation). That's Rob's call: rejection must not be a way around the quota.
- **Refund.** A report the reporter cancels (`POST /api/reports/:id/cancel`) before it's filed gives its slot back, for both the day and the week it was counted in.
- **Not in scope now.** Server-side duplicate detection; the client's nearby-duplicate prompt is unchanged. The engine's global `MAX_PER_HOUR = 15` portal pacing stays as the backstop above all users.
- **New accounts.** Unchanged: the HITL ramp (ACCOUNT_TRUST_N=1) still sends the first report to review.

## API

- `GET /api/me` adds `quota: { dayUsed, dayLimit, weekUsed, weekLimit, dayResetsAt, weekResetsAt, nextAllowedAt, raised }`, with times in ISO UTC. The server is the only authority; the app only displays this.
- A `429 rate_limited` from `POST /api/report` includes the same `quota` object plus `reason: 'gap' | 'day' | 'week' | 'ip'` and `retryAfterSec`.
- `POST /api/admin/users/:uid/quota` takes `{ raised: boolean }` and writes `users/{uid}.quotaRaised` (+ `quotaRaisedBy` / `quotaRaisedAt`), plus an `admin.quota` event. Model it on the existing `/trust` endpoint.

## App

- **Report screen.** Silent while 3+ remain. At ≤2 left: one quiet line, "2 reports left today · resets at midnight". At 0 (day or week): Send disabled, a short reason with the reset time, the draft kept, and a "Need to report more? Contact us" link (mailto rob@fixmypvd.org). The `rate_limited` path shows the same state.
- **Mine tab.** Always shows "This week: N of 15".
- **/admin → Accounts.** A "Raise limits" toggle per account, next to Trust.
- Strings in both `strings.en.json` and `strings.es.json`.

## Tests

- Worker unit tests:
  - day / week / gap / IP limits;
  - the Eastern-time day and week boundaries (incl. a DST date);
  - refund on cancel;
  - raised limits;
  - `/api/me` quota shape;
  - the 429 body.
- App e2e:
  - nothing shown at 3+ remaining;
  - the line at ≤2;
  - Send disabled at 0 with the draft kept;
  - the Mine weekly line;
  - the admin toggle.
