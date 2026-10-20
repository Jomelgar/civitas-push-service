export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const THEME_STORAGE_KEY = 'civitas-theme';

export const baseCss = `
  :root {
    color-scheme: light;
    --bg-start: #eff6ff;
    --bg-end: #ffffff;
    --card: #ffffff;
    --border: #dbeafe;
    --text: #1e3a8a;
    --muted: #475569;
    --primary: #1d4ed8;
    --primary-2: #1e3a8a;
    --ok: #059669;
    --err: #d32f2f;
    --input-bg: #ffffff;
    --input-border: #dbeafe;
    --focus-ring: rgba(29, 78, 216, 0.25);
    --shadow: rgba(30, 58, 138, 0.12);
    --glow: rgba(29, 78, 216, 0.12);
  }
  [data-theme="dark"] {
    color-scheme: dark;
    --bg-start: #0b0f1a;
    --bg-end: #131a2e;
    --card: rgba(22, 28, 48, 0.85);
    --border: rgba(255, 255, 255, 0.08);
    --text: #eef2ff;
    --muted: #9aa4c7;
    --primary: #3b82f6;
    --primary-2: #1d4ed8;
    --ok: #34d399;
    --err: #f87171;
    --input-bg: rgba(9, 12, 22, 0.65);
    --input-border: rgba(255, 255, 255, 0.08);
    --focus-ring: rgba(59, 130, 246, 0.3);
    --shadow: rgba(0, 0, 0, 0.45);
    --glow: rgba(29, 78, 216, 0.4);
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    color: var(--text);
    background:
      radial-gradient(900px 500px at 15% -10%, var(--glow), transparent 60%),
      linear-gradient(160deg, var(--bg-start), var(--bg-end));
    background-attachment: fixed;
    transition: background 0.2s ease, color 0.2s ease;
  }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 18px;
    box-shadow: 0 24px 60px var(--shadow);
    backdrop-filter: blur(14px);
  }
  h1 { font-size: 1.4rem; margin: 0 0 0.25rem; letter-spacing: -0.01em; }
  p { margin: 0; }
  .muted { color: var(--muted); }
  .small { font-size: 0.78rem; }
  label { display: block; font-size: 0.82rem; color: var(--muted); margin-bottom: 0.9rem; }
  input, textarea, select {
    width: 100%;
    margin-top: 0.35rem;
    padding: 0.7rem 0.85rem;
    font-size: 0.95rem;
    font-family: inherit;
    color: var(--text);
    background: var(--input-bg);
    border: 1px solid var(--input-border);
    border-radius: 11px;
    outline: none;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  input::placeholder, textarea::placeholder { color: var(--muted); opacity: 0.7; }
  input:focus, textarea:focus, select:focus {
    border-color: var(--primary);
    box-shadow: 0 0 0 3px var(--focus-ring);
  }
  textarea { resize: vertical; min-height: 96px; }
  button {
    width: 100%;
    padding: 0.75rem 1rem;
    font-size: 0.95rem;
    font-weight: 600;
    color: #ffffff;
    background: linear-gradient(135deg, var(--primary-2), var(--primary));
    border: none;
    border-radius: 11px;
    cursor: pointer;
    transition: transform 0.08s, filter 0.15s;
  }
  button:hover { filter: brightness(1.08); }
  button:active { transform: translateY(1px); }
  button.ghost {
    width: auto;
    padding: 0.5rem 0.9rem;
    background: transparent;
    border: 1px solid var(--border);
    color: var(--muted);
    font-weight: 500;
  }
  .brand { display: flex; align-items: center; gap: 0.6rem; font-weight: 700; }
  .logo {
    width: 34px;
    height: 34px;
    border-radius: 9px;
    object-fit: cover;
    box-shadow: 0 6px 16px var(--shadow);
  }
  .theme-toggle {
    width: auto;
    padding: 0.5rem 0.9rem;
    background: transparent;
    border: 1px solid var(--border);
    color: var(--muted);
    font-weight: 500;
    white-space: nowrap;
  }
  .error {
    margin-bottom: 1rem;
    padding: 0.6rem 0.8rem;
    font-size: 0.85rem;
    color: var(--err);
    background: color-mix(in srgb, var(--err) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--err) 35%, transparent);
    border-radius: 10px;
  }
  .toast {
    margin-top: 0.9rem;
    padding: 0.6rem 0.8rem;
    font-size: 0.85rem;
    border-radius: 10px;
    display: none;
  }
  .toast.show { display: block; }
  .toast.ok { color: var(--ok); background: color-mix(in srgb, var(--ok) 12%, transparent); border: 1px solid color-mix(in srgb, var(--ok) 35%, transparent); }
  .toast.err { color: var(--err); background: color-mix(in srgb, var(--err) 12%, transparent); border: 1px solid color-mix(in srgb, var(--err) 35%, transparent); }
`;

export function themeInitScript(): string {
  return `<script>
    (function () {
      try {
        var stored = localStorage.getItem('${THEME_STORAGE_KEY}');
        var theme = stored === 'light' || stored === 'dark'
          ? stored
          : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
        document.documentElement.setAttribute('data-theme', theme);
      } catch (e) {}
    })();
  </script>`;
}

export function themeToggleScript(): string {
  return `<script>
    (function () {
      var btn = document.getElementById('theme-toggle');
      if (!btn) return;

      function current() {
        return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
      }

      function label(theme) {
        var next = theme === 'dark' ? 'claro' : 'oscuro';
        var span = btn.querySelector('[data-theme-label]');
        if (span) { span.textContent = 'Modo ' + next; } else { btn.textContent = 'Modo ' + next; }
        btn.setAttribute('aria-label', 'Cambiar a modo ' + next);
      }

      function apply(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        try { localStorage.setItem('${THEME_STORAGE_KEY}', theme); } catch (e) {}
        label(theme);
      }

      label(current());

      btn.addEventListener('click', function () {
        apply(current() === 'dark' ? 'light' : 'dark');
      });

      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function (event) {
        var stored = null;
        try { stored = localStorage.getItem('${THEME_STORAGE_KEY}'); } catch (e) {}
        if (stored !== 'light' && stored !== 'dark') {
          apply(event.matches ? 'dark' : 'light');
        }
      });
    })();
  </script>`;
}

export type IconName = 'devices' | 'key' | 'doc' | 'external' | 'menu' | 'theme' | 'logout';

const ICONS: Record<IconName, string> = {
  devices:
    '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><line x1="10.5" y1="18.4" x2="13.5" y2="18.4"/>',
  key: '<circle cx="7.5" cy="15.5" r="3.5"/><path d="M10 13 19 4m-3 0 2 2M14 9l1.8 1.8"/>',
  doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h6"/>',
  external:
    '<path d="M14 4h6v6"/><path d="M20 4 10.5 13.5"/><path d="M19 14.5V19a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V6.5A1.5 1.5 0 0 1 5 5h4.5"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  theme: '<path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.5 6.5 0 0 0 9.8 9.8z"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
};

export function icon(name: IconName, className = 'ic'): string {
  return `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
}

export const shellCss = `
  body { padding: 0; }
  .ic {
    width: 20px; height: 20px; flex-shrink: 0;
    stroke: currentColor; fill: none; stroke-width: 1.8;
    stroke-linecap: round; stroke-linejoin: round;
  }
  .app { display: flex; min-height: 100vh; }

  .sidebar {
    width: 248px; flex-shrink: 0;
    display: flex; flex-direction: column; gap: 0.4rem;
    padding: 1.25rem 1rem;
    background: color-mix(in srgb, var(--card) 92%, transparent);
    border-right: 1px solid var(--border);
    backdrop-filter: blur(14px);
    position: sticky; top: 0; height: 100vh;
  }
  .side-brand {
    display: flex; align-items: center; gap: 0.7rem;
    padding: 0.35rem 0.5rem 1rem;
    text-decoration: none; color: var(--text);
  }
  .side-brand span { display: flex; flex-direction: column; font-weight: 700; line-height: 1.15; }
  .side-brand small { font-weight: 500; font-size: 0.7rem; color: var(--muted); }
  .nav { display: flex; flex-direction: column; gap: 0.25rem; }
  .nav-item {
    display: flex; align-items: center; gap: 0.7rem;
    width: 100%; padding: 0.65rem 0.75rem;
    font-size: 0.9rem; font-weight: 500;
    color: var(--muted); text-align: left; text-decoration: none;
    background: transparent; border: 1px solid transparent; border-radius: 11px;
    cursor: pointer;
    transition: background 0.15s, color 0.15s, border-color 0.15s;
  }
  .nav-item:hover { filter: none; background: color-mix(in srgb, var(--primary) 8%, transparent); color: var(--text); }
  .nav-item:active { transform: none; }
  .nav-item.active {
    color: var(--primary);
    background: color-mix(in srgb, var(--primary) 12%, transparent);
    border-color: color-mix(in srgb, var(--primary) 25%, transparent);
  }
  .nav-item .chev { width: 15px; height: 15px; opacity: 0.6; margin-left: auto; }
  .badge {
    margin-left: auto; min-width: 22px; padding: 0.05rem 0.4rem;
    font-size: 0.7rem; font-weight: 700; text-align: center;
    color: var(--primary); background: color-mix(in srgb, var(--primary) 16%, transparent);
    border-radius: 999px;
  }
  .side-foot {
    margin-top: auto; display: flex; flex-direction: column; gap: 0.35rem;
    padding-top: 1rem; border-top: 1px solid var(--border);
  }
  .side-user { display: flex; align-items: center; gap: 0.6rem; padding: 0.4rem 0.5rem; }
  .side-user .avatar {
    width: 34px; height: 34px; flex-shrink: 0; display: grid; place-items: center;
    border-radius: 50%; font-weight: 700; font-size: 0.9rem; color: #fff;
    background: linear-gradient(135deg, var(--primary-2), var(--primary)); text-transform: uppercase;
  }
  .side-user .who { display: flex; flex-direction: column; min-width: 0; }
  .side-user .who span { font-size: 0.85rem; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .side-user .who small { font-size: 0.7rem; color: var(--muted); }
  .side-user form { margin-left: auto; }
  .icon-btn {
    width: auto; padding: 0.45rem; display: inline-grid; place-items: center;
    color: var(--muted); background: transparent; border: 1px solid var(--border); border-radius: 9px;
  }
  .icon-btn:hover { filter: none; color: var(--err); border-color: color-mix(in srgb, var(--err) 40%, transparent); }

  .content { flex: 1; min-width: 0; width: 100%; max-width: 1100px; margin: 0 auto; padding: 1.6rem 2rem 3rem; }
  .topbar { display: flex; align-items: center; gap: 0.9rem; margin-bottom: 1.4rem; }
  .topbar h1 { font-size: 1.45rem; margin: 0; letter-spacing: -0.01em; }
  .topbar p { margin: 0.15rem 0 0; }
  .hamburger {
    display: none; width: auto; padding: 0.5rem;
    color: var(--text); background: var(--card); border: 1px solid var(--border); border-radius: 10px;
  }
  .hamburger:hover { filter: none; }

  .panel { padding: 1.5rem; }
  .panel h2 { font-size: 1rem; margin: 0 0 1rem; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 0.9rem; }
  .fieldset {
    border: 1px solid var(--border); border-radius: 14px;
    padding: 1rem 1.1rem 0.2rem; margin-bottom: 1.1rem;
  }
  .fieldset legend {
    padding: 0 0.5rem; font-size: 0.72rem; text-transform: uppercase;
    letter-spacing: 0.06em; color: var(--muted);
  }
  .devices { display: flex; flex-direction: column; gap: 0.6rem; max-height: 560px; overflow: auto; }
  .device {
    padding: 0.75rem 0.9rem; border: 1px solid var(--border); border-radius: 12px;
    background: color-mix(in srgb, var(--primary) 4%, transparent);
    cursor: pointer; transition: border-color 0.15s, transform 0.08s;
  }
  .device:hover { border-color: var(--primary); }
  .device:active { transform: translateY(1px); }
  .device-id { font-weight: 600; font-size: 0.9rem; word-break: break-all; }
  .empty { padding: 1rem; text-align: center; }
  .toolbar { display: flex; gap: 0.6rem; align-items: center; margin-bottom: 0.9rem; }
  .toolbar input { margin-top: 0; }
  .key-actions { display: flex; gap: 0.5rem; margin-top: 0.6rem; }
  .key-actions button.ghost { width: auto; font-size: 0.78rem; padding: 0.35rem 0.7rem; }
  .key-actions button.danger { color: var(--err); border-color: color-mix(in srgb, var(--err) 40%, transparent); }
  .new-key {
    display: inline-block; margin: 0 0.5rem; padding: 0.15rem 0.45rem;
    font-size: 0.82rem; word-break: break-all;
    background: color-mix(in srgb, var(--primary) 10%, transparent);
    border: 1px solid var(--border); border-radius: 7px;
  }
  .overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.4); z-index: 40; }
  .mt { margin-top: 1.25rem; }

  @media (max-width: 900px) {
    .sidebar {
      position: fixed; left: 0; top: 0; z-index: 50;
      transform: translateX(-100%); transition: transform 0.22s ease;
      box-shadow: 0 0 40px var(--shadow);
    }
    .sidebar.open { transform: none; }
    .hamburger { display: inline-grid; place-items: center; }
    .content { padding: 1.1rem 1rem 2.5rem; }
    .row { grid-template-columns: 1fr; }
  }
  @media (min-width: 901px) { .overlay { display: none !important; } }
`;

export interface ShellOptions {
  user: string;
  content: string;
}

export function appShell({ user, content }: ShellOptions): string {
  const initial = (user.trim()[0] ?? '?').toUpperCase();
  return `<div class="app">
    <aside class="sidebar" id="sidebar">
      <a class="side-brand" href="#/notify" id="brand-home">
        <img class="logo" src="/assets/icon.png" alt="Civitas Access" />
        <span>Civitas Access<small>Panel de notificaciones</small></span>
      </a>
      <nav class="nav" role="tablist" aria-label="Secciones">
        <button class="nav-item" type="button" role="tab" data-route="#/notify" aria-selected="false" aria-controls="panel-notify">
          ${icon('external')}<span>Notificación individual</span>
        </button>
        <button class="nav-item" type="button" role="tab" data-route="#/batches" aria-selected="false" aria-controls="panel-batches">
          ${icon('devices')}<span>Lotes</span>
        </button>
        <button class="nav-item" type="button" role="tab" data-route="#/devices" aria-selected="false" aria-controls="panel-devices">
          ${icon('devices')}<span>Dispositivos</span><span class="badge" id="badge-devices" hidden>0</span>
        </button>
        <button class="nav-item" type="button" role="tab" data-route="#/keys" aria-selected="false" aria-controls="panel-keys">
          ${icon('key')}<span>API Keys</span><span class="badge" id="badge-keys" hidden>0</span>
        </button>
        <a class="nav-item" href="/ui" target="_blank" rel="noopener">
          ${icon('doc')}<span>Documentación</span>${icon('external', 'ic chev')}
        </a>
      </nav>
      <div class="side-foot">
        <button type="button" id="theme-toggle" class="nav-item">${icon('theme')}<span data-theme-label>Modo oscuro</span></button>
        <div class="side-user">
          <div class="avatar">${escapeHtml(initial)}</div>
          <div class="who"><span>${escapeHtml(user)}</span><small>Administrador</small></div>
          <form method="post" action="/logout">
            <button class="icon-btn" type="submit" title="Salir" aria-label="Salir">${icon('logout')}</button>
          </form>
        </div>
      </div>
    </aside>
    <div class="overlay" id="overlay" hidden></div>
    <main class="content">
      <header class="topbar">
        <button type="button" class="hamburger" id="menu-toggle" aria-label="Abrir menú">${icon('menu')}</button>
        <div>
          <h1 id="page-title">Notificación</h1>
          <p id="page-subtitle" class="muted small">Envía una notificación push a un dispositivo.</p>
        </div>
      </header>
      <div class="panels">
${content}
      </div>
    </main>
  </div>`;
}

export function shellScript(): string {
  return `<script>
    (function () {
      var routes = {
        '#/notify': { title: 'Notificación', subtitle: 'Envía una notificación push inmediata a un dispositivo.', panel: 'panel-notify', nav: '#/notify' },
        '#/batches': { title: 'Lotes', subtitle: 'Progreso del procesamiento y resultados por dispositivo.', panel: 'panel-batches', nav: '#/batches' },
        '#/devices': { title: 'Dispositivos', subtitle: 'Dispositivos registrados y su último contacto.', panel: 'panel-devices', nav: '#/devices' },
        '#/keys': { title: 'API Keys', subtitle: 'Claves de acceso para servicios externos.', panel: 'panel-keys', nav: '#/keys' }
      };
      var sidebar = document.getElementById('sidebar');
      var overlay = document.getElementById('overlay');
      var titleEl = document.getElementById('page-title');
      var subtitleEl = document.getElementById('page-subtitle');
      var navItems = Array.prototype.slice.call(document.querySelectorAll('.nav-item[data-route]'));

      function currentRoute() {
        var hash = window.location.hash;
        return routes[hash] ? hash : '#/notify';
      }

      function apply() {
        var route = currentRoute();
        var cfg = routes[route];
        var panels = document.querySelectorAll('.tab-panel');
        for (var i = 0; i < panels.length; i++) {
          panels[i].hidden = panels[i].id !== cfg.panel;
        }
        titleEl.textContent = cfg.title;
        subtitleEl.textContent = cfg.subtitle;
        navItems.forEach(function (item) {
          var active = item.getAttribute('data-route') === cfg.nav;
          item.classList.toggle('active', active);
          item.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        document.dispatchEvent(new CustomEvent('routechange', { detail: { route: route } }));
      }

      function openDrawer() {
        sidebar.classList.add('open');
        overlay.hidden = false;
      }
      function closeDrawer() {
        sidebar.classList.remove('open');
        overlay.hidden = true;
      }

      navItems.forEach(function (item) {
        item.addEventListener('click', function () {
          var route = item.getAttribute('data-route');
          if (window.location.hash === route) apply();
          else window.location.hash = route;
          closeDrawer();
        });
      });

      var brand = document.getElementById('brand-home');
      if (brand) brand.addEventListener('click', closeDrawer);

      var toggle = document.getElementById('menu-toggle');
      if (toggle) toggle.addEventListener('click', function () {
        if (sidebar.classList.contains('open')) closeDrawer(); else openDrawer();
      });
      if (overlay) overlay.addEventListener('click', closeDrawer);
      document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') closeDrawer();
      });

      window.__setBadge = function (id, count) {
        var el = document.getElementById(id);
        if (!el) return;
        if (count > 0) { el.textContent = String(count); el.hidden = false; }
        else { el.hidden = true; }
      };

      if (!routes[window.location.hash]) {
        history.replaceState(null, '', '#/notify');
      }
      window.addEventListener('hashchange', apply);
      apply();
    })();
  </script>`;
}
