import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ALL_CATEGORIES, EXTRA_QUESTIONS, FEATURED, byKey, inSeason, type UiCategory } from '../lib/categories';
import { compressImage, forwardGeocode, inProvidence, readExifGps, reverseGeocode } from '../lib/geo';
import { getNearby, intake, submitReport } from '../api/client';
import { Link } from 'react-router-dom';
import { ApiError, type IntakeResult, type NearbyItem } from '../api/types';
import { rememberReport } from '../lib/myReports';
import { flushOutbox, isOutboxPaused, outbox, resumeOutbox } from '../lib/outbox';
import { BRAND } from '../brand';
import { useT } from '../i18n';
import Turnstile from '../components/Turnstile';
import CategoryIcon from '../components/CategoryIcon';
import './Report.css';

const MapView = lazy(() => import('../components/MapView'));

type Loc = { lat: number; lng: number } | null;

export default function Report() {
  const navigate = useNavigate();
  const t = useT();

  // --- Phase A: category ---
  const [category, setCategory] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const visible = useMemo(() => ALL_CATEGORIES.filter((c) => inSeason(c)), []);
  const featured = useMemo(() => {
    const f = FEATURED.map(byKey).filter((c): c is UiCategory => !!c && inSeason(c));
    // In season, the snow tiles surface alongside the core eight.
    const seasonal = visible.filter((c) => c.seasonal && !FEATURED.includes(c.key));
    return [...f, ...seasonal];
  }, [visible]);
  const others = useMemo(() => visible.filter((c) => !featured.includes(c)), [visible, featured]);
  const cat = byKey(category);

  // --- photo ---
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [photoHasGps, setPhotoHasGps] = useState(false);
  const cameraRef = useRef<HTMLInputElement>(null);
  const libraryRef = useRef<HTMLInputElement>(null);

  // --- location ---
  const [address, setAddress] = useState('');
  const [loc, setLoc] = useState<Loc>(null);
  const [locMsg, setLocMsg] = useState<string>('');
  const [outside, setOutside] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const geocodedFor = useRef<string | null>(null);

  // --- details ---
  const [extra, setExtra] = useState<Record<string, string>>({});
  const [description, setDescription] = useState('');
  const [intakeRes, setIntakeRes] = useState<IntakeResult | null>(null);
  const [intakeBusy, setIntakeBusy] = useState(false);
  const [wordingApplied, setWordingApplied] = useState<string | null>(null); // original text when applied
  const intakeKey = useRef<string | null>(null);

  // --- dedupe (spec §3.4): once a location is known, ask for similar reports nearby ---
  const [nearby, setNearby] = useState<NearbyItem[]>([]);
  const [nearbyDismissed, setNearbyDismissed] = useState(false);
  const nearbyKey = useRef<string | null>(null);
  useEffect(() => {
    if (!loc || !category) { setNearby([]); return; }
    const key = `${category}:${loc.lat.toFixed(4)}:${loc.lng.toFixed(4)}`;
    if (key === nearbyKey.current) return;
    nearbyKey.current = key;
    let cancelled = false;
    getNearby(loc.lat, loc.lng, category, 75).then((r) => { if (!cancelled) { setNearby(r.items); setNearbyDismissed(false); } });
    return () => { cancelled = true; };
  }, [loc, category]);

  // --- submit ---
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileNonce, setTurnstileNonce] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState(false);

  // --- online state + offline outbox ---
  const [online, setOnline] = useState(() => navigator.onLine);
  const [pending, setPending] = useState(0);
  const [outboxNotice, setOutboxNotice] = useState<string | null>(null);
  // After a failed flush we stop until the next 'online' event / app open, so a
  // report the server keeps rejecting can't loop and burn Turnstile tokens.
  const [flushPaused, setFlushPaused] = useState(false);
  const refreshPending = useCallback(() => outbox.pending().then((p) => setPending(p.length)).catch(() => {}), []);
  useEffect(() => { refreshPending(); }, [refreshPending]);
  useEffect(() => {
    if (!pending || !turnstileToken || !online || flushPaused || isOutboxPaused()) return;
    let cancelled = false;
    // One queued item per Turnstile token (tokens are single-use); on success the
    // widget re-mounts for the next one.
    flushOutbox(async (r, clientId) => {
      const created = await submitReport({ ...r, turnstileToken }, clientId);
      rememberReport({ id: created.id, category: r.category, address: r.address, createdAt: created.createdAt });
    }, 1).then(async ({ sent, failed, remaining }) => {
      if (failed) setFlushPaused(true);
      setPending(remaining);
      if (cancelled) return;
      if (sent) setOutboxNotice(t('report.outbox.sent'));
      if (sent && remaining) { setTurnstileToken(null); setTurnstileNonce((n) => n + 1); }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [pending, turnstileToken, online, flushPaused, t]);
  useEffect(() => {
    const onOnline = () => { setOnline(true); resumeOutbox(); setFlushPaused(false); refreshPending(); };
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline); window.addEventListener('offline', onOffline);
    return () => { window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline); };
  }, [refreshPending]);

  useEffect(() => () => { if (photoUrl) URL.revokeObjectURL(photoUrl); }, [photoUrl]);

  const pick = (key: string) => { setCategory(key); setExtra({}); window.scrollTo({ top: 0 }); };

  const onPhoto = useCallback(async (file: File | null) => {
    setPhoto(file);
    setPhotoHasGps(false);
    if (photoUrl) URL.revokeObjectURL(photoUrl);
    setPhotoUrl(file ? URL.createObjectURL(file) : null);
    if (!file) return;
    try {
      const gps = await readExifGps(file);
      if (gps && inProvidence(gps.lat, gps.lng)) {
        setPhotoHasGps(true);
        setLoc(gps); setOutside(false);
        setLocMsg(t('report.location.foundInPhoto'));
        const label = await reverseGeocode(gps.lat, gps.lng).catch(() => null);
        if (label) { setAddress(label); geocodedFor.current = label; }
      } else if (gps) {
        setLocMsg(t('report.photo.outside'));
      } else if (!loc) {
        setLocMsg(t('report.photo.noExif'));
      }
    } catch { /* no EXIF */ }
  }, [photoUrl, loc, t]);

  const detect = useCallback(() => {
    if (!navigator.geolocation) { setLocMsg(t('report.location.unsupported')); return; }
    setDetecting(true); setLocMsg(t('report.location.finding'));
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const { latitude: lat, longitude: lng } = pos.coords;
      setDetecting(false);
      if (!inProvidence(lat, lng)) { setOutside(true); setLoc(null); setLocMsg(t('report.location.youOutside')); return; }
      setLoc({ lat, lng }); setOutside(false); setLocMsg(t('report.location.found'));
      const label = await reverseGeocode(lat, lng).catch(() => null);
      if (label) { setAddress(label); geocodedFor.current = label; } else setLocMsg(t('report.location.addNearest'));
    }, () => { setDetecting(false); setLocMsg(t('report.location.denied')); }, { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 });
  }, [t]);

  const geocodeAddress = useCallback(async () => {
    const text = address.trim();
    if (!text || text === geocodedFor.current || photoHasGps) return;
    geocodedFor.current = text;
    try {
      const hit = await forwardGeocode(text);
      if (!hit) return;
      if (!inProvidence(hit.lat, hit.lng)) { setOutside(true); setLoc(null); return; }
      setOutside(false); setLoc({ lat: hit.lat, lng: hit.lng });
    } catch { /* ignore */ }
  }, [address, photoHasGps]);

  // Draggable pin: the reporter corrects the spot; address follows (reverse geocode).
  const pinTimer = useRef<number | null>(null);
  const onPinMove = useCallback((lat: number, lng: number) => {
    if (!inProvidence(lat, lng)) { setOutside(true); setLoc({ lat, lng }); setLocMsg(t('report.location.pinOutside')); return; }
    setOutside(false); setLoc({ lat, lng }); setLocMsg(t('report.location.pinMoved'));
    if (pinTimer.current) window.clearTimeout(pinTimer.current);
    pinTimer.current = window.setTimeout(async () => {
      const label = await reverseGeocode(lat, lng).catch(() => null);
      if (label) { setAddress(label); geocodedFor.current = label; }
    }, 400);
  }, [t]);

  // Intake (moderation + optional polish) after a pause in typing.
  useEffect(() => {
    const text = description.trim();
    if (!text || wordingApplied !== null) return;
    const key = JSON.stringify([category, text]);
    if (key === intakeKey.current) return;
    const timer = setTimeout(async () => {
      intakeKey.current = key;
      setIntakeBusy(true);
      const r = await intake({ category, description: text, address: address.trim(), extra, hasPhoto: !!photo }, turnstileToken);
      if (intakeKey.current === key) { setIntakeRes(r); setIntakeBusy(false); }
    }, 1200);
    return () => clearTimeout(timer);
  }, [description, category, address, extra, photo, turnstileToken, wordingApplied]);

  const applyWording = () => {
    if (!intakeRes?.polishedDescription) return;
    if (wordingApplied === null) { setWordingApplied(description); setDescription(intakeRes.polishedDescription); }
    else { setDescription(wordingApplied); setWordingApplied(null); }
  };

  const emergency = !!intakeRes?.flags.includes('emergency');
  const photoRequired = cat ? cat.photoRequired : true;
  const canSubmit = !!cat && address.trim().length >= 3 && (!!photo || !photoRequired) && (!!turnstileToken || !online) && !submitting && !outside;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || !cat) return;
    setSubmitting(true); setError(null);
    try {
      const blob = photo ? await compressImage(photo).catch(() => photo) : null;
      if (!online || !navigator.onLine) {
        await outbox.add({
          category: cat.key, description: description.trim(), address: address.trim(),
          lat: loc?.lat ?? null, lng: loc?.lng ?? null, extra: Object.keys(extra).length ? extra : null,
          descriptionOriginal: wordingApplied !== null && wordingApplied.trim() !== description.trim() ? wordingApplied.trim() : undefined,
          intakeFlags: intakeRes?.flags.length ? intakeRes.flags : undefined, photo: blob,
        });
        setPending((n) => n + 1);
        setSubmitting(false); setQueued(true); window.scrollTo({ top: 0 });
        return;
      }
      if (!turnstileToken) { setSubmitting(false); return; }
      const created = await submitReport({
        category: cat.key,
        description: description.trim(),
        address: address.trim(),
        lat: loc?.lat ?? null, lng: loc?.lng ?? null,
        extra: Object.keys(extra).length ? extra : null,
        turnstileToken,
        descriptionOriginal: wordingApplied !== null && wordingApplied.trim() !== description.trim() ? wordingApplied.trim() : undefined,
        intakeFlags: intakeRes?.flags.length ? intakeRes.flags : undefined,
        photo: blob,
      });
      rememberReport({ id: created.id, category: cat.key, address: address.trim(), createdAt: created.createdAt });
      navigate(`/r/${created.id}`, { state: { justSubmitted: true } });
    } catch (err) {
      setSubmitting(false);
      setTurnstileToken(null); setTurnstileNonce((n) => n + 1); // tokens are single-use
      if (err instanceof ApiError) {
        if (err.code === 'rate_limited') setError(err.retryAfterSec ? t('report.error.rateLimitedIn', { minutes: Math.max(1, Math.ceil(err.retryAfterSec / 60)) }) : t('report.error.rateLimited'));
        else if (err.code === 'turnstile_failed') setError(t('report.error.turnstile'));
        else if (err.status === 400) setError(err.field ? t('report.error.field', { field: err.field }) : t('report.error.badRequest'));
        else setError(t('report.error.generic'));
      } else if ((err as Error)?.name === 'AbortError') setError(t('report.error.timeout'));
      else setError(t('report.error.generic'));
    }
  }

  // ---------- Queued (offline) ----------
  if (queued) {
    return (
      <section className="section queued" aria-live="polite">
        <div className="notice notice-ok"><strong>{t('report.queued.title')}</strong></div>
        <p>{t('report.queued.body', { name: BRAND.name })}</p>
        <button type="button" className="btn btn-primary" onClick={() => window.location.assign('/')}>{t('report.queued.another')}</button>
      </section>
    );
  }

  // ---------- Phase A ----------
  if (!cat) {
    return (
      <section className="section">
        {outboxNotice && <div className="notice notice-ok" role="status">{outboxNotice}</div>}
        {pending > 0 && (
          <div className="card outbox-card" role="status">
            <p className="hint">{t(pending === 1 ? 'report.outbox.pending' : 'report.outbox.pendingPlural', { count: pending })}</p>
            <Turnstile key={`ob-${turnstileNonce}`} onToken={setTurnstileToken} />
          </div>
        )}
        <h2>{t('report.whatsWrong')}</h2>
        <div className="cat-grid" role="group" aria-label={t('report.whatsWrong')}>
          {featured.map((c) => <CatTile key={c.key} c={c} onPick={pick} />)}
          {!showAll ? (
            <button type="button" className="cat-tile cat-tile-other" onClick={() => setShowAll(true)} aria-expanded={false}>
              <span className="cat-icon"><CategoryIcon k="other" /></span><span className="cat-text">{t('report.other')}</span>
            </button>
          ) : others.map((c) => <CatTile key={c.key} c={c} onPick={pick} />)}
        </div>
      </section>
    );
  }

  // ---------- Phase B ----------
  return (
    <form className="report" onSubmit={onSubmit} noValidate>
      <div className="chosen">
        <button type="button" className="chip" onClick={() => setCategory(null)} aria-label={`${cat.short} — ${t('report.change')}`}>
          <CategoryIcon k={cat.key} size={18} />{cat.short}<span className="chip-change">{t('report.change')}</span>
        </button>
      </div>

      {/* Photo */}
      <section className="section">
        <h2>{photoRequired ? t('report.photo.title') : t('report.photo.titleOptional')}</h2>
        <p className="hint">{photoRequired ? t('report.photo.hintRequired') : t('report.photo.hintOptional')}</p>
        <input ref={cameraRef} id="photo" type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={(e) => onPhoto(e.target.files?.[0] ?? null)} />
        <input ref={libraryRef} id="photoLibrary" type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => onPhoto(e.target.files?.[0] ?? null)} />
        {!photoUrl ? (
          <div className="photo-hero">
            <button type="button" className="btn btn-primary" onClick={() => cameraRef.current?.click()}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z" /><circle cx="12" cy="13" r="4" /></svg>
              {t('report.photo.take')}
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => libraryRef.current?.click()}>{t('report.photo.library')}</button>
          </div>
        ) : (
          <div className="photo-preview">
            <img src={photoUrl} alt="" />
            <div className="photo-actions">
              <span className={photoHasGps ? 'ok' : 'muted'}>{photoHasGps ? t('report.photo.attachedGps') : t('report.photo.attached')}</span>
              <button type="button" className="btn btn-ghost" onClick={() => { onPhoto(null); cameraRef.current?.click(); }}>{t('report.photo.retake')}</button>
            </div>
          </div>
        )}
      </section>

      {/* Location */}
      <section className="section">
        <h2>{t('report.location.title')}</h2>
        {locMsg && <p className="hint" aria-live="polite">{locMsg}</p>}
        {!loc && (
          <button type="button" className="chip detect-chip" onClick={detect} disabled={detecting}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M12 2v4M12 18v4M2 12h4M18 12h4" /></svg>
            {detecting ? t('report.location.finding') : t('report.location.useMine')}
          </button>
        )}
        <label className="label" htmlFor="address">{t('report.location.label')}</label>
        <input id="address" className="input" value={address} placeholder={t('report.location.placeholder')}
          autoComplete="street-address" onChange={(e) => { setAddress(e.target.value); if (!photoHasGps) { setLoc(null); setOutside(false); } }} onBlur={geocodeAddress} />
        {outside && <div className="notice notice-warn" role="alert">{t('report.location.outside')}</div>}
        {nearby.length > 0 && !nearbyDismissed && <NearbyCard items={nearby} onDismiss={() => setNearbyDismissed(true)} />}
        {loc && (
          <div className="mini-map">
            <Suspense fallback={<div className="mini-map-skeleton" aria-hidden="true" />}>
              <MapView center={[loc.lat, loc.lng]} zoom={17} height={200} draggablePin={loc} onPinMove={onPinMove} ariaLabel={t('report.location.mapLabel')} />
            </Suspense>
            <p className="hint">{t('report.location.dragHint')}</p>
          </div>
        )}
      </section>

      {/* Details */}
      <section className="section">
        <h2>{t('report.details.title')}</h2>
        {cat.extra.map((k) => {
          const q = EXTRA_QUESTIONS[k]; if (!q) return null;
          const id = `extra_${k}`;
          return (
            <div key={k} className="field">
              <label className="label" htmlFor={id}>{t(`extra.${k}`)}</label>
              {q.type === 'choice' ? (
                <select id={id} className="select" value={extra[k] ?? ''} onChange={(e) => setExtra({ ...extra, [k]: e.target.value })}>
                  <option value="">{t('report.details.choose')}</option>
                  {q.options!.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : (
                <input id={id} className="input" placeholder={t(`extra.${k}.placeholder`)} value={extra[k] ?? ''} onChange={(e) => setExtra({ ...extra, [k]: e.target.value })} />
              )}
            </div>
          );
        })}
        <div className="field">
          <label className="label" htmlFor="description">{t('report.description.label')}</label>
          <textarea id="description" className="textarea" rows={3} placeholder={t('report.description.placeholder')} value={description}
            onChange={(e) => { setDescription(e.target.value); if (wordingApplied !== null && e.target.value !== intakeRes?.polishedDescription) setWordingApplied(null); }} />
        </div>
        {intakeBusy && <p className="hint" aria-live="polite">{t('report.intake.checking')}</p>}
        {intakeRes && (
          <div className="intake" aria-live="polite">
            {emergency && <div className="notice notice-error" role="alert"><strong>{t('report.intake.emergencyTitle')}</strong> <span>{intakeRes.note ?? t('report.intake.emergencyBody')}</span></div>}
            {!emergency && intakeRes.flags.includes('not_311') && <div className="notice notice-warn">{intakeRes.note ?? t('report.intake.not311')}</div>}
            {intakeRes.polishedDescription && (wordingApplied !== null || intakeRes.polishedDescription !== description.trim()) && (
              <div className="card intake-card">
                <span className="label">{t('report.intake.wordingLabel')}</span>
                <p className="intake-quote">“{intakeRes.polishedDescription}”</p>
                <button type="button" className={`btn btn-ghost${wordingApplied !== null ? ' applied' : ''}`} onClick={applyWording}>{wordingApplied !== null ? t('report.intake.undoWording') : t('report.intake.useWording')}</button>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Submit */}
      <section className="section">
        <p className="public-record">{t('report.publicRecord')}</p>
        <Turnstile key={turnstileNonce} onToken={setTurnstileToken} />
        {error && <div className="notice notice-error" role="alert">{error}</div>}
      </section>
      <div className="submit-bar">
        <button type="submit" className="btn btn-primary" disabled={!canSubmit}>{submitting ? t('report.sending') : t('report.submit')}</button>
        {!turnstileToken && !submitting && online && <p className="hint center">{t('report.waitingSpamCheck')}</p>}
        {!online && <p className="hint center">{t('report.offlineHint')}</p>}
      </div>
    </form>
  );
}

function CatTile({ c, onPick }: { c: UiCategory; onPick: (k: string) => void }) {
  return (
    <button type="button" className="cat-tile" onClick={() => onPick(c.key)} data-category={c.key}>
      <span className="cat-icon"><CategoryIcon k={c.key} size={26} /></span>
      <span className="cat-text">{c.short}</span>
    </button>
  );
}

function ageLabel(t: (k: string, v?: Record<string, string | number>) => string, iso: string | null): string {
  if (!iso) return '';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return t('report.nearby.today');
  if (days === 1) return t('report.nearby.dayAgo');
  return t('report.nearby.daysAgo', { n: days });
}

function NearbyCard({ items, onDismiss }: { items: NearbyItem[]; onDismiss: () => void }) {
  const t = useT();
  const first = items[0];
  const street = first.address.replace(/,\s*Providence.*$/i, '');
  return (
    <div className="card nearby-card" role="status" aria-live="polite">
      <span className="label">{t('report.nearby.title')}</span>
      <p className="nearby-body">{t('report.nearby.body', { label: byKey(first.category)?.short ?? first.categoryLabel, street, age: ageLabel(t, first.createdAt), distance: Math.round(first.distanceM) })}</p>
      {items.length > 1 && <p className="hint">{t('report.nearby.bodyMore', { count: items.length, radius: 75 })}</p>}
      <div className="nearby-actions">
        {first.source !== 'city' && !first.id.startsWith('city:')
          ? <Link className="btn btn-ghost" to={`/r/${first.id}`}>{t('report.nearby.track')}</Link>
          : <Link className="btn btn-ghost" to="/map">{t('report.nearby.viewMap')}</Link>}
        <button type="button" className="btn btn-secondary" onClick={onDismiss}>{t('report.nearby.dismiss')}</button>
      </div>
    </div>
  );
}
