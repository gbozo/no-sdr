// ============================================================
// Admin Page — Full-page admin route with left nav + right content
// ============================================================

import { Component, Show, onMount, onCleanup, createSignal } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { adminStore, type AdminSection } from './admin-store';
import GeneralSection from './sections/GeneralSection';
import DevicesSection from './sections/DevicesSection';
import BookmarksSection from './sections/BookmarksSection';
import FeaturesSection from './sections/FeaturesSection';
import MonitorSection from './sections/MonitorSection';
import IdentifySection from './sections/IdentifySection';

const NAV_ITEMS: { id: AdminSection; label: string; icon: string }[] = [
  { id: 'general', label: 'General', icon: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z' },
  { id: 'devices', label: 'SDR Devices', icon: 'M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z' },
  { id: 'bookmarks', label: 'Bookmarks', icon: 'M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z' },
  { id: 'features', label: 'Features', icon: 'M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2z' },
  { id: 'monitor', label: 'Monitor', icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z' },
  { id: 'identify', label: 'Music ID', icon: 'M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3' },
];

const AdminPage: Component = () => {
  const navigate = useNavigate();
  const [loginPassword, setLoginPassword] = createSignal('');

  onMount(async () => {
    await adminStore.checkSession();
  });

  // Ctrl+S / Cmd+S to save
  const handleKeydown = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      if (adminStore.dirty() && !adminStore.saving()) {
        adminStore.saveConfig();
      }
    }
  };

  // Warn before leaving with unsaved changes
  const handleBeforeUnload = (e: BeforeUnloadEvent) => {
    if (adminStore.dirty()) {
      e.preventDefault();
      e.returnValue = '';
    }
  };

  onMount(() => {
    document.addEventListener('keydown', handleKeydown);
    window.addEventListener('beforeunload', handleBeforeUnload);
  });

  onCleanup(() => {
    document.removeEventListener('keydown', handleKeydown);
    window.removeEventListener('beforeunload', handleBeforeUnload);
  });

  const handleLogin = async (e: Event) => {
    e.preventDefault();
    await adminStore.login(loginPassword());
    setLoginPassword('');
  };

  const handleBack = () => {
    if (adminStore.dirty()) {
      if (!confirm('You have unsaved changes. Leave without saving?')) return;
    }
    navigate('/');
  };

  return (
    <div class="h-screen flex flex-col bg-sdr-base text-text-primary">
      {/* Top Bar */}
      <header class="h-11 bg-sdr-surface border-b border-border flex items-center px-4 shrink-0">
        <div class="absolute top-0 inset-x-0 h-[2px]
                    bg-gradient-to-r from-cyan via-amber to-cyan opacity-70" />

        <button
          onClick={handleBack}
          class="flex items-center gap-2 text-text-dim hover:text-text-primary transition-colors mr-4"
        >
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
          <span class="text-[10px] font-mono uppercase tracking-wider">Back to SDR</span>
        </button>

        <h1 class="font-mono text-xs font-bold tracking-[0.15em] uppercase flex-1">
          <span class="text-cyan">NO</span><span class="text-text-dim">(DE)</span><span class="text-cyan">-SDR</span>
          <span class="text-text-dim ml-2">/</span>
          <span class="text-amber ml-2">ADMIN</span>
        </h1>

        {/* Save button + status */}
        <Show when={adminStore.authenticated()}>
          <div class="flex items-center gap-3">
            {/* Dirty indicator */}
            <Show when={adminStore.dirty()}>
              <span class="text-[9px] font-mono text-amber uppercase tracking-wider animate-pulse">
                Unsaved Changes
              </span>
            </Show>

            {/* Save success */}
            <Show when={adminStore.saveSuccess()}>
              <span class="text-[9px] font-mono text-status-online uppercase tracking-wider">
                Saved
              </span>
            </Show>

            {/* Save error */}
            <Show when={!!adminStore.saveError()}>
              <span class="text-[9px] font-mono text-status-error uppercase tracking-wider max-w-48 truncate" title={adminStore.saveError()}>
                {adminStore.saveError()}
              </span>
            </Show>

            {/* Save button */}
            <button
              onClick={() => adminStore.saveConfig()}
              disabled={!adminStore.dirty() || adminStore.saving()}
              class={`px-3 py-1 text-[10px] font-mono uppercase tracking-wider rounded-sm border transition-all
                ${adminStore.dirty()
                  ? 'border-cyan text-cyan hover:bg-cyan hover:text-text-inverse'
                  : 'border-border text-text-dim cursor-not-allowed opacity-50'}`}
            >
              {adminStore.saving() ? 'Saving...' : 'Save Config'}
            </button>

            {/* Logout */}
            <button
              onClick={() => adminStore.logout()}
              class="px-2 py-1 text-[9px] font-mono uppercase tracking-wider
                     text-text-dim hover:text-status-error border border-border rounded-sm
                     hover:border-status-error transition-colors"
            >
              Logout
            </button>
          </div>
        </Show>
      </header>

      {/* Main Area */}
      <div class="flex-1 flex min-h-0">
        <Show
          when={!adminStore.authChecking()}
          fallback={<LoadingState />}
        >
          <Show
            when={adminStore.authenticated()}
            fallback={<LoginForm password={loginPassword()} setPassword={setLoginPassword} onSubmit={handleLogin} />}
          >
            {/* Left Navigation */}
            <nav class="w-56 bg-sdr-surface border-r border-border flex flex-col shrink-0">
              <div class="flex-1 py-2">
                {NAV_ITEMS.map(item => (
                  <NavItem
                    id={item.id}
                    label={item.label}
                    icon={item.icon}
                    active={adminStore.activeSection() === item.id}
                    onClick={() => adminStore.setActiveSection(item.id)}
                  />
                ))}
              </div>

              {/* Version info at bottom */}
              <div class="border-t border-border px-4 py-3">
                <p class="text-[8px] font-mono text-text-dim uppercase tracking-wider">
                  Config v{adminStore.configVersion()}
                </p>
              </div>
            </nav>

            {/* Right Content Area */}
            <main class="flex-1 overflow-y-auto p-6">
              <SectionContent />
            </main>
          </Show>
        </Show>
      </div>
    </div>
  );
};

// ---- Sub-components ----

const NavItem: Component<{ id: AdminSection; label: string; icon: string; active: boolean; onClick: () => void }> = (props) => (
  <button
    onClick={props.onClick}
    class={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors
      ${props.active
        ? 'bg-sdr-elevated text-cyan border-r-2 border-cyan'
        : 'text-text-secondary hover:text-text-primary hover:bg-sdr-elevated/50'}`}
  >
    <svg class="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d={props.icon} />
    </svg>
    <span class="text-[11px] font-mono uppercase tracking-wider">{props.label}</span>
  </button>
);

const SectionContent: Component = () => {
  const section = () => adminStore.activeSection();

  return (
    <Show when={true}>
      {(() => {
        switch (section()) {
          case 'general': return <GeneralSection />;
          case 'devices': return <DevicesSection />;
          case 'bookmarks': return <BookmarksSection />;
          case 'identify': return <IdentifySection />;
          case 'features': return <FeaturesSection />;
          case 'monitor': return <MonitorSection />;
          default: return <GeneralSection />;
        }
      })()}
    </Show>
  );
};

const LoginForm: Component<{ password: string; setPassword: (v: string) => void; onSubmit: (e: Event) => void }> = (props) => (
  <div class="flex-1 flex items-center justify-center">
    <form onSubmit={props.onSubmit} class="w-80 p-6 bg-sdr-surface border border-border rounded-md">
      <div class="flex items-center gap-3 mb-6">
        <svg class="w-6 h-6 text-amber" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0110 0v4" />
        </svg>
        <h2 class="text-sm font-mono uppercase tracking-wider text-text-primary">Admin Login</h2>
      </div>
      <input
        id="username"
        type="text"
        name="username"
        autocomplete="username"
        class="hidden"        
      />
      <input
        type="password"
        value={props.password}
        onInput={(e) => props.setPassword(e.currentTarget.value)}
        placeholder="Enter admin password"
        autocomplete="current-password"
        class="w-full px-3 py-2 bg-sdr-base border border-border rounded-sm
               text-xs font-mono text-text-primary placeholder-text-dim
               focus:outline-none focus:border-cyan transition-colors"
        autofocus
      />

      <Show when={!!adminStore.authError()}>
        <p class="mt-2 text-[10px] font-mono text-status-error">{adminStore.authError()}</p>
      </Show>

      <button
        type="submit"
        class="mt-4 w-full px-3 py-2 text-[10px] font-mono uppercase tracking-wider
               border border-cyan text-cyan rounded-sm
               hover:bg-cyan hover:text-text-inverse transition-colors"
      >
        Authenticate
      </button>
    </form>
  </div>
);

const LoadingState: Component = () => (
  <div class="flex-1 flex items-center justify-center">
    <div class="text-text-dim text-xs font-mono uppercase tracking-wider animate-pulse">
      Checking session...
    </div>
  </div>
);

export default AdminPage;
