import { useT } from '../i18n';
import AccountReports from '../components/AccountReports';

/** Account reports + this device's reports, with status pills, claim, and the empty state — all in AccountReports. */
export default function MyReports() {
  const t = useT();
  return (
    <section className="section">
      <h1>{t('header.myReports')}</h1>
      <AccountReports />
    </section>
  );
}
