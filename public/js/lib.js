// Shared helpers: API client, DOM helpers, toasts, modals, formatting.

export const state = { session: null, folders: [], scores: [] };

export async function api(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
  const opts = { method, headers: { ...headers }, credentials: 'same-origin' };
  if (body !== undefined) {
    if (body instanceof Blob || body instanceof ArrayBuffer || typeof body === 'string') opts.body = body;
    else { opts.body = JSON.stringify(body); opts.headers['content-type'] = 'application/json'; }
  }
  const res = await fetch(`/api/${path}`, opts);
  if (res.status === 401 && !path.startsWith('login') && !path.startsWith('public')) {
    location.hash = '#/login';
    throw new Error('Please sign in');
  }
  if (raw) return res;
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function timeAgo(ts) {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function toast(message, type = 'info', ms = 3200) {
  let wrap = $('#toasts');
  if (!wrap) { wrap = h('div', { id: 'toasts' }); document.body.append(wrap); }
  const t = h('div', { class: `toast toast-${type}` }, message);
  wrap.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, ms);
}

// Generic modal. Returns { el, close, body }.
export function modal({ title, content, actions = [], wide = false, onClose } = {}) {
  const backdrop = h('div', { class: 'modal-backdrop' });
  const close = () => { backdrop.remove(); document.removeEventListener('keydown', onKey); onClose?.(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const body = h('div', { class: 'modal-body' }, content);
  const foot = actions.length ? h('div', { class: 'modal-foot' }, actions.map((a) =>
    h('button', { class: `btn ${a.primary ? 'btn-primary' : ''} ${a.danger ? 'btn-danger' : ''}`, onclick: () => a.onClick?.(close) }, a.label))) : null;
  const box = h('div', { class: `modal ${wide ? 'modal-wide' : ''}`, role: 'dialog', 'aria-modal': 'true' },
    h('div', { class: 'modal-head' }, h('h2', {}, title || ''), h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: close, html: icon('x') })),
    body, foot);
  backdrop.append(box);
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(backdrop);
  setTimeout(() => box.querySelector('input,textarea,select')?.focus(), 30);
  return { el: box, body, close };
}

export function promptModal({ title, label, value = '', okLabel = 'Save' }) {
  return new Promise((resolve) => {
    const input = h('input', { class: 'input', value, 'aria-label': label });
    let done = false;
    const m = modal({
      title, content: h('label', { class: 'field' }, h('span', {}, label), input),
      actions: [{ label: 'Cancel', onClick: (c) => c() }, { label: okLabel, primary: true, onClick: (c) => { done = true; c(); resolve(input.value.trim()); } }],
      onClose: () => { if (!done) resolve(null); },
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { done = true; m.close(); resolve(input.value.trim()); } });
    input.select();
  });
}

export function confirmModal({ title, message, okLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    modal({
      title, content: h('p', {}, message),
      actions: [{ label: 'Cancel', onClick: (c) => c() }, { label: okLabel, primary: !danger, danger, onClick: (c) => { done = true; c(); resolve(true); } }],
      onClose: () => { if (!done) resolve(false); },
    });
  });
}

export function download(data, filename, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export const safeName = (s) => (s || 'score').replace(/[\\/:*?"<>|]+/g, '').trim().slice(0, 80) || 'score';

export function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.flush = (...a) => { clearTimeout(t); return fn(...a); };
  d.cancel = () => clearTimeout(t);
  return d;
}

let osmdPromise;
export function loadOSMD() {
  osmdPromise ||= new Promise((resolve, reject) => {
    const s = h('script', { src: 'https://cdn.jsdelivr.net/npm/opensheetmusicdisplay@1.9.9/build/opensheetmusicdisplay.min.js' });
    s.onload = () => resolve(window.opensheetmusicdisplay);
    s.onerror = () => reject(new Error('Could not load the MusicXML renderer'));
    document.head.append(s);
  });
  return osmdPromise;
}

let pdfPromise;
export function loadPdfJs() {
  pdfPromise ||= import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs').then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
    return lib;
  });
  return pdfPromise;
}

// Render every page of a PDF into a container as canvases (whole piece scrolls; page numbers shown).
export async function renderPdfInto(container, source, { scale = 1.5 } = {}) {
  const pdfjs = await loadPdfJs();
  const doc = await pdfjs.getDocument(source).promise;
  container.innerHTML = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: scale * (window.devicePixelRatio > 1 ? 1.5 : 1) });
    const canvas = h('canvas', { width: vp.width, height: vp.height, class: 'pdf-page' });
    container.append(h('div', { class: 'pdf-page-wrap' }, canvas, h('div', { class: 'pdf-page-no' }, `Page ${i} of ${doc.numPages}`)));
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  }
  return doc;
}

const ICONS = {
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  star: '<path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/>',
  trash: '<path d="M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
  folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.59 13.51 6.83 3.98M15.41 6.51l-6.82 3.98"/>',
  grid: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  dots: '<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>',
  back: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  play: '<path d="m6 3 14 9-14 9z"/>',
  sparkle: '<path d="M12 3l1.9 5.8L20 10l-6.1 1.2L12 17l-1.9-5.8L4 10l6.1-1.2z"/><path d="M19 17l.7 2.1L22 20l-2.3.9L19 23l-.7-2.1L16 20l2.3-.9z"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l4 2"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  print: '<path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
  menu: '<path d="M3 12h18M3 6h18M3 18h18"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  keyboard: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M7 16h10"/>',
};
export function icon(name, size = 18) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}
