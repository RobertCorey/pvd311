import { Route, Routes } from 'react-router-dom';
import Layout from './components/Layout';
import Report from './screens/Report';
import Track from './screens/Track';
import Feed from './screens/Feed';
import About from './screens/About';
import Privacy from './screens/Privacy';
import NotFound from './screens/NotFound';

export default function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Report />} />
        <Route path="/r/:id" element={<Track />} />
        <Route path="/map" element={<Feed />} />
        <Route path="/about" element={<About />} />
        <Route path="/privacy" element={<Privacy />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Layout>
  );
}
