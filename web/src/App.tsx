import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';
import { SPACES, type Role } from './lib';

const ClientApp = lazy(() => import('./client'));
const MerchantApp = lazy(() => import('./merchant'));
const CourierApp = lazy(() => import('./courier'));
const AdminApp = lazy(() => import('./admin'));

function Landing() {
  useEffect(() => { document.body.classList.remove('mobile-space'); }, []);
  return (
    <div style={{ minHeight: '100%', background: 'linear-gradient(160deg, #1565D8 0%, #0B1E3F 70%)', color: '#fff', padding: '48px 20px' }}>
      <div style={{ maxWidth: 880, margin: '0 auto' }} className="col">
        <div className="brand" style={{ fontSize: 34 }}><img src="/icon.svg" alt="" style={{ width: 46, height: 46 }} /> GreLiv</div>
        <h1 style={{ fontSize: 40, lineHeight: 1.1, marginTop: 10 }}>La livraison à Grenoble,<br /><span style={{ color: '#FF7900' }}>rapide et locale.</span></h1>
        <p style={{ opacity: .85, maxWidth: 560, fontSize: 17 }}>Repas et produits des commerces grenoblois livrés à vélo, scooter ou voiture. Choisissez votre espace :</p>
        <div className="tiles" style={{ marginTop: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))' }}>
          {(Object.keys(SPACES) as Role[]).map((r, i) => (
            <Link key={r} to={SPACES[r].path} className="card tap rise" style={{ color: 'var(--ink)', animationDelay: `${i * 70}ms` }}>
              <div style={{ fontSize: 40 }}>{SPACES[r].emoji}</div>
              <h2 style={{ marginTop: 8 }}>{SPACES[r].label}</h2>
              <p className="muted small">{SPACES[r].tagline}</p>
              <div className="btn btn-sm btn-orange" style={{ marginTop: 12 }}>Ouvrir →</div>
            </Link>
          ))}
        </div>
        <p className="small" style={{ opacity: .7, marginTop: 18 }}>Version de démonstration : les établissements, comptes et commandes présentés sont fictifs. Astuce : ouvrez chaque espace dans un onglet différent pour suivre une commande de bout en bout.</p>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<div className="spinner" />}>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/client/*" element={<ClientApp />} />
          <Route path="/commercant/*" element={<MerchantApp />} />
          <Route path="/livreur/*" element={<CourierApp />} />
          <Route path="/admin/*" element={<AdminApp />} />
          <Route path="*" element={<Landing />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
