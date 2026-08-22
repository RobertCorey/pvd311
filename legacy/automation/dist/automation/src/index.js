import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initFirestore, fetchAllReports, fetchReport, updateReportStatus, saveReportDraft } from './firestore.js';
import { PortalSubmitter } from './portal.js';
import { config } from './config.js';
import { AutoSubmitter } from './auto.js';
import { approve, reject } from './hitl.js';
import { telegramEnabled } from './telegram.js';
const __dirname = dirname(fileURLToPath(import.meta.url));
// Track active submission so we don't double-submit
let activeSubmission = null;
// Auto-submission engine
const autoSubmitter = new AutoSubmitter(() => activeSubmission !== null, (id) => { activeSubmission = id; });
function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}
async function readBody(req) {
    const chunks = [];
    for await (const chunk of req)
        chunks.push(chunk);
    return Buffer.concat(chunks).toString();
}
async function handleRequest(req, res) {
    const url = new URL(req.url || '/', `http://localhost`);
    // ── Dashboard HTML ──
    if (req.method === 'GET' && url.pathname === '/') {
        // Resolve path: in dev the compiled JS is at dist/automation/src/index.js,
        // dashboard.html is at automation/src/dashboard.html (source).
        // We ship dashboard.html alongside compiled output via a copy, but simpler:
        // just resolve relative to the *source* tree.
        const htmlPaths = [
            join(__dirname, 'dashboard.html'), // next to compiled JS
            join(__dirname, '..', '..', '..', 'automation', 'src', 'dashboard.html'), // from dist/automation/src -> automation/src
        ];
        let html = '';
        for (const p of htmlPaths) {
            try {
                html = readFileSync(p, 'utf-8');
                break;
            }
            catch { /* try next */ }
        }
        if (!html) {
            res.writeHead(500);
            res.end('dashboard.html not found');
            return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
        return;
    }
    // ── API: list all reports ──
    if (req.method === 'GET' && url.pathname === '/api/reports') {
        const reports = await fetchAllReports();
        // Strip photo data from listing (too large), send a flag instead
        const lite = reports.map(({ photo, ...rest }) => ({ ...rest, hasPhoto: !!photo }));
        json(res, 200, lite);
        return;
    }
    // ── API: get single report (includes photo) ──
    if (req.method === 'GET' && url.pathname.startsWith('/api/reports/')) {
        const id = url.pathname.split('/')[3];
        const report = await fetchReport(id);
        if (!report) {
            json(res, 404, { error: 'Not found' });
            return;
        }
        json(res, 200, report);
        return;
    }
    // ── API: submit a report to 311 ──
    if (req.method === 'POST' && url.pathname === '/api/submit') {
        const body = JSON.parse(await readBody(req));
        if (!body.id) {
            json(res, 400, { error: 'Missing report id' });
            return;
        }
        if (activeSubmission) {
            json(res, 409, { error: `Already submitting report ${activeSubmission}` });
            return;
        }
        const report = await fetchReport(body.id);
        if (!report) {
            json(res, 404, { error: 'Report not found' });
            return;
        }
        const dryRun = !!body.dryRun;
        // Kick off submission in background, return immediately
        activeSubmission = body.id;
        json(res, 202, { status: 'started', id: body.id, dryRun });
        // Run async — don't await
        submitInBackground(report, dryRun).finally(() => { activeSubmission = null; });
        return;
    }
    // ── API: reset a failed/submitted report back to pending ──
    if (req.method === 'POST' && url.pathname === '/api/reset') {
        const body = JSON.parse(await readBody(req));
        if (!body.id) {
            json(res, 400, { error: 'Missing report id' });
            return;
        }
        await updateReportStatus(body.id, 'pending', 'Reset from dashboard');
        json(res, 200, { status: 'reset', id: body.id });
        return;
    }
    // ── API: reject a report (spam, duplicate, won't do) ──
    if (req.method === 'POST' && url.pathname === '/api/reject') {
        const body = JSON.parse(await readBody(req));
        if (!body.id) {
            json(res, 400, { error: 'Missing report id' });
            return;
        }
        await updateReportStatus(body.id, 'rejected', body.reason || 'Rejected from dashboard');
        json(res, 200, { status: 'rejected', id: body.id });
        return;
    }
    // ── API: HITL approve/reject a report awaiting review (from the dashboard) ──
    if (req.method === 'POST' && url.pathname.startsWith('/api/reports/') &&
        (url.pathname.endsWith('/approve') || url.pathname.endsWith('/reject'))) {
        const parts = url.pathname.split('/'); // ['', 'api', 'reports', '<id>', 'approve'|'reject']
        const id = parts[3];
        const action = parts[4];
        if (!id) {
            json(res, 400, { error: 'Missing report id' });
            return;
        }
        try {
            if (action === 'approve')
                await approve(id, 'dashboard');
            else
                await reject(id, 'dashboard');
            json(res, 200, { status: action === 'approve' ? 'approved' : 'rejected', id });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[hitl] ${action} ${id} failed:`, message);
            json(res, 500, { error: message });
        }
        return;
    }
    // ── API: check if a submission is active ──
    if (req.method === 'GET' && url.pathname === '/api/status') {
        json(res, 200, {
            activeSubmission,
            headless: config.headless,
            hitlMode: config.hitlMode,
            telegramEnabled: telegramEnabled(),
        });
        return;
    }
    // ── API: toggle headless mode ──
    if (req.method === 'POST' && url.pathname === '/api/headless') {
        const body = JSON.parse(await readBody(req));
        config.headless = !!body.headless;
        console.log(`[main] Headless mode ${config.headless ? 'enabled' : 'disabled'}`);
        json(res, 200, { headless: config.headless });
        return;
    }
    // ── API: auto-mode state ──
    if (req.method === 'GET' && url.pathname === '/api/auto') {
        json(res, 200, autoSubmitter.getState());
        return;
    }
    // ── API: toggle auto-mode ──
    if (req.method === 'POST' && url.pathname === '/api/auto') {
        const body = JSON.parse(await readBody(req));
        autoSubmitter.setEnabled(!!body.enabled);
        json(res, 200, autoSubmitter.getState());
        return;
    }
    // ── API: resume auto-mode (reset circuit breaker) ──
    if (req.method === 'POST' && url.pathname === '/api/auto/resume') {
        autoSubmitter.resume();
        json(res, 200, autoSubmitter.getState());
        return;
    }
    json(res, 404, { error: 'Not found' });
}
async function submitInBackground(report, dryRun) {
    const portal = new PortalSubmitter();
    const mode = dryRun ? 'inspect' : 'live';
    try {
        await updateReportStatus(report.id, 'processing', `Automation started (${mode})`);
        await portal.launch();
        const result = await portal.submitReport(report, { mode, onDraft: (d) => saveReportDraft(report.id, d) });
        if (dryRun) {
            // Return to pending — nothing was actually submitted (the portal draft is kept for resume)
            const seen = (result.controls ?? []).map((c) => `${c.id}${c.required ? '*' : ''}`).join(', ') || 'none';
            await updateReportStatus(report.id, 'pending', `Inspect OK — step-3 controls: ${seen}`);
            console.log(`[submit] Report ${report.id} inspect completed; controls: ${seen}`);
        }
        else {
            await updateReportStatus(report.id, 'submitted', result.caseId ? `Submitted as ${result.caseId}` : 'Submitted successfully', result.caseId);
            console.log(`[submit] Report ${report.id} submitted successfully`);
        }
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[submit] Report ${report.id} failed:`, message);
        await updateReportStatus(report.id, 'failed', `${mode}: ${message}`).catch((e) => console.error('[submit] Failed to update status:', e));
    }
    finally {
        await portal.close();
    }
}
async function main() {
    console.log('[main] PVD311 Dashboard starting...');
    initFirestore();
    const server = createServer(async (req, res) => {
        try {
            await handleRequest(req, res);
        }
        catch (err) {
            console.error('[server] Request error:', err);
            if (!res.headersSent)
                json(res, 500, { error: 'Internal server error' });
        }
    });
    // Bind to loopback by default (dashboard is unauthenticated); set HOST=0.0.0.0 to expose.
    const host = process.env['HOST'] || '127.0.0.1';
    server.listen(config.port, host, () => {
        console.log(`[main] Dashboard running at http://${host}:${config.port}`);
        if (config.autoMode) {
            console.log('[main] Auto-submission mode enabled (--auto)');
            autoSubmitter.start();
        }
    });
}
main().catch((err) => {
    console.error('[main] Fatal error:', err);
    process.exit(1);
});
