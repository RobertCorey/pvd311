import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getStats } from '../api/client';
import { useT } from '../i18n';

/** Home trust line (UX test #9): who we are, what happens, how it works → /about; plus a live count once it means something. */
const MIN_FILED = 20;

export default function TrustLine() {
  const t = useT();
  const [filed, setFiled] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    getStats().then((s) => { if (!cancelled && s && s.filed >= MIN_FILED) setFiled(s.filed); });
    return () => { cancelled = true; };
  }, []);
  return (
    <p className="trust-line">
      <span>{t('home.trust')} </span>
      <Link to="/about" className="trust-link">{t('home.howItWorks')}</Link>
      {filed !== null && <span className="trust-stat" role="status">{t('home.filedCount', { n: filed.toLocaleString() })}</span>}
    </p>
  );
}
