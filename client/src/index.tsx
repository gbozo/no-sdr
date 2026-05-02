/* @refresh reload */
import { render } from 'solid-js/web';
import { Router, Route } from '@solidjs/router';
import { lazy } from 'solid-js';
import App from './App.js';
import './styles/app.css';
import { registerSW } from 'virtual:pwa-register';

// Lazy-load admin page (not needed for SDR users)
const AdminPage = lazy(() => import('./admin/AdminPage.js'));

// Register service worker — autoUpdate silently updates in background
registerSW({
  onNeedRefresh() {
    // New content available — auto-update handles reload
  },
  onOfflineReady() {
    console.log('[PWA] App ready for offline use');
  },
});

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');

render(
  () => (
    <Router>
      <Route path="/" component={App} />
      <Route path="/admin" component={AdminPage} />
    </Router>
  ),
  root,
);
