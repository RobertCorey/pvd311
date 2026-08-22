import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { BRAND } from '../brand';

export function PinIcon({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="app">
      <header className="app-header">
        <h1 className="app-title"><Link to="/" style={{ color: 'inherit', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 10 }}><PinIcon />{BRAND.name}</Link></h1>
        <p className="app-subtitle">{BRAND.tagline}</p>
        <p className="app-disclaimer">{BRAND.disclaimer}</p>
        <div className="header-line" />
      </header>
      <main>{children}</main>
      <footer className="app-footer">
        <nav aria-label="Site">
          <Link to="/">Report</Link>
          <Link to="/map">Map</Link>
          <Link to="/about">About</Link>
          <Link to="/privacy">Privacy</Link>
          <a href={BRAND.portalUrl} target="_blank" rel="noopener">Official 311 portal</a>
        </nav>
        <div>{BRAND.name} · Providence, RI · <a href={`mailto:${BRAND.contactEmail}`}>{BRAND.contactEmail}</a></div>
      </footer>
    </div>
  );
}
