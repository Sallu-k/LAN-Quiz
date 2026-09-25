/*
 * Shared theme picker for every page (team/dashboard/admin/projector).
 * Purely a per-browser preference (localStorage) — nothing is sent to the
 * server, so switching a theme can never disrupt a live round.
 * Loaded synchronously in <head>, right after themes.css, so the saved
 * theme is applied before the page paints (no flash of the wrong theme).
 */
(function () {
  'use strict';
  var THEMES = [
    { id: 'classic', label: 'Classic' },
    { id: 'neon', label: 'Neon' },
    { id: 'monochrome', label: 'Monochrome' },
    { id: 'nature', label: 'Nature' },
  ];
  function get() {
    try { return localStorage.getItem('cq:theme') || 'classic'; } catch (e) { return 'classic'; }
  }
  function apply(id) { document.documentElement.setAttribute('data-theme', id); }
  function set(id) {
    try { localStorage.setItem('cq:theme', id); } catch (e) { /* private mode etc. — theme just won't stick */ }
    apply(id);
  }
  apply(get()); // do this immediately, before the rest of <head>/<body> load

  // Builds a small, self-styled <select> inside `el` and wires it up.
  // Safe to call once DOM is ready (e.g. from a script tag placed where the slot lives).
  function mount(el) {
    if (!document.getElementById('cq-theme-style')) {
      var style = document.createElement('style');
      style.id = 'cq-theme-style';
      style.textContent = '.cq-theme-select{font:inherit;font-size:13px;padding:7px 10px;' +
        'border-radius:8px;border:2px solid var(--line);background:var(--panel2);color:var(--text);cursor:pointer;}';
      document.head.appendChild(style);
    }
    var sel = document.createElement('select');
    sel.className = 'cq-theme-select';
    sel.setAttribute('aria-label', 'Theme');
    THEMES.forEach(function (t) {
      var o = document.createElement('option');
      o.value = t.id; o.textContent = t.label;
      sel.appendChild(o);
    });
    sel.value = get();
    sel.addEventListener('change', function () { set(sel.value); });
    el.appendChild(sel);
    return sel;
  }

  window.CQTheme = { THEMES: THEMES, get: get, set: set, apply: apply, mount: mount };
})();
