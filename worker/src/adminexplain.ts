/**
 * "How it works" content for the admin Learn tabs — structured so the UI can render sections with live numbers
 * next to the explanation. Kept in code (not a doc) so it can't drift from the behaviour it describes: every
 * constant quoted here is imported from the module that enforces it.
 */
import type { Env } from './contracts.js';
import { CATEGORIES } from '../../shared/categories.js';
import { SUBSYSTEMS } from './health.js';
import { HITL_LINK_TTL_MS } from './email.js';

export interface ExplainSection { key: string; title: string; summary: string; details: string[]; live?: Record<string, unknown>; links?: { label: string; href: string }[] }

export function explainSystem(env: Env, live: Record<string, unknown>): ExplainSection[] {
  const trustN = env.ACCOUNT_TRUST_N ?? '3';
  return [
    {
      key: 'pipeline', title: 'The pipeline, end to end',
      summary: 'A report goes app → Worker API → Firestore → engine (cron, every minute) → human review while the account is new → headless browser on the city portal → case number → status watcher → reporter email.',
      details: [
        'The app (fixmypvd.org) talks only to the Worker API at api.fixmypvd.org. No Firebase SDK in the client; identity is a Firebase Auth ID token the Worker verifies itself.',
        'POST /api/report needs: a signed-in account, a Cloudflare Turnstile pass, a category from the registry, an address, and a photo where the category requires one. Pacing: 1 per 3 min and 5 per day per mailbox, plus per IP.',
        'Every minute the engine tick: reaps anything stuck in "processing" > 20 min, checks the circuit breaker and hourly cap, picks the oldest pending report, runs the gates (category, photo, address, blocked addresses, Providence bbox, duplicate within a few metres of a recent same-category case), runs server-side moderation, then either sends it to you for review or submits it.',
        'Submit = a Chromium on Cloudflare Browser Rendering logging into our portal account and walking the 3-step wizard. The PVD number is read from the draft before Submit and confirmed afterwards by exact match in My Requests.',
        'Every 30 minutes the watcher reads My Requests, diffs city statuses, emails reporters and followers on change, reconciles anything unconfirmed, and scrapes the city public feed for the nearby-dedupe check.',
        'Daily at 7 am ET: digest email, photo retention (deleted 30 days after the city closes a case), event cleanup (14 days), portal canary + Step-3 drift check.',
      ],
      live,
      links: [{ label: 'API contract', href: 'https://github.com/robcorey/pvd311/blob/main/docs/api.md' }, { label: 'Sync rules', href: 'https://github.com/robcorey/pvd311/blob/main/docs/engine-sync.md' }],
    },
    {
      key: 'hitl', title: 'Human in the loop (you)',
      summary: `Mode "${env.HITL_MODE}". In ramp mode an account's first ${trustN} reports come to you; after ${trustN} filed with no human/auto rejections, that account auto-files. Any moderation flag forces review regardless. "review" mode sends everything to you; "auto" sends nothing.`,
      details: [
        `Review email: category → portal case type, address, description (+ original wording if the AI polished it), extra fields, intake flags, reporter. Approve/Reject links are signed (HMAC over action:id:expiry) and expire after ${Math.round(HITL_LINK_TTL_MS / 86_400_000)} days; they are path-form because a quoted-printable decode on the mail path corrupted query-string signatures.`,
        'Approve → back to pending → next tick submits. Reject → "rejected", the reporter gets a short email with your reason if you typed one (admin) or a generic one (email link). Requeue (failed → pending) resumes the same portal draft; it never creates a second case.',
        'Trust toggle on an account bypasses the ramp but never the moderation-flag rule. A report the reporter cancels themselves does not count against their trust.',
      ],
    },
    {
      key: 'moderation', title: 'AI moderation',
      summary: 'Claude reviews the free text twice: once in the app while the reporter types (advisory: flags, wording polish, a reporter-facing note), and once server-side in the engine before any auto-approval (binding: any flag forces human review).',
      details: [
        'Flags: spam, abuse, personal_info, not_311, emergency. The model never chooses the category — the reporter does.',
        'Intake is rate-limited 10/min per IP and 1,500/day globally (Firestore counters) to cap AI spend. The server-side pass runs once per report (moderatedAt) so a client that skips intake cannot bypass review.',
        'If the model errors, the report is treated as flagged (reviewed by you), never auto-filed.',
      ],
    },
    {
      key: 'portal', title: 'The city portal and how we drive it',
      summary: 'Providence 311 is Microsoft Power Pages. We use a real constituent account (pvdsnow@proton.me) and a headless browser; the portal is the source of truth and our database is a cache of intent + what we last saw.',
      details: [
        'Facts the engine relies on: the PVD number is assigned when the draft is created (Step 1) and is readable at my-requests/Edit-Request/?id=<GUID> (input#title); the running wizard does not show it. My Requests has no GUIDs in its markup, so rows are matched by PVD number only. Drafts are undeletable by constituents — every abandoned wizard leaves one.',
        'Wizard: Step 1 picks the case type by GUID from a lookup modal (19 categories mapped from a census of 126 types); Step 2 uses the portal\'s ArcGIS address autocomplete; Step 3 renders ~36 controls and toggles the visible subset per case type. A honeypot field ("Leave this field blank") is never touched. Unmapped visible fields are filled by an AI "scout" with a confidence threshold, else the report needs review.',
        'Safety: check-before-create (if our draft already shows a non-Draft status, adopt it instead of re-filing), an atomic engine lock so overlapping crons cannot both submit, retries resume the same draft, and a circuit breaker pauses everything after repeated failures.',
        'Canary: every night we resume ONE designated existing draft (never create one), walk to Step 3 and diff the control set against a live baseline; a change means the city edited their form and the driver needs a look.',
      ],
      live: { categoriesMapped: Object.keys(CATEGORIES).length },
    },
    {
      key: 'sync', title: 'Keeping our records honest',
      summary: 'Three mechanisms: confirm-not-guess case numbers, a watcher that reconciles unconfirmed submissions, and a reconcile pass that compares the whole My Requests list to our database every 30 minutes.',
      details: [
        'submitted + caseIdPending = the portal accepted the submission but we could not confirm the number yet; the watcher resolves it (or re-queues if the record is still a Draft).',
        'Reconcile: adopt rows we filed but failed to record; list stranded Drafts older than 24 h tied to dead reports (undeletable, just visible); flag submitted cases that vanished from the grid (only within the scanned window — the grid is paged).',
        'Terminal city statuses (Resolved, Closed, Completed, Cancelled…) trigger the resolved email, start the 30-day photo retention clock, and count in the public "resolved" stat.',
      ],
    },
    {
      key: 'email', title: 'Email',
      summary: 'All mail goes out through Resend from updates@fixmypvd.org. Reporter mail is gated by REPORTER_EMAIL_ENABLED; admin mail goes to NOTIFY_EMAIL (rob@fixmypvd.org → your Gmail via Cloudflare Email Routing, auto-labelled FixMyPVD).',
      details: [
        'Reporters get: sign-in links (minted by the Worker through Firebase Identity Toolkit), "filed with the city" with the case number, each city status change, and a kind note if a report is not filed.',
        'You get: review requests, reaper/breaker/canary alerts, and the daily digest.',
      ],
      live: { reporterEmailEnabled: env.REPORTER_EMAIL_ENABLED === 'true', notifyEmail: env.NOTIFY_EMAIL ?? null, from: env.NOTIFY_FROM ?? null },
    },
    {
      key: 'health', title: 'What the health lights mean',
      summary: 'Each subsystem writes a heartbeat (last OK, last error, today\'s counts). Green = fresh and no newer error; amber = late or the last run errored; red = far past due; grey = never ran since this store started.',
      details: SUBSYSTEMS.map((s) => `${s.label}: ${s.what}${s.expected ? ` — expected ${s.expected}` : ' — on demand'}.`),
    },
    {
      key: 'data', title: 'Data and privacy',
      summary: 'Firestore (free tier) holds reports, users, photos (as bytes), proofs, heartbeats, events and counters. Client rules are deny-all; only the Worker reads or writes.',
      details: [
        'Tracking pages show no PII. Photos are deleted 30 days after the city closes the case. Events are kept 14 days. Proof screenshots are viewport JPEGs of the portal at submit time, admin-only.',
        'Public endpoints: report create (auth), tracking read by id, photo by id, nearby (dedupe), stats. The old public feed and anonymous follow were removed because they exposed tracking ids.',
      ],
    },
  ];
}
