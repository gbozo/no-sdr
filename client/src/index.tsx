/* @refresh reload */
import { render } from 'solid-js/web';
import App from './App.js';
import './styles/app.css';
import { registerSW } from 'virtual:pwa-register';

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

render(() => <App />, root);
