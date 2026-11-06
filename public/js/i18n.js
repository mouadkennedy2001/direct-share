'use strict';
/**
 * i18n — يحمّل public/lang/<lang>.json ويطبّقه على العناصر ذات data-i18n*.
 * لا يستخدم innerHTML إطلاقاً: يدعم فقط <br> كفاصل أسطر (آمن ضد الحقن).
 */
(function () {
  const SUPPORTED = ['ar', 'en'];
  const DEFAULT_LANG = 'ar';
  let lang = localStorage.getItem('p2p-lang') || DEFAULT_LANG;
  if (!SUPPORTED.includes(lang)) lang = DEFAULT_LANG;
  let dict = {};
  const listeners = [];

  const get = (path) => path.split('.').reduce((o, k) => (o && o[k] != null ? o[k] : undefined), dict);
  window.t = (path) => { const v = get(path); return v === undefined ? path : v; };
  window.getLang = () => lang;
  window.onLangChange = (fn) => { listeners.push(fn); };

  // نص آمن مع دعم <br> فقط
  function setRich(el, value) {
    const parts = String(value).split('<br>');
    el.textContent = '';
    parts.forEach((part, i) => {
      if (i) el.appendChild(document.createElement('br'));
      el.appendChild(document.createTextNode(part));
    });
  }

  function apply() {
    const meta = dict.meta || {};
    document.documentElement.lang = meta.lang || lang;
    document.documentElement.dir = meta.dir || (lang === 'ar' ? 'rtl' : 'ltr');
    if (meta.title) document.title = meta.title;
    const desc = document.querySelector('meta[name="description"]');
    if (desc && meta.description) desc.setAttribute('content', meta.description);

    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const v = get(el.dataset.i18n);
      if (typeof v === 'string') setRich(el, v);
    });
    document.querySelectorAll('[data-i18n-text]').forEach((el) => {
      const v = get(el.dataset.i18nText);
      if (typeof v === 'string') el.textContent = v;
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      const v = get(el.dataset.i18nPlaceholder);
      if (typeof v === 'string') el.placeholder = v;
    });
    document.querySelectorAll('[data-i18n-aria]').forEach((el) => {
      const v = get(el.dataset.i18nAria);
      if (typeof v === 'string') el.setAttribute('aria-label', v);
    });

    const sel = document.getElementById('lang-select');
    if (sel) sel.value = lang;
    document.documentElement.dataset.lang = lang;
  }

  async function load(next) {
    lang = SUPPORTED.includes(next) ? next : lang;
    const res = await fetch('/lang/' + lang + '.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('i18n load failed: ' + res.status);
    dict = await res.json();
    try { localStorage.setItem('p2p-lang', lang); } catch { /* وضع خاص/تخزين معطّل */ }
    apply();
    listeners.forEach((fn) => { try { fn(lang); } catch (err) { console.error(err); } });
  }

  document.addEventListener('change', (e) => {
    if (e.target && e.target.id === 'lang-select') load(e.target.value).catch(console.error);
  });

  window.setLang = load;
  window.ready = load(lang);
})();
