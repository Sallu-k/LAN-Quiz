/*
 * Shows config.json's "eventName" on every page: fills each .brand element and
 * the "LAN Quiz — …" prefix of the tab title. Pages work unchanged if it fails.
 */
(function () {
  'use strict';
  function apply(name) {
    if (!name) return;
    document.querySelectorAll('.brand').forEach(function (e) { e.textContent = name; });
    document.title = document.title.replace(/^[^—]*—/, name + ' —');
  }
  fetch('/api/info', { cache: 'no-store' })
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (info) {
      if (!info) return;
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { apply(info.eventName); });
      else apply(info.eventName);
    })
    .catch(function () {});
})();
