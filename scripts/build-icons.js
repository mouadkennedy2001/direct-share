'use strict';
/**
 * مولّد الأيقونات — يكتب public/icons/*.svg و public/css/icons.css
 * التشغيل: npm run icons
 * الأيقونات خطّية 24×24 وتستخدم currentColor عند تحميلها كـ <img>،
 * أما في الواجهة فتُلوَّن عبر CSS mask (background-color: currentColor).
 */
const fs = require('fs');
const path = require('path');

const ICONS = {
  lock: '<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  unlock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/>',
  bolt: '<path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z"/>',
  shield: '<path d="M12 3l7 3v5c0 5-3.5 8-7 10-3.5-2-7-5-7-10V6l7-3z"/><path d="M9 12l2 2 4-4"/>',
  'shield-check': '<path d="M12 3l7 3v5c0 5-3.5 8-7 10-3.5-2-7-5-7-10V6l7-3z"/><path d="M9 11.5l2 2 4-4"/>',
  rocket: '<path d="M12 15c5-3 7-8 7-12-4 0-9 2-12 7l-2 5 5-2z"/><circle cx="14.5" cy="9.5" r="1.5"/><path d="M5 19c-1 0-2-1-2-2 2 0 4-1 5-3"/>',
  download: '<path d="M12 3v12"/><path d="M6 11l6 6 6-6"/><path d="M4 21h16"/>',
  upload: '<path d="M12 21V9"/><path d="M6 13l6-6 6 6"/><path d="M4 3h16"/>',
  file: '<path d="M6 2h8l5 5v15H6z"/><path d="M14 2v5h5"/>',
  files: '<path d="M8 2h7l4 4v12H8z"/><path d="M15 2v4h4"/><path d="M5 6v16h10"/>',
  pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
  play: '<path d="M7 4l13 8-13 8z"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  x: '<path d="M5 5l14 14M19 5L5 19"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  leave: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
  check: '<path d="M4 12l5 5L20 6"/>',
  warning: '<path d="M12 3L1 21h22L12 3z"/><path d="M12 10v5"/><circle cx="12" cy="18" r=".6" fill="currentColor"/>',
  fire: '<path d="M12 22c4 0 7-2.5 7-6.5C19 9 14 6 12 2c-2 4-7 7-7 13.5C5 19.5 8 22 12 22z"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c3 3.5 3 14 0 18-3-4-3-14.5 0-18z"/>',
  link: '<path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5"/>',
  send: '<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9"/><path d="M15 7h4v4"/>',
  chat: '<path d="M21 12a8 8 0 0 1-8 8H4l2-3a8 8 0 1 1 15-5z"/>',
  eye: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  'eye-off': '<path d="M3 3l18 18"/><path d="M10.6 6.2A9.6 9.6 0 0 1 12 6c6.5 0 10 6 10 6a17 17 0 0 1-3.4 4.1"/><path d="M6.4 7.6A17 17 0 0 0 2 12s3.5 6 10 6a9.7 9.7 0 0 0 4-.8"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 14h10l1-14"/><path d="M10 11v6M14 11v6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  'arrow-right': '<path d="M4 12h16"/><path d="M14 6l6 6-6 6"/>',
  'arrow-left': '<path d="M20 12H4"/><path d="M10 6l-6 6 6 6"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
  code: '<path d="M9 6l-6 6 6 6"/><path d="M15 6l6 6-6 6"/>',
  terminal: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 9l3 3-3 3"/><path d="M12 15h6"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  wifi: '<path d="M2 8.5a16 16 0 0 1 20 0"/><path d="M5.5 12a11 11 0 0 1 13 0"/><path d="M9 15.5a6 6 0 0 1 6 0"/><circle cx="12" cy="19" r="1"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><circle cx="12" cy="7.5" r=".8" fill="currentColor"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7"/><path d="M17.5 14a6.5 6.5 0 0 1 4 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  gauge: '<path d="M4 18a9 9 0 1 1 16 0"/><path d="M12 14l4-4"/><circle cx="12" cy="15" r="1.5"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  fingerprint: '<path d="M12 4a8 8 0 0 0-8 8v2"/><path d="M12 8a4 4 0 0 0-4 4v4"/><path d="M12 12a1 1 0 0 0-1 1v5"/><path d="M20 12a8 8 0 0 0-4-6.9"/><path d="M16 13v3"/><path d="M20 15v1"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/><path d="M3 17l9 5 9-5"/>',
  sparkles: '<path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8L12 3z"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15z"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 8v5l3 2"/>',
  list: '<path d="M9 6h12M9 12h12M9 18h12"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
  signal: '<path d="M4 20v-4M9 20v-8M14 20V8M19 20V4"/>',
  'chevron-down': '<path d="M6 9l6 6 6-6"/>',
  heart: '<path d="M12 21s-8-4.5-8-10.5A4.5 4.5 0 0 1 12 7a4.5 4.5 0 0 1 8 3.5C20 16.5 12 21 12 21z"/>',
  star: '<path d="M12 3l2.9 5.9 6.6.9-4.8 4.6 1.2 6.6L12 17.9 6.1 21l1.2-6.6L2.5 9.8l6.6-.9L12 3z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  activity: '<path d="M2 12h4l3-7 5 14 3-7h5"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/>',
  maximize: '<path d="M9 3H3v6M15 3h6v6M9 21H3v-6M15 21h6v-6"/>',
  hash: '<path d="M9 3L7 21M17 3l-2 18M4 9h17M3 15h17"/>',
};

const OUT_ICONS = path.join(__dirname, '..', 'public', 'icons');
const OUT_CSS = path.join(__dirname, '..', 'public', 'css', 'icons.css');
fs.mkdirSync(OUT_ICONS, { recursive: true });

for (const [name, body] of Object.entries(ICONS)) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" role="img" aria-hidden="true"><title>${name}</title>${body}</svg>\n`;
  fs.writeFileSync(path.join(OUT_ICONS, name + '.svg'), svg);
}

const css = [
  '/* مُولَّد تلقائياً بواسطة scripts/build-icons.js — لا تعدّله يدوياً */',
  '/* أيقونات خطّية تُلوَّن بـ currentColor عبر mask */',
  '.icon{display:inline-block;flex:none;width:20px;height:20px;vertical-align:-4px;',
  '  background-color:currentColor;',
  '  -webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;',
  '  -webkit-mask-position:center;mask-position:center;',
  '  -webkit-mask-size:contain;mask-size:contain}',
  ...Object.keys(ICONS).map((n) => `.i-${n}{-webkit-mask-image:url("/icons/${n}.svg");mask-image:url("/icons/${n}.svg")}`),
  '',
].join('\n');
fs.writeFileSync(OUT_CSS, css);

console.log(`icons: ${Object.keys(ICONS).length} → public/icons/ + public/css/icons.css`);
