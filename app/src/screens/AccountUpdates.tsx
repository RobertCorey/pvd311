import { useEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { Link } from 'react-router-dom';
import { useT } from '../i18n';
import { deleteAddress, followedCases, followingReports, saveAddress, setAddressDigest, unfollow, unfollowCity, updateMe, type FollowedCase, type Me, type MyReportView, type SavedAddress } from '../api/me';
import { track } from '../lib/analytics';
import { shortLabel } from '../lib/categories';
import { pushSupport } from '../lib/push';
import { caseHref } from '../components/FollowedCases';
import PushCard from '../components/PushCard';

/** Account → Updates (/account/updates): every subscription in one place, one switch per row, no summary. The mails'
 *  footers link here.
 *    Your reports         prefs.emailUpdates (PATCH /api/me); the city's questions always come by email
 *    Your streets         each saved address with its Monday email (PUT /api/me/addresses digest), Remove, Add a street
 *    Requests you follow  followed city requests (GET /api/me/city) and followed reports (GET /api/me/following), Unfollow
 *    Monday city email    prefs.weekDigest — "This week in Providence"
 *    This phone           the one phone-notifications control (components/PushCard); not rendered where push never works
 *  Switches and Remove are optimistic: they change at once, and a failure puts them back with an alert in their section.
 *  Your streets' writes go one at a time (the Worker writes the whole list back from what it read, so two at once would
 *  lose one), and the list the Worker answers shows once none is waiting, so a quick second switch never flicks back. */

const MAX_ADDRESSES = 10;
type Section = 'reports' | 'streets' | 'following' | 'week';
/** One followed request: a city case (GET /api/me/city) or a report (GET /api/me/following). */
type Followed = { kind: 'city'; id: string; item: FollowedCase } | { kind: 'report'; id: string; item: MyReportView };

/** A labelled switch row: the text, then the switch (≥ 44 px, the whole row is the target). */
function Switch({ label, name, checked, onChange }: { label: string; name?: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="switch-row">
      <span>{label}</span>
      <input type="checkbox" role="switch" className="switch" checked={checked} aria-label={name} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

export default function AccountUpdates({ me, setMe }: { me: Me; setMe: Dispatch<SetStateAction<Me | null>> }) {
  const t = useT();
  const [errAt, setErrAt] = useState<Section | null>(null);
  const [addr, setAddr] = useState({ label: '', address: '' });
  const [adding, setAdding] = useState(false);
  const [follows, setFollows] = useState<Followed[] | null>(null);
  const [followsFailed, setFollowsFailed] = useState(false);
  const [pushable] = useState(() => pushSupport() !== 'unsupported');
  const alert = (s: Section) => errAt === s && <p className="notice notice-error" role="alert">{t('account.error.save')}</p>;

  useEffect(() => {
    let live = true;
    // A failed list is not an empty one: say we couldn't load it rather than "You're not following any requests".
    let failed = false;
    const soft = <T,>(p: Promise<{ items: T[] }>) => p.catch(() => { failed = true; return { items: [] as T[] }; });
    Promise.all([soft(followedCases()), soft(followingReports())]).then(([city, reports]) => {
      if (!live) return;
      setFollowsFailed(failed);
      setFollows([
        ...city.items.map((item): Followed => ({ kind: 'city', id: item.id, item })),
        ...reports.items.map((item): Followed => ({ kind: 'report', id: item.id, item })),
      ]);
    });
    return () => { live = false; };
  }, []);
  /** A followed request's row: its title, where it is, and where it opens. */
  const row = (f: Followed) => f.kind === 'city'
    ? { title: f.item.caseType || shortLabel(f.item.category, t), where: f.item.street || t('street.noStreet'), href: caseHref(f.item) }
    : { title: shortLabel(f.item.category, t), where: f.item.address, href: `/r/${f.id}` };

  async function togglePref(patch: Partial<Me['prefs']>, at: Section) {
    const before = me.prefs;
    setErrAt(null);
    setMe((m) => (m ? { ...m, prefs: { ...m.prefs, ...patch } } : m));
    try { const fresh = await updateMe({ prefs: patch }); setMe((m) => (m ? { ...m, prefs: fresh.prefs } : m)); }
    catch { setMe((m) => (m ? { ...m, prefs: before } : m)); setErrAt(at); }
  }
  const withAddresses = (addresses: SavedAddress[]) => setMe((m) => (m ? { ...m, addresses } : m));
  /** The address writes' queue: the last list the Worker answered (a failure shows it again) and how many are waiting. */
  const streets = useRef({ queue: Promise.resolve(), waiting: 0, list: me.addresses });
  function writeStreets(send: () => Promise<{ addresses: SavedAddress[] }>): Promise<void> {
    const q = streets.current;
    q.waiting++;
    const done = q.queue.then(send).then((r) => { q.list = r.addresses; }).finally(() => { if (--q.waiting === 0) withAddresses(q.list); });
    q.queue = done.catch(() => {});
    return done;
  }
  async function setDigest(a: SavedAddress, on: boolean) {
    setErrAt(null);
    withAddresses(me.addresses.map((x) => (x.id === a.id ? { ...x, digest: on } : x)));
    try { await writeStreets(() => setAddressDigest(a, on)); track(on ? 'street_digest_on' : 'street_digest_off', { from: 'account' }); }
    catch { setErrAt('streets'); }
  }
  async function removeAddress(id: string) {
    setErrAt(null);
    withAddresses(me.addresses.filter((x) => x.id !== id));
    try { await writeStreets(() => deleteAddress(id)); } catch { setErrAt('streets'); }
  }
  async function addAddress(e: React.FormEvent) {
    e.preventDefault();
    if (addr.address.trim().length < 3) return;
    setAdding(true); setErrAt(null);
    try { await writeStreets(() => saveAddress({ label: addr.label.trim(), address: addr.address.trim() })); setAddr({ label: '', address: '' }); }
    catch { setErrAt('streets'); } finally { setAdding(false); }
  }
  async function unfollowOne(f: Followed) {
    setErrAt(null);
    try {
      await (f.kind === 'city' ? unfollowCity(f.id) : unfollow(f.id));
      setFollows((cur) => (cur ?? []).filter((x) => !(x.kind === f.kind && x.id === f.id)));
    } catch { setErrAt('following'); }
  }

  const section = (id: string, title: string, children: ReactNode) => (
    <section className="account-section" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {children}
    </section>
  );

  return (
    <div className="account-updates">
      {section('updates-reports', t('account.reports.title'), (
        <div className="card">
          <Switch label={t('account.prefs.emailUpdates')} checked={me.prefs.emailUpdates} onChange={(on) => void togglePref({ emailUpdates: on }, 'reports')} />
          <p className="hint">{t('account.prefs.emailUpdates.hint')}</p>
          {alert('reports')}
        </div>
      ))}

      {section('updates-streets', t('account.addresses.title'), (
        <div className="card">
          {me.addresses.length === 0
            ? <p className="muted account-empty">{t('account.addresses.empty')} <Link to="/street">{t('account.addresses.emptyLink')}</Link></p>
            : <p className="hint account-lead">{t('account.addresses.hint')}</p>}
          <ul className="account-list">
            {me.addresses.map((a) => (
              <li key={a.id} className="account-street">
                <span className="account-street-name"><strong>{a.label}</strong><br /><span className="muted">{a.address}</span></span>
                <Switch label={t('account.addresses.digest')} name={`${t('account.addresses.digest')} — ${a.label}`} checked={a.digest === true} onChange={(on) => void setDigest(a, on)} />
                <button type="button" className="btn btn-ghost" onClick={() => void removeAddress(a.id)} aria-label={`${t('account.addresses.remove')} ${a.label}`}>{t('account.addresses.remove')}</button>
              </li>
            ))}
          </ul>
          {me.addresses.length < MAX_ADDRESSES && (
            <form className="account-inline" onSubmit={addAddress}>
              <div className="account-row">
                <input className="input account-label" value={addr.label} maxLength={40} placeholder={t('account.addresses.labelPlaceholder')} aria-label={t('account.addresses.label')} onChange={(e) => setAddr({ ...addr, label: e.target.value })} />
                <input className="input" value={addr.address} maxLength={300} placeholder={t('account.addresses.addressPlaceholder')} aria-label={t('account.addresses.address')} autoComplete="street-address" onChange={(e) => setAddr({ ...addr, address: e.target.value })} />
              </div>
              <button type="submit" className="btn btn-secondary" disabled={adding || addr.address.trim().length < 3}>{t('account.addresses.add')}</button>
            </form>
          )}
          {alert('streets')}
        </div>
      ))}

      {section('updates-following', t('account.following.title'), (
        <>
          {follows == null ? <p className="muted" aria-busy="true">{t('account.loading')}</p>
            : followsFailed && follows.length === 0 ? <p className="notice notice-error" role="alert">{t('account.following.loadError')}</p>
            : follows.length === 0 ? <p className="muted">{t('account.following.empty')}</p>
            : (
              <div className="card">
                <ul className="account-list account-follows">
                  {follows.map((f) => {
                    const { title, where, href } = row(f);
                    return (
                      <li key={`${f.kind}:${f.id}`} data-kind={f.kind}>
                        <span><Link to={href}><strong>{title}</strong></Link><br /><span className="muted">{where}</span></span>
                        <button type="button" className="btn btn-ghost" aria-label={`${t('account.following.unfollow')} — ${title}, ${where}`} onClick={() => void unfollowOne(f)}>{t('account.following.unfollow')}</button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          {alert('following')}
        </>
      ))}

      {section('updates-week', t('account.week.title'), (
        <div className="card">
          <Switch label={t('account.prefs.weekDigest')} checked={me.prefs.weekDigest === true} onChange={(on) => void togglePref({ weekDigest: on }, 'week')} />
          <p className="hint">{t('account.prefs.weekDigest.hint')}</p>
          {alert('week')}
        </div>
      ))}

      {pushable && section('updates-phone', t('account.phone.title'), (
        <>
          <p className="hint account-lead">{t('account.phone.hint')}</p>
          <PushCard me={me} />
        </>
      ))}
    </div>
  );
}
