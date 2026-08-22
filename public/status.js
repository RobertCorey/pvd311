// ============================================================
// PVD 311 — My reports (reporter-facing status view)
// ============================================================
// Reads the anonymous device's own reports (Firestore rules only allow
// reporterUid == request.auth.uid) and renders reporter-friendly status.
// Loaded after app.js, so `firebase`, `db`, `auth`, `ensureAuth`, and
// `window.PVD_CATEGORIES` are already defined.

(function () {
  'use strict';

  // --- DOM refs (hooks live in index.html; owned by other agents) ---
  var section = document.getElementById('myReports');
  var listEl = document.getElementById('myReportsList');
  var statusEl = document.getElementById('myReportsStatus');
  var link = document.getElementById('myReportsLink');
  var closeBtn = document.getElementById('myReportsClose');
  var wizard = document.getElementById('wizard');
  var wizardNav = document.getElementById('wizardNav');
  var progressBar = document.getElementById('progressBar');
  var confirmation = document.getElementById('confirmationScreen');

  if (!section || !listEl || !statusEl) return; // hooks missing — nothing to do.

  // --- Helpers ---
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function truncate(s, n) {
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n - 1).replace(/\s+$/, '') + '…' : s;
  }

  function catInfo(key) {
    var cats = window.PVD_CATEGORIES || [];
    for (var i = 0; i < cats.length; i++) {
      if (cats[i].key === key) return cats[i];
    }
    return null;
  }

  // Coerce a Firestore Timestamp | Date | seconds-object | ISO string → Date.
  function toDate(ts) {
    if (!ts) return null;
    if (typeof ts.toDate === 'function') { try { return ts.toDate(); } catch (e) { return null; } }
    if (ts instanceof Date) return ts;
    if (typeof ts.seconds === 'number') return new Date(ts.seconds * 1000);
    var d = new Date(ts);
    return isNaN(d.getTime()) ? null : d;
  }

  function startOfDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }

  function relativeDate(ts) {
    var d = toDate(ts);
    if (!d) return '';
    var days = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86400000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 7) return days + ' days ago';
    if (days < 14) return 'last week';
    if (days < 30) return Math.floor(days / 7) + ' weeks ago';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  // Reporter-friendly status mapping — never expose internal words (HITL,
  // automation, queue, etc.). Returns { label, cls, detail }.
  function statusView(r) {
    switch (r.status) {
      case 'pending':
      case 'awaiting_review':
        return { label: 'Waiting for review', cls: 'waiting', detail: '' };
      case 'processing':
        return { label: 'Sending to the city', cls: 'processing', detail: '' };
      case 'submitted': {
        var parts = [];
        if (r.portalCaseId) parts.push('Case ' + r.portalCaseId);
        if (r.portalStatus) parts.push('City status: ' + r.portalStatus);
        return { label: 'Sent to 311', cls: 'sent', detail: parts.join(' · ') };
      }
      case 'failed':
        return { label: "Couldn't send yet", cls: 'failed', detail: "We'll retry automatically." };
      case 'rejected':
      case 'auto-rejected':
        return { label: 'Not sent', cls: 'notsent', detail: r.statusDetail ? truncate(r.statusDetail, 120) : '' };
      default:
        return { label: 'Waiting for review', cls: 'waiting', detail: '' };
    }
  }

  function renderItem(r) {
    var cat = catInfo(r.category);
    var icon = cat ? cat.icon : '📍'; // 📍 fallback
    var label = cat ? cat.label : (r.category || 'Report');
    var sv = statusView(r);
    var rel = relativeDate(r.timestamp);

    return '<li class="mr-item">' +
      '<div class="mr-row">' +
        '<span class="mr-cat"><span class="mr-icon" aria-hidden="true">' + esc(icon) + '</span>' +
        '<span>' + esc(label) + '</span></span>' +
        '<span class="mr-pill mr-pill-' + sv.cls + '">' + esc(sv.label) + '</span>' +
      '</div>' +
      (r.address ? '<div class="mr-addr">' + esc(r.address) + '</div>' : '') +
      (rel ? '<div class="mr-date">' + esc(rel) + '</div>' : '') +
      (sv.detail ? '<div class="mr-detail">' + esc(sv.detail) + '</div>' : '') +
      '</li>';
  }

  function setStatus(t) { statusEl.textContent = t; }

  function renderReports(docs) {
    docs = docs || [];
    if (!docs.length) {
      listEl.innerHTML = '';
      setStatus('No reports from this device yet.');
      return;
    }
    setStatus(docs.length === 1 ? '1 report' : docs.length + ' reports');
    listEl.innerHTML = docs.map(renderItem).join('');
  }

  // --- Show / hide wiring ---
  function hideWizardUI() {
    if (wizard) wizard.style.display = 'none';
    if (wizardNav) wizardNav.style.display = 'none';
    if (progressBar) progressBar.style.display = 'none';
    if (confirmation) confirmation.style.display = 'none';
  }
  function showWizardUI() {
    if (wizard) wizard.style.display = '';
    if (wizardNav) wizardNav.style.display = '';
    if (progressBar) progressBar.style.display = '';
    if (confirmation) confirmation.style.display = '';
  }

  var isOpen = false;
  var unsub = null;

  function stopLive() {
    if (unsub) { try { unsub(); } catch (e) {} unsub = null; }
  }

  function startLive() {
    stopLive();
    ensureAuth().then(function (user) {
      var uid = user.uid;
      unsub = db.collection('reports')
        .where('reporterUid', '==', uid)
        .orderBy('timestamp', 'desc')
        .limit(25)
        .onSnapshot(function (snap) {
          var docs = [];
          snap.forEach(function (doc) { docs.push(doc.data()); });
          renderReports(docs);
        }, function (err) {
          console.error('My reports query failed:', err);
          listEl.innerHTML = '';
          setStatus("Couldn't load your reports right now.");
        });
    }).catch(function (err) {
      console.error('My reports auth failed:', err);
      setStatus("Couldn't load your reports right now.");
    });
  }

  function reveal() {
    hideWizardUI();
    section.hidden = false;
    window.scrollTo(0, 0);
  }

  function openReports() {
    if (isOpen) return;
    isOpen = true;
    reveal();
    listEl.innerHTML = '';
    setStatus('Loading…');
    startLive();
  }

  function clearHash() {
    if (location.hash === '#my-reports') {
      history.replaceState(null, '', location.pathname + location.search);
    }
  }

  function closeReports() {
    if (!isOpen) return;
    isOpen = false;
    stopLive();
    section.hidden = true;
    showWizardUI();
    clearHash();
  }

  // --- Events ---
  window.addEventListener('hashchange', function () {
    if (location.hash === '#my-reports') openReports();
    else closeReports();
  });

  if (link) {
    link.addEventListener('click', function () {
      // The anchor sets location.hash='#my-reports'; hashchange opens it. But if
      // it's already the current hash, hashchange won't fire — open directly.
      if (location.hash === '#my-reports') openReports();
    });
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', function () {
      clearHash();
      closeReports();
    });
  }

  // Deep-link on load.
  if (location.hash === '#my-reports') openReports();

  // Test/inspection hook (used by the Playwright stub-render check).
  window.PVDMyReports = { render: renderReports, reveal: reveal, open: openReports, close: closeReports };
})();
