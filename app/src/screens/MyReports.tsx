import { useT } from '../i18n';
import AccountReports from '../components/AccountReports';

/** Account reports + this device's reports, with status pills, claim, and the empty state — all in AccountReports. */
export default function MyReports() {
  const t = useT();
  return (
    <section className="section">
      <h2>{t('header.myReports')}</h2>
      <AccountReports />
    </section>
  );
}
