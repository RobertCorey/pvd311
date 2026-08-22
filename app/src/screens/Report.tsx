import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ALL_CATEGORIES, EXTRA_QUESTIONS, FEATURED, byKey, inSeason, type UiCategory } from '../lib/categories';
import { compressImage, forwardGeocode, inProvidence, readExifGps, reverseGeocode } from '../lib/geo';
import { intake, submitReport } from '../api/client';
import { ApiError, type IntakeResult } from '../api/types';
import Turnstile from '../components/Turnstile';
import CategoryIcon from '../components/CategoryIcon';
import './Report.css';

type Loc = { lat: number; lng: number } | null;

export default function Report() {
  const navigate = useNavigate();

  // --- category ---
  const [category, setCategory] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const visible = useMemo(() => ALL_CATEGORIES.filter((c) => inSeason(c)), []);
  const featured = useMemo(() => FEATURED.map(byKey).filter((c): c is UiCategory => !!c && inSeason(c)), []);
  const others = useMemo(() => visible.filter((c) => !FEATURED.includes(c.key)), [visible]);
  const cat = byKey(category);

  // --- photo ---
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [photoHasGps, setPhotoHasGps] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

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

  // --- contact / submit ---
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileNonce, setTurnstileNonce] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => { if (photoUrl) URL.revokeObjectURL(photoUrl); }, [photoUrl]);

  // Photo chosen → preview + EXIF location.
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
        setLocMsg('Location found in photo.');
        const label = await reverseGeocode(gps.lat, gps.lng).catch(() => null);
        if (label) { setAddress(label); geocodedFor.current = label; }
      } else if (gps) {
        setLocMsg('Photo location looks outside Providence — check the address.');
      }
    } catch { /* no EXIF */ }
  }, [photoUrl]);

  const detect = useCallback(() => {
    if (!navigator.geolocation) { setLocMsg('Location not available on this device — type the address.'); return; }
    setDetecting(true); setLocMsg('Finding you…');
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const { latitude: lat, longitude: lng } = pos.coords;
      setDetecting(false);
      if (!inProvidence(lat, lng)) { setOutside(true); setLoc(null); setLocMsg('You appear to be outside Providence — type the address of the issue.'); return; }
      setLoc({ lat, lng }); setOutside(false); setLocMsg('Location found.');
      const label = await reverseGeocode(lat, lng).catch(() => null);
      if (label) { setAddress(label); geocodedFor.current = label; } else setLocMsg('Got your location — add the nearest address.');
    }, () => { setDetecting(false); setLocMsg('Could not get your location — type the address.'); }, { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 });
  }, []);

  // Typed address → geocode on blur (never blocks).
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

  // Intake (moderation + polish) after a pause in typing.
  useEffect(() => {
    const text = description.trim();
    if (!text || wordingApplied !== null) return;
    const key = JSON.stringify([category, text]);
    if (key === intakeKey.current) return;
    const t = setTimeout(async () => {
      intakeKey.current = key;
      setIntakeBusy(true);
      const r = await intake({ category, description: text, address: address.trim(), extra, hasPhoto: !!photo }, turnstileToken);
      if (intakeKey.current === key) { setIntakeRes(r); setIntakeBusy(false); }
    }, 1200);
    return () => clearTimeout(t);
  }, [description, category, address, extra, photo, turnstileToken, wordingApplied]);

  const applyWording = () => {
    if (!intakeRes?.polishedDescription) return;
    if (wordingApplied === null) { setWordingApplied(description); setDescription(intakeRes.polishedDescription); }
    else { setDescription(wordingApplied); setWordingApplied(null); }
  };

  const photoRequired = cat ? cat.photoRequired : true;
  const canSubmit = !!cat && address.trim().length >= 3 && (!!photo || !photoRequired) && !!turnstileToken && !submitting && !outside;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || !cat || !turnstileToken) return;
    setSubmitting(true); setError(null);
    try {
      const blob = photo ? await compressImage(photo).catch(() => photo) : null;
      const created = await submitReport({
        category: cat.key,
        description: description.trim(),
        address: address.trim(),
        lat: loc?.lat ?? null, lng: loc?.lng ?? null,
        extra: Object.keys(extra).length ? extra : null,
        email: email.trim() || undefined,
        name: name.trim() || undefined,
        turnstileToken,
        descriptionOriginal: wordingApplied !== null && wordingApplied.trim() !== description.trim() ? wordingApplied.trim() : undefined,
        intakeFlags: intakeRes?.flags.length ? intakeRes.flags : undefined,
        photo: blob,
      });
      rememberReport(created.id);
      navigate(created.trackingUrl || `/r/${created.id}`, { state: { justSubmitted: true } });
    } catch (err) {
      setSubmitting(false);
      setTurnstileToken(null); setTurnstileNonce((n) => n + 1); // tokens are single-use
      if (err instanceof ApiError) {
        if (err.code === 'rate_limited') setError(`Easy there — one report every few minutes per device. Try again in ${err.retryAfterSec ? Math.ceil(err.retryAfterSec / 60) + ' min' : 'a few minutes'}.`);
        else if (err.code === 'turnstile_failed') setError('The spam check did not pass. Please try again.');
        else if (err.status === 400) setError(err.field ? `Please check the ${err.field} field.` : 'Something in the report was not accepted. Please check it and try again.');
        else setError('Could not send your report. Please try again.');
      } else if ((err as Error)?.name === 'AbortError') setError('Sending timed out. Check your connection and try again.');
      else setError('Could not send your report. Check your connection and try again.');
    }
  }

  return (
    <form className="report" onSubmit={onSubmit} noValidate>
      {/* 1. Category */}
      <section className="section">
        <h2>What's the issue?</h2>
        <div className="cat-grid" role="radiogroup" aria-label="Issue type">
          {featured.map((c) => <CatButton key={c.key} c={c} selected={category === c.key} onPick={setCategory} />)}
          {!showAll && (
            <button type="button" className="cat-btn cat-btn-other" onClick={() => setShowAll(true)} aria-expanded={false}>
              <span className="cat-icon"><CategoryIcon k="other" /></span><span className="cat-text">Other…</span>
            </button>
          )}
          {showAll && others.map((c) => <CatButton key={c.key} c={c} selected={category === c.key} onPick={setCategory} />)}
        </div>
      </section>

      {cat && (
        <>
          {/* 2. Photo */}
          <section className="section">
            <h2>{photoRequired ? 'Add a photo' : 'Add a photo (optional)'}</h2>
            <p className="hint">{photoRequired ? 'A photo helps the city find and fix it; its location data fills in the address.' : 'Optional for this issue — a photo still helps.'}</p>
            <input ref={fileRef} id="photo" type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={(e) => onPhoto(e.target.files?.[0] ?? null)} />
            {!photoUrl ? (
              <button type="button" className="photo-btn" onClick={() => fileRef.current?.click()}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z" /><circle cx="12" cy="13" r="4" /></svg>
                Tap to open camera
              </button>
            ) : (
              <div className="photo-preview">
                <img src={photoUrl} alt="Your photo" />
                <div className="photo-actions">
                  <span className={photoHasGps ? 'ok' : 'muted'}>{photoHasGps ? 'Photo + location attached' : 'Photo attached'}</span>
                  <button type="button" className="btn btn-ghost" onClick={() => { onPhoto(null); fileRef.current?.click(); }}>Retake</button>
                </div>
              </div>
            )}
          </section>

          {/* 3. Location */}
          <section className="section">
            <h2>Where is it?</h2>
            {locMsg && <p className="hint" aria-live="polite">{locMsg}</p>}
            {!loc && (
              <button type="button" className="btn btn-secondary detect-btn" onClick={detect} disabled={detecting}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M12 2v4M12 18v4M2 12h4M18 12h4" /></svg>
                {detecting ? 'Finding you…' : 'Use my location'}
              </button>
            )}
            <label className="label" htmlFor="address">Address or intersection</label>
            <input id="address" className="input" value={address} placeholder='e.g. "25 Dorrance St" or "Benefit St & Waterman St"'
              autoComplete="street-address" onChange={(e) => { setAddress(e.target.value); if (!photoHasGps) { setLoc(null); setOutside(false); } }} onBlur={geocodeAddress} />
            {outside && <div className="notice notice-warn" role="alert">That address looks outside Providence. We only submit reports within city limits — double-check the street.</div>}
          </section>

          {/* 4. Details */}
          <section className="section">
            <h2>Details</h2>
            {cat.extra.map((k) => {
              const q = EXTRA_QUESTIONS[k]; if (!q) return null;
              const id = `extra_${k}`;
              return (
                <div key={k} className="field">
                  <label className="label" htmlFor={id}>{q.label}</label>
                  {q.type === 'choice' ? (
                    <select id={id} className="select" value={extra[k] ?? ''} onChange={(e) => setExtra({ ...extra, [k]: e.target.value })}>
                      <option value="">Choose…</option>
                      {q.options!.map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  ) : (
                    <input id={id} className="input" placeholder={q.placeholder} value={extra[k] ?? ''} onChange={(e) => setExtra({ ...extra, [k]: e.target.value })} />
                  )}
                </div>
              );
            })}
            <div className="field">
              <label className="label" htmlFor="description">Description (optional)</label>
              <textarea id="description" className="textarea" rows={3} placeholder="Any details that help the city find and fix it…" value={description}
                onChange={(e) => { setDescription(e.target.value); if (wordingApplied !== null && e.target.value !== intakeRes?.polishedDescription) setWordingApplied(null); }} />
            </div>
            {intakeBusy && <p className="hint" aria-live="polite">Checking your description…</p>}
            {intakeRes && (
              <div className="intake" aria-live="polite">
                {intakeRes.flags.includes('emergency') && <div className="notice notice-error"><strong>Emergency?</strong> <span>{intakeRes.note ?? 'If someone is in danger, call 911. 311 reports are not monitored around the clock.'}</span></div>}
                {!intakeRes.flags.includes('emergency') && intakeRes.flags.includes('not_311') && <div className="notice notice-warn">{intakeRes.note ?? 'This may not be something Providence 311 handles. You can still send it and we will take a look.'}</div>}
                {intakeRes.polishedDescription && (wordingApplied !== null || intakeRes.polishedDescription !== description.trim()) && (
                  <div className="card intake-card">
                    <span className="label">Clearer wording</span>
                    <p className="intake-quote">“{intakeRes.polishedDescription}”</p>
                    <button type="button" className={`btn btn-ghost${wordingApplied !== null ? ' applied' : ''}`} onClick={applyWording}>{wordingApplied !== null ? 'Undo — keep my wording' : 'Use this wording'}</button>
                  </div>
                )}
              </div>
            )}
          </section>

          {/* 5. Contact */}
          <section className="section">
            <label className="label" htmlFor="email">Your email (recommended)</label>
            <input id="email" className="input" type="email" inputMode="email" autoComplete="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            <p className="hint">We pass it to the city so you get their updates on this report. Nothing else; no newsletters.</p>
            <input id="name" className="input" type="text" autoComplete="name" placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
          </section>

          {/* 6. Submit */}
          <section className="section">
            <p className="public-record">Your report (photo, location, description) becomes a public record with the City of Providence once submitted.</p>
            <Turnstile key={turnstileNonce} onToken={setTurnstileToken} />
            {error && <div className="notice notice-error" role="alert">{error}</div>}
            <button type="submit" className="btn btn-primary" disabled={!canSubmit}>{submitting ? 'Sending…' : 'Submit report'}</button>
            {!turnstileToken && !submitting && <p className="hint" style={{ textAlign: 'center' }}>Waiting for the spam check…</p>}
          </section>
        </>
      )}
    </form>
  );
}

function CatButton({ c, selected, onPick }: { c: UiCategory; selected: boolean; onPick: (k: string) => void }) {
  return (
    <button type="button" role="radio" aria-checked={selected} className={`cat-btn${selected ? ' selected' : ''}`} onClick={() => onPick(c.key)} data-category={c.key}>
      <span className="cat-icon"><CategoryIcon k={c.key} /></span>
      <span className="cat-text">{c.short}</span>
      <span className="cat-check" aria-hidden="true">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="2.5,6 5,8.5 9.5,3.5" /></svg>
      </span>
    </button>
  );
}

/** Track the reports this device submitted (for "My reports"). */
export function rememberReport(id: string) {
  try {
    const k = 'pvd311.myReports';
    const list: string[] = JSON.parse(localStorage.getItem(k) ?? '[]');
    if (!list.includes(id)) list.unshift(id);
    localStorage.setItem(k, JSON.stringify(list.slice(0, 50)));
  } catch { /* ignore */ }
}
