import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import Layout from './components/Layout';
import Report from './screens/Report';

// Report is the landing screen and stays eager; every other screen is its own
// chunk so the first paint doesn't wait on code the visitor may never use.
const Track = lazy(() => import('./screens/Track'));
const About = lazy(() => import('./screens/About'));
const Privacy = lazy(() => import('./screens/Privacy'));
const NotFound = lazy(() => import('./screens/NotFound'));
const MyReports = lazy(() => import('./screens/MyReports'));
const Account = lazy(() => import('./screens/Account'));
const Admin = lazy(() => import('./screens/Admin'));

export default function App() {
  return (
    <Layout>
      <Suspense fallback={null}>
        <Routes>
          <Route path="/" element={<Report />} />
          <Route path="/r/:id" element={<Track />} />
          <Route path="/map" element={<Navigate to="/" replace />} />
          <Route path="/my" element={<MyReports />} />
          <Route path="/account" element={<Account />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="/about" element={<About />} />
          <Route path="/privacy" element={<Privacy />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </Layout>
  );
}
