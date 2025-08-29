(function () {
  async function inject(name, el) {
    try {
      const res = await fetch(`/partials/${name}.html`, { cache: 'no-store' });
      if (res.ok) el.outerHTML = await res.text();
    } catch (_) {}
  }
  function ready(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn);
    } else {
      fn();
    }
  }
  ready(() => {
    document.querySelectorAll('[data-include="header"]').forEach(el => inject('header', el));
    document.querySelectorAll('[data-include="footer"]').forEach(el => inject('footer', el));
  });
})();
