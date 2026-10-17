# Reporter quota (Rob, 2026-10-16)

**Why.** Every report is filed under FixMyPVD's one city 311 account. One person flooding the city makes *FixMyPVD* look like a spam source and can cost everyone the account. The quota exists to protect that standing ("we don't want to be a spam platform"). It is enforced by the server and visible to the reporter.

## Rules

One tier for everyone (no admin-raised limits — Rob, 2026-10-16: "we'll deal with that if we ever need to"):

| | Limit |
|---|---|
| Per day (resets 00:00 America/New_York) | **5** |
| Per week (resets Monday 00:00 America/New_York) | **15** |
| Min gap between reports | **60 s** |

- **Identity.** Keep the existing `paceIdentity` (mailbox: lowercase, `+tag` stripped, gmail dots collapsed) so alias accounts share one quota.
- **IP backstop.** Keep a per-IP check, but loose: 30/day, no weekly limit, no gap. Shared networks (libraries, offices, cell carrier NAT) must not block real people.
- **What counts.** Every accepted `POST /api/report`, including reports later rejected (in review or by moderation). That's Rob's call: rejection must not be a way around the quota.
- **Refund.** A report the reporter cancels (`POST /api/reports/:id/cancel`) before it's filed gives its slot back, for both the day and the week it was counted in.
- **Not in scope now.** Server-side duplicate detection; the client's nearby-duplicate prompt is unchanged. The engine's global `MAX_PER_HOUR = 15` portal pacing stays as the backstop above all users.
- **New accounts.** Unchanged: the HITL ramp (ACCOUNT_TRUST_N=1) still sends the first report to review.

## API

- `GET /api/me` adds `quota: { dayUsed, dayLimit, weekUsed, weekLimit, dayResetsAt, weekResetsAt, nextAllowedAt }`, with times in ISO UTC (`nextAllowedAt` null = can send now). The server is the only authority; the app only displays this.
- A `429 rate_limited` from `POST /api/report` includes the same `quota` object plus `reason: 'gap' | 'day' | 'week' | 'ip'` and `retryAfterSec`.

## App

- **Report screen.** Silent while 3+ remain. At ≤2 left: one quiet line, "2 reports left today · resets at midnight". At 0 (day, week, or the network backstop): Send disabled, a short reason with the reset time ("Daily limit reached (5 reports). Your draft is kept — you can send it after midnight."), and the draft kept. No contact link (Rob, 2026-10-16: "we don't want emails from crazy people"). The `rate_limited` path shows the same state.
- **Disabled Send.** Whenever Send can't send (any block reason — photo, address, outside Providence — or the quota), it looks plainly off: grey fill (`--disabled-bg`), no shadow, not-allowed cursor, label still AA-readable (`--disabled-ink`, 5.7:1), and `aria-disabled="true"` so screen readers announce it. It stays a real button (not `disabled`), so a tap still lands and the reason line underneath explains what's missing.
- **Mine tab.** Always shows "This week: N of 15".
- Strings in both `strings.en.json` and `strings.es.json`.

## Tests

- Worker unit tests:
  - day / week / gap / IP limits;
  - the Eastern-time day and week boundaries (incl. a DST date);
  - refund on cancel;
  - no raised tier (the flag and the admin endpoint are gone);
  - `/api/me` quota shape;
  - the 429 body.
- App e2e:
  - nothing shown at 3+ remaining;
  - the line at ≤2;
  - Send disabled at 0 with the draft kept, no contact link;
  - the disabled styling + `aria-disabled` + label contrast on every blocked Send;
  - the Mine weekly line.
