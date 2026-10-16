import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSession } from '../lib/auth';
import { answerCity } from '../api/me';
import { ApiError, type ReportView } from '../api/types';
import { useT } from '../i18n';

/**
 * The city asked the reporter for more information (docs/api.md `cityAsk`).
 *   owner  → the city's words, every answer so far, and a form: the Worker mails the answer to the city (#answer, linked from the email)
 *   anyone else → that the city is waiting on the reporter (signed out: a sign-in link, in case it's theirs)
 * Nothing once the case no longer takes answers and none were given. `onChange` = re-fetch the report.
 */
export default function CityAskCard({ id, view, onChange }: { id: string; view: ReportView; onChange: () => void }) {
  const t = useT();
  const session = useSession();
  const ask = view.cityAsk;
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const mine = view.mine === true;

  // Arriving from the email's "#answer" link: bring the card into view and put the cursor in the box.
  useEffect(() => {
    if (!ask || location.hash !== '#answer') return;
    box.current?.scrollIntoView({ block: 'start' });
    if (mine && ask.canAnswer) field.current?.focus({ preventScroll: true });
  }, [ask, mine]);

  if (!ask) return null;
  const answers = ask.answers ?? [];

  if (!mine) {
    if (!ask.open) return null;
    return (
      <section ref={box} id="answer" className="track-ask track-ask--open card" aria-labelledby="track-ask-h">
        <h2 id="track-ask-h" className="track-ask-title">{t('track.ask.publicTitle')}</h2>
        <p className="track-ask-body">{t('track.ask.publicBody')}</p>
        {!session && <Link className="track-ask-signin" to={`/account?returnTo=${encodeURIComponent(`/r/${id}`)}`}>{t('track.ask.signIn')}</Link>}
      </section>
    );
  }

  if (!ask.canAnswer && !answers.length) {
    return (
      <section ref={box} id="answer" className="track-ask card" aria-labelledby="track-ask-h">
        <h2 id="track-ask-h" className="track-ask-title">{t('track.ask.titleClosed')}</h2>
        {ask.text && <blockquote className="track-ask-text">{ask.text}</blockquote>}
        <p className="track-ask-body muted">{t('track.ask.closed')}</p>
      </section>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const answer = text.trim();
    if (!answer) { setError(t('track.ask.err.empty')); field.current?.focus(); return; }
    setBusy(true); setError(null); setSent(false);
    try {
      await answerCity(id, answer, ask!.id);
      setText(''); setSent(true); onChange();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : '';
      setError(t(
        code === 'blocked' ? 'track.ask.err.blocked'
        : code === 'too_soon' ? 'track.ask.err.tooSoon'
        : code === 'invalid_text' ? 'track.ask.err.empty'
        : code === 'case_closed' || code === 'expired' || code === 'too_many' || code === 'no_ask' ? 'track.ask.err.closed'
        : 'track.ask.err.generic'));
    } finally { setBusy(false); }
  }

  return (
    <section ref={box} id="answer" className={`track-ask card${ask.open ? ' track-ask--open' : ''}`} aria-labelledby="track-ask-h">
      <h2 id="track-ask-h" className="track-ask-title">{ask.open ? t('track.ask.title') : t('track.ask.titleAnswered')}</h2>
      <p className="track-ask-meta">{t('track.ask.askedAt', { time: when(ask.askedAt) })}</p>
      {ask.text && <blockquote className="track-ask-text">{ask.text}</blockquote>}
      {answers.length > 0 && (
        <ul className="track-ask-answers" aria-label={t('track.ask.answersLabel')}>
          {answers.map((a, i) => (
            <li key={`${a.at}-${i}`} className={`track-ask-answer track-ask-answer--${a.status}`}>
              <span className="track-ask-answer-status">
                {a.status === 'sent' ? t('track.ask.sentAt', { time: when(a.at) }) : a.status === 'blocked' ? t('track.ask.blockedAt', { time: when(a.at) }) : t('track.ask.failedAt', { time: when(a.at) })}
              </span>
              <p className="track-ask-answer-text">{a.text}</p>
            </li>
          ))}
        </ul>
      )}
      {sent && <div className="notice notice-ok" role="status">{t('track.ask.sent')}</div>}
      {ask.canAnswer && (
        <form className="track-ask-form" onSubmit={submit} noValidate>
          <label className="label" htmlFor="track-ask-answer">{ask.open ? t('track.ask.label') : t('track.ask.labelMore')}</label>
          <textarea id="track-ask-answer" ref={field} className="textarea" rows={4} maxLength={2000} value={text}
            onChange={(e) => { setText(e.target.value); if (error) setError(null); }} aria-describedby="track-ask-hint" aria-invalid={error ? true : undefined} />
          <p id="track-ask-hint" className="hint">{t('track.ask.hint')}</p>
          {error && <div className="notice notice-error" role="alert">{error}</div>}
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? t('track.ask.sending') : t('track.ask.send')}</button>
        </form>
      )}
    </section>
  );
}

function when(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
