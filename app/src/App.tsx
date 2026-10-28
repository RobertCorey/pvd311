import { Suspense, lazy } from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';
import Layout from './components/Layout';
import Report from './screens/Report';
import { weekLinkProblem } from './lib/week';

// Report is the landing screen and stays eager; every other screen is its own
// chunk so the first paint doesn't wait on code the visitor may never use.
const Track = lazy(() => import('./screens/Track'));
const About = lazy(() => import('./screens/About'));
const Privacy = lazy(() => import('./screens/Privacy'));
const NotFound = lazy(() => import('./screens/NotFound'));
const MyReports = lazy(() => import('./screens/MyReports'));
const Account = lazy(() => import('./screens/Account'));
const Admin = lazy(() => import('./screens/Admin'));
const Street = lazy(() => import('./screens/Street'));
const Week = lazy(() => import('./screens/Week'));

/** While a route chunk loads, /week shows a screen-tall blank instead of nothing: with an empty <main> the footer paints
 *  mid-screen for a frame and then gets pushed 3,000 px down by the page (CLS 0.39 on /week, 2026-10-26). Scoped to the
 *  routes measured to need it; /street hides the footer itself once mounted, and the short pages keep their footer.
 *  A /week link the Worker will 400 (lib/week.ts) is a short page too, so it gets no blank either. */
function tallRoute(pathname: string, search: string): boolean {
  const path = pathname.replace(/\/+$/, '') || '/';
  return path === '/week' && weekLinkProblem(new URLSearchParams(search).get('until')) == null;
}
function RouteFallback() {
  const { pathname, search } = useLocation();
  return tallRoute(pathname, search) ? <div className="route-loading" aria-hidden="true" /> : null;
}

export default function App() {
  return (
    <Layout>
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/" element={<Report />} />
          <Route path="/r/:id" element={<Track />} />
          <Route path="/my" element={<MyReports />} />
          <Route path="/street" element={<Street />} />
          <Route path="/week" element={<Week />} />
          <Route path="/account" element={<Account />} />
          <Route path="/account/updates" element={<Account />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="/about" element={<About />} />
          <Route path="/privacy" element={<Privacy />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </Layout>
  );
}
