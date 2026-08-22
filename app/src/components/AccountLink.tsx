import { Link } from 'react-router-dom';
import { useSession } from '../lib/auth';
import { useT } from '../i18n';

/** Header link: "Sign in" when anonymous, "Account" when signed in. Drop-in for Layout. */
export default function AccountLink({ className = 'header-link' }: { className?: string }) {
  const t = useT();
  const session = useSession();
  return <Link to="/account" className={className}>{session ? t('header.accountIn') : t('header.account')}</Link>;
}
