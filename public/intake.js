// AI intake (M6): when the reporter reaches the Review step we ask the Worker
// for a category suggestion, a polished description, and moderation flags.
// The reporter approves every change — nothing is applied silently, and the
// submit never waits on or fails because of this call.
(function () {
  const INTAKE_URL = window.PVD_INTAKE_URL || 'https://pvd311-worker.pvd311-worker.workers.dev/api/intake';
  const TIMEOUT_MS = 6000;

  const card = document.getElementById('intakeCard');
  const descriptionInput = document.getElementById('descriptionInput');
  if (!card || !descriptionInput) return;

  const css = `
    .intake-card { margin-bottom: 14px; padding: 12px 14px; background: rgba(126, 200, 227, 0.05); border: 1.5px solid var(--border); border-radius: var(--radius); font-size: 0.9rem; }
    .intake-card[hidden] { display: none; }
    .intake-label { display: block; font-family: 'Outfit', sans-serif; font-size: 0.72rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: var(--ice-400); margin-bottom: 6px; }
    .intake-row { display: flex; flex-direction: column; gap: 8px; }
    .intake-row + .intake-row { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border); }
    .intake-text { color: var(--text-primary); line-height: 1.45; }
    .intake-quote { color: var(--text-secondary); line-height: 1.45; font-style: italic; }
    .intake-btn { align-self: flex-start; min-height: 44px; padding: 10px 14px; border-radius: var(--radius); border: 1.5px solid var(--ice-400); background: transparent; color: var(--ice-400); font-family: 'Outfit', sans-serif; font-size: 0.9rem; font-weight: 600; cursor: pointer; -webkit-tap-highlight-color: transparent; }
    .intake-btn.applied { background: rgba(126, 200, 227, 0.12); }
    .intake-notice { display: flex; gap: 8px; align-items: flex-start; padding: 10px 12px; border-radius: var(--radius); font-size: 0.88rem; line-height: 1.4; }
    .intake-notice.emergency { background: rgba(239, 68, 68, 0.12); border: 1.5px solid rgba(239, 68, 68, 0.5); color: #fca5a5; }
    .intake-notice.warn { background: rgba(245, 166, 35, 0.1); border: 1.5px solid rgba(245, 166, 35, 0.45); color: #fcd490; }
    .intake-pending { color: var(--text-muted); font-size: 0.8rem; }
  `;
  const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);

  const state = { key: null, result: null, original: null, wordingApplied: false, inflight: null };

  function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function label(key) { const c = (window.PVD_CATEGORIES || []).find(x => x.key === key); return c ? c.label : key; }
  function safeLog(name, params) { try { if (typeof logEvent === 'function') logEvent(name, params); } catch (e) { /* no-op */ } }

  async function authHeaders() {
    const h = { 'Content-Type': 'application/json' };
    try {
      const user = await (typeof ensureAuth === 'function' ? ensureAuth() : Promise.resolve(firebase.auth().currentUser));
      if (user) h['Authorization'] = 'Bearer ' + await user.getIdToken();
    } catch (e) { /* unauthenticated call — Worker will refuse; we skip silently */ }
    try {
      const t = await firebase.appCheck().getToken(false);
      if (t && t.token) h['X-Firebase-AppCheck'] = t.token;
    } catch (e) { /* no App Check token available */ }
    return h;
  }

  async function requestIntake(input) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const resp = await fetch(INTAKE_URL, { method: 'POST', headers: await authHeaders(), body: JSON.stringify(input), signal: ctrl.signal });
      if (!resp.ok) return null;
      const data = await resp.json();
      return sanitize(data);
    } catch (e) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  const ALLOWED_FLAGS = ['spam', 'abuse', 'personal_info', 'not_311', 'emergency'];
  function sanitize(d) {
    if (!d || typeof d !== 'object') return null;
    const keys = new Set((window.PVD_CATEGORIES || []).map(c => c.key));
    const suggested = typeof d.suggestedCategory === 'string' && keys.has(d.suggestedCategory) && d.suggestedCategory !== 'unsure' ? d.suggestedCategory : null;
    const polished = typeof d.polishedDescription === 'string' && d.polishedDescription.trim() ? d.polishedDescription.trim().slice(0, 600) : null;
    const flags = Array.isArray(d.flags) ? d.flags.filter(f => ALLOWED_FLAGS.includes(f)).slice(0, 5) : [];
    const note = typeof d.note === 'string' && d.note.trim() ? d.note.trim().slice(0, 200) : null;
    return { suggestedCategory: suggested, polishedDescription: polished, flags, note };
  }

  function render(input) {
    const r = state.result;
    card.innerHTML = '';
    if (!r) { card.hidden = true; return; }
    const parts = [];
    if (r.flags.includes('emergency')) {
      parts.push(`<div class="intake-notice emergency"><strong>Emergency?</strong> <span>${esc(r.note || 'If someone is in danger, call 911. 311 reports are not monitored around the clock.')}</span></div>`);
    } else if (r.flags.includes('not_311')) {
      parts.push(`<div class="intake-notice warn"><span>${esc(r.note || 'This may not be something Providence 311 handles. You can still send it and we will take a look.')}</span></div>`);
    }
    if (r.suggestedCategory && r.suggestedCategory !== input.category) {
      parts.push(`<div class="intake-row"><span class="intake-label">Suggestion</span><div class="intake-text">This sounds more like <strong>${esc(label(r.suggestedCategory))}</strong>.</div><button type="button" class="intake-btn" data-action="switch">Switch to ${esc(label(r.suggestedCategory))}</button></div>`);
    }
    if (r.polishedDescription && r.polishedDescription !== (input.description || '').trim()) {
      parts.push(`<div class="intake-row"><span class="intake-label">Clearer wording</span><div class="intake-quote">“${esc(r.polishedDescription)}”</div><button type="button" class="intake-btn${state.wordingApplied ? ' applied' : ''}" data-action="wording">${state.wordingApplied ? 'Undo — keep my wording' : 'Use this wording'}</button></div>`);
    }
    if (!parts.length) { card.hidden = true; return; }
    const html = parts.join('');
    // Don't touch the DOM if nothing changed — a re-render between mousedown
    // and click (textarea blur → change → render) would swallow the click.
    if (card.innerHTML !== html) card.innerHTML = html;
    card.hidden = false;
  }

  card.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn || !state.result) return;
    if (btn.dataset.action === 'switch') {
      safeLog('intake_switch_category', { to: state.result.suggestedCategory });
      document.dispatchEvent(new CustomEvent('pvd:switch-category', { detail: { key: state.result.suggestedCategory } }));
      // The wizard re-enters review; keep the current result but drop the suggestion row.
      state.result = Object.assign({}, state.result, { suggestedCategory: null });
      render(currentInput());
    } else if (btn.dataset.action === 'wording') {
      if (!state.wordingApplied) {
        state.original = descriptionInput.value;
        descriptionInput.value = state.result.polishedDescription;
        state.wordingApplied = true;
        safeLog('intake_wording_applied', {});
      } else {
        descriptionInput.value = state.original || '';
        state.wordingApplied = false;
        safeLog('intake_wording_undone', {});
      }
      render(currentInput());
    }
  });

  // If the reporter edits the text after applying, it's theirs again — and a
  // pause in typing (or leaving the field) re-runs intake on the new text.
  let typingTimer = null;
  function rerunWithCurrentText() {
    if (!lastInput) return;
    onReview(Object.assign({}, lastInput, { description: descriptionInput.value.trim() }));
  }
  descriptionInput.addEventListener('input', () => {
    if (state.wordingApplied && state.result && descriptionInput.value !== state.result.polishedDescription) {
      state.wordingApplied = false;
      render(currentInput());
    }
    clearTimeout(typingTimer);
    typingTimer = setTimeout(rerunWithCurrentText, 1200);
  });
  descriptionInput.addEventListener('change', () => { clearTimeout(typingTimer); rerunWithCurrentText(); });

  let lastInput = null;
  function currentInput() { return lastInput || {}; }

  async function onReview(input) {
    lastInput = input;
    const key = JSON.stringify([input.category, (input.description || '').trim()]);
    if (!(input.description || '').trim()) { state.result = null; render(input); return; }
    if (key === state.key) return; // same text → keep what's on screen
    state.key = key;
    state.wordingApplied = false;
    state.result = null;
    card.hidden = false;
    card.innerHTML = '<span class="intake-pending">Checking your report…</span>';
    const p = requestIntake(Object.assign({}, input, { appVersion: window.APP_VERSION || null }));
    state.inflight = p;
    const r = await p;
    if (state.inflight !== p || state.key !== key) return; // superseded
    state.result = r;
    safeLog('intake_result', { suggested: !!(r && r.suggestedCategory), polished: !!(r && r.polishedDescription), flags: r ? r.flags.join(',') : 'none' });
    render(input);
  }

  function apply(payload) {
    if (!state.result) return payload;
    if (state.wordingApplied && state.original != null && state.original.trim() !== (payload.description || '')) {
      payload.descriptionOriginal = state.original.trim().slice(0, 2000) || null;
    }
    if (state.result.flags.length) payload.intakeFlags = state.result.flags.slice(0, 5);
    return payload;
  }

  function reset() {
    state.key = null; state.result = null; state.original = null; state.wordingApplied = false; state.inflight = null; lastInput = null;
    card.hidden = true; card.innerHTML = '';
  }

  window.PVDIntake = { onReview, apply, reset };
})();
