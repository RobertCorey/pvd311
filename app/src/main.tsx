import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './index.css';
import App from './App';
import { I18nProvider } from './i18n';
import { registerSW } from 'virtual:pwa-register';

// autoUpdate: the virtual module reloads the page when a new service worker
// takes control; we also poll for updates hourly so long-lived installed PWAs
// don't sit on a stale shell.
registerSW({
  immediate: true,
  onRegisteredSW(_url, reg) { if (reg) setInterval(() => { void reg.update(); }, 60 * 60 * 1000); },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <I18nProvider>
        <App />
      </I18nProvider>
    </BrowserRouter>
  </StrictMode>,
);
