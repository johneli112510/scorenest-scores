// ScoreNest — app shell, router, library, new-score and import flows.
import { api, h, $, $$, state, toast, modal, promptModal, confirmModal, download, safeName, timeAgo, icon, esc } from './lib.js';
import { makeTemplate, TEMPLATES, KEYS, METERS, headerField } from './abc.js';
import { renderScore } from './score.js';
import { openTranscribe, thumbFromFile } from './transcribe.js';
import { shareModal } from './share.js';

const app = $('#app');
let cleanup = null;
const prefs = { view: localStorage.getItem('sn_view') || 'grid', sort: localStorage.getItem('sn_sort') || 'updated' };

// ---------- router ----------
async function route() {
  try { cleanup?.(); } catch { /* ignore */ }
  cleanup = null;
  $$('.popover').forEach((p) => p.remove());
  const hash = location.hash.replace(/^#\/?/, '');
  const [page, a, b] = hash.split('/');

  if (page === 's' && a) { cleanup = await renderScore(app, a, { publicMode: true }); return; }

  if (!state.session) state.session = await api('session').catch(() => ({ authRequired: false, authenticated: true }));
  if (state.session.authRequired && !state.session.authenticated) { renderLogin(); return; }
  if (page === 'login') { location.hash = '#/'; return; }

  if (page === 'score' && a) { cleanup = await renderScore(app, a); return; }
  renderLibrary(page === 'folder' ? { view: 'folder', folder: a } : { view: ['starred', 'shared', 'trash', 'recent'].includes(page) ? page : 'all' });
}
window.addEventListener('hashchange', route);

// ---------- login ----------
function renderLogin() {
  document.title = 'Sign in · ScoreNest';
  const pw = h('input', { class: 'input', type: 'password', placeholder: 'Password', autocomplete: 'current-password' });
  const msg = h('p', { class: 'error-text' });
  const form = h('form', { class: 'login-card', onsubmit: async (e) => {
    e.preventDefault(); msg.textContent = '';
    try {
      await api('login', { method: 'POST', body: { password: pw.value } });
      state.session = await api('session');
      location.hash = '#/'; route();
    } catch (err) { msg.textContent = err.message; pw.select(); }
  } },
  h('div', { class: 'brand brand-lg' }, h('span', { class: 'brand-mark', html: icon('music', 22) }), 'ScoreNest'),
  h('p', { class: 'muted' }, 'Your sheet music library, editor and AI transcriber.'),
  pw, msg, h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Sign in'));
  app.innerHTML = '';
  app.append(h('div', { class: 'login-page' }, form));
  pw.focus();
}

// ---------- library ----------
const typeLabel = { abc: 'Editable', musicxml: 'MusicXML', mxl: 'MusicXML', pdf: 'PDF', image: 'Image' };

async function renderLibrary(ctx) {
  document.title = 'Library · ScoreNest';
  const search = h('input', { class: 'input search-input', type: 'search', placeholder: 'Search scores, composers…', 'aria-label': 'Search' });
  const sortSel = h('select', { class: 'input select', 'aria-label': 'Sort' },
    ...[['updated', 'Last modified'], ['created', 'Date created'], ['title', 'Title A–Z'], ['composer', 'Composer']].map(([v, l]) => h('option', { value: v, selected: prefs.sort === v }, l)));
  const viewBtn = h('button', { class: 'icon-btn', title: 'Grid / list view', html: icon(prefs.view === 'grid' ? 'list' : 'grid') });
  const listEl = h('div', { class: `score-${prefs.view}` });
  const heading = h('h1', { class: 'lib-title' }, '');
  const sidebar = buildSidebar(ctx);
  const dropOverlay = h('div', { class: 'drop-overlay' }, h('div', {}, h('div', { html: icon('upload', 40) }), 'Drop PDFs, photos, MusicXML or ABC files to import'));

  const main = h('main', { class: 'lib-main' },
    h('div', { class: 'lib-head' },
      h('button', { class: 'icon-btn mobile-only', html: icon('menu'), onclick: () => sidebar.classList.toggle('open') }),
      heading,
      h('div', { class: 'lib-tools' }, h('div', { class: 'search-wrap' }, h('span', { html: icon('search', 16) }), search), sortSel, viewBtn)),
    listEl);

  app.innerHTML = '';
  app.append(h('div', { class: 'shell' }, sidebar, main, dropOverlay));

  // drag & drop import
  let dragDepth = 0;
  const shell = app.firstChild;
  shell.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files')) { dragDepth++; shell.classList.add('dragging'); } });
  shell.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; shell.classList.remove('dragging'); } });
  shell.addEventListener('dragover', (e) => e.preventDefault());
  shell.addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; shell.classList.remove('dragging'); if (e.dataTransfer.files.length) openImport([...e.dataTransfer.files], ctx); });

  listEl.innerHTML = '<div class="loading">Loading your scores…</div>';
  try {
    [state.scores, state.folders] = await Promise.all([api('scores'), api('folders')]);
  } catch (e) { listEl.innerHTML = ''; listEl.append(h('div', { class: 'empty' }, e.message)); return; }
  refreshSidebar(sidebar, ctx);

  const folderName = ctx.view === 'folder' ? state.folders.find((f) => f.id === ctx.folder)?.name || 'Folder' : null;
  heading.textContent = { all: 'All scores', starred: 'Starred', shared: 'Shared with link', trash: 'Trash', recent: 'Recent', folder: folderName }[ctx.view];

  const draw = () => {
    const q = search.value.trim().toLowerCase();
    let items = state.scores.filter((s) => {
      if (ctx.view === 'trash') return s.trashed;
      if (s.trashed) return false;
      if (ctx.view === 'starred') return s.starred;
      if (ctx.view === 'shared') return s.public;
      if (ctx.view === 'folder') return s.folder === ctx.folder;
      if (ctx.view === 'recent') return Date.now() - s.updated < 14 * 864e5;
      return true;
    });
    if (q) items = items.filter((s) => `${s.title} ${s.composer || ''}`.toLowerCase().includes(q));
    const by = prefs.sort;
    items.sort((x, y) => (by === 'title' || by === 'composer') ? String(x[by] || '~').localeCompare(String(y[by] || '~')) : (y[by] || 0) - (x[by] || 0));

    listEl.className = `score-${prefs.view}`;
    listEl.innerHTML = '';
    if (ctx.view === 'trash' && items.length) {
      listEl.append(h('div', { class: 'trash-bar' }, h('span', { class: 'muted' }, 'Scores in the trash can be restored or deleted forever.'),
        h('button', { class: 'btn btn-danger btn-sm', onclick: async () => {
          if (!(await confirmModal({ title: 'Empty trash?', message: `Permanently delete ${items.length} score(s)? This cannot be undone.`, okLabel: 'Delete forever', danger: true }))) return;
          await Promise.all(items.map((s) => api(`scores/${s.id}`, { method: 'DELETE' })));
          state.scores = state.scores.filter((s) => !s.trashed); draw(); toast('Trash emptied');
        } }, 'Empty trash')));
    }
    if (!items.length) {
      listEl.append(emptyState(ctx, q));
      return;
    }
    for (const s of items) listEl.append(scoreCard(s, ctx, draw));
  };

  search.addEventListener('input', draw);
  sortSel.addEventListener('change', () => { prefs.sort = sortSel.value; localStorage.setItem('sn_sort', prefs.sort); draw(); });
  viewBtn.addEventListener('click', () => {
    prefs.view = prefs.view === 'grid' ? 'list' : 'grid'; localStorage.setItem('sn_view', prefs.view);
    viewBtn.innerHTML = icon(prefs.view === 'grid' ? 'list' : 'grid'); draw();
  });
  draw();
}

function emptyState(ctx, q) {
  if (q) return h('div', { class: 'empty' }, h('p', {}, `No scores match “${q}”.`));
  if (ctx.view === 'trash') return h('div', { class: 'empty' }, h('div', { class: 'empty-icon', html: icon('trash', 36) }), h('p', {}, 'Trash is empty.'));
  if (ctx.view === 'starred') return h('div', { class: 'empty' }, h('div', { class: 'empty-icon', html: icon('star', 36) }), h('p', {}, 'Star the scores you use most and they will show up here.'));
  if (ctx.view === 'shared') return h('div', { class: 'empty' }, h('div', { class: 'empty-icon', html: icon('globe', 36) }), h('p', {}, 'Scores you share with a link appear here.'));
  return h('div', { class: 'empty empty-big' },
    h('div', { class: 'empty-icon', html: icon('music', 40) }),
    h('h2', {}, 'Start your library'),
    h('p', { class: 'muted' }, 'Write a new score, or drop in a PDF or photo of sheet music and let AI turn it into notation you can play, transpose and edit.'),
    h('div', { class: 'row center' },
      h('button', { class: 'btn btn-primary', onclick: () => openNewScore(ctx), html: `${icon('plus', 16)}<span>New score</span>` }),
      h('button', { class: 'btn', onclick: () => pickFiles(ctx), html: `${icon('upload', 16)}<span>Import / transcribe</span>` })));
}

function scoreCard(s, ctx, redraw) {
  const thumb = s.thumb
    ? h('img', { src: `/api/scores/${s.id}/thumb?v=${s.updated}`, alt: '', loading: 'lazy', onerror: (e) => { e.target.replaceWith(h('div', { class: 'thumb-ph', html: icon(s.type === 'pdf' || s.type === 'image' ? 'file' : 'music', 32) })); } })
    : h('div', { class: 'thumb-ph', html: icon(s.type === 'pdf' || s.type === 'image' ? 'file' : 'music', 32) });
  const href = s.trashed ? null : `#/score/${s.id}`;
  const starBtn = h('button', { class: `icon-btn star ${s.starred ? 'on' : ''}`, title: s.starred ? 'Unstar' : 'Star', html: icon('star', 16), onclick: async (e) => {
    e.preventDefault();
    s.starred = !s.starred; starBtn.classList.toggle('on', s.starred);
    await api(`scores/${s.id}`, { method: 'PUT', body: { starred: s.starred } }).catch((er) => toast(er.message, 'error'));
    if (ctx.view === 'starred') redraw();
  } });
  const menuBtn = h('button', { class: 'icon-btn', title: 'More', html: icon('dots', 16), onclick: (e) => { e.preventDefault(); e.stopPropagation(); cardMenu(e.currentTarget, s, ctx, redraw); } });
  const badges = h('div', { class: 'badges' },
    h('span', { class: `badge badge-${s.type}` }, typeLabel[s.type] || s.type),
    s.transcribed ? h('span', { class: 'badge badge-ai', title: 'Transcribed with AI' }, 'AI') : null,
    s.recCount ? h('span', { class: 'badge badge-rec', title: `${s.recCount} recording(s)` }, `♪ ${s.recCount}`) : null,
    s.public ? h('span', { class: 'badge badge-shared', html: icon('globe', 12), title: 'Shared with link' }) : null);
  const Link = (attrs, ...c) => (href ? h('a', { href, ...attrs }, ...c) : h('div', attrs, ...c));
  return h('article', { class: `card ${s.trashed ? 'is-trashed' : ''}` },
    Link({ class: 'card-thumb' }, thumb),
    h('div', { class: 'card-body' },
      h('div', { class: 'card-text' },
        Link({ class: 'card-title', title: s.title }, s.title),
        h('div', { class: 'card-sub' }, [s.composer, timeAgo(s.updated)].filter(Boolean).join(' · '))),
      h('div', { class: 'card-actions' }, s.trashed ? null : starBtn, menuBtn)),
    badges);
}

function popoverMenu(anchor, items) {
  $$('.popover').forEach((p) => p.remove());
  const pop = h('div', { class: 'popover' }, items.filter(Boolean).map((it) => it === '-' ? h('div', { class: 'popover-sep' })
    : h('button', { class: `popover-item ${it.danger ? 'danger' : ''}`, onclick: () => { pop.remove(); it.fn(); } }, it.label)));
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  const top = r.bottom + 6 + pop.offsetHeight > window.innerHeight ? r.top - pop.offsetHeight - 6 : r.bottom + 6;
  pop.style.top = `${top + window.scrollY}px`;
  pop.style.left = `${Math.max(8, Math.min(window.innerWidth - pop.offsetWidth - 8, r.right - pop.offsetWidth))}px`;
  setTimeout(() => document.addEventListener('click', () => pop.remove(), { once: true }), 0);
}

function cardMenu(anchor, s, ctx, redraw) {
  const update = async (patch, msg) => {
    try { Object.assign(s, await api(`scores/${s.id}`, { method: 'PUT', body: patch })); if (msg) toast(msg); redraw(); }
    catch (e) { toast(e.message, 'error'); }
  };
  if (s.trashed) {
    popoverMenu(anchor, [
      { label: 'Restore', fn: () => update({ trashed: false }, 'Score restored') },
      { label: 'Delete forever', danger: true, fn: async () => {
        if (!(await confirmModal({ title: 'Delete forever?', message: `“${s.title}” and all its versions will be permanently deleted.`, okLabel: 'Delete forever', danger: true }))) return;
        await api(`scores/${s.id}`, { method: 'DELETE' }); state.scores = state.scores.filter((x) => x.id !== s.id); redraw();
      } },
    ]);
    return;
  }
  popoverMenu(anchor, [
    { label: 'Open', fn: () => { location.hash = `#/score/${s.id}`; } },
    { label: 'Rename', fn: async () => { const t = await promptModal({ title: 'Rename score', label: 'Title', value: s.title }); if (t) update({ title: t }); } },
    { label: 'Move to folder…', fn: () => moveToFolder(s, update) },
    { label: 'Duplicate', fn: async () => { const c = await api(`scores/${s.id}/duplicate`, { method: 'POST' }); state.scores.unshift(c); redraw(); toast('Score duplicated'); } },
    { label: 'Share…', fn: () => shareModal(s, () => redraw()) },
    { label: 'Download', fn: () => downloadScore(s) },
    '-',
    { label: 'Move to trash', danger: true, fn: () => update({ trashed: true }, 'Moved to trash') },
  ]);
}

async function downloadScore(s) {
  try {
    if (s.type === 'pdf' || s.type === 'image') { window.open(`/api/scores/${s.id}/source`, '_blank'); return; }
    const res = await api(`scores/${s.id}/file`, { raw: true });
    const ext = { abc: 'abc', musicxml: 'musicxml', mxl: 'mxl' }[s.type];
    download(await res.blob(), `${safeName(s.title)}.${ext}`);
  } catch (e) { toast(e.message, 'error'); }
}

function moveToFolder(s, update) {
  const sel = h('select', { class: 'input select' }, h('option', { value: '' }, '— No folder (library root) —'),
    ...state.folders.map((f) => h('option', { value: f.id, selected: s.folder === f.id }, f.name)));
  modal({
    title: 'Move to folder', content: h('label', { class: 'field' }, h('span', {}, 'Folder'), sel),
    actions: [{ label: 'Cancel', onClick: (c) => c() }, { label: 'Move', primary: true, onClick: (c) => { c(); update({ folder: sel.value || null }, 'Moved'); } }],
  });
}

// ---------- sidebar ----------
function buildSidebar(ctx) {
  return h('aside', { class: 'sidebar' });
}
function refreshSidebar(sidebar, ctx) {
  const count = (fn) => state.scores.filter((s) => !s.trashed && fn(s)).length;
  const nav = (href, ic, label, active, n) => h('a', { class: `nav-item ${active ? 'active' : ''}`, href },
    h('span', { html: icon(ic, 17) }), h('span', { class: 'nav-label' }, label), n ? h('span', { class: 'nav-count' }, n) : null);
  const folders = state.folders.map((f) => {
    const item = nav(`#/folder/${f.id}`, 'folder', f.name, ctx.view === 'folder' && ctx.folder === f.id, count((s) => s.folder === f.id));
    item.append(h('button', { class: 'icon-btn nav-more', title: 'Folder options', html: icon('dots', 14), onclick: (e) => {
      e.preventDefault(); e.stopPropagation();
      popoverMenu(e.currentTarget, [
        { label: 'Rename', fn: async () => { const n = await promptModal({ title: 'Rename folder', label: 'Name', value: f.name }); if (n) { await api(`folders/${f.id}`, { method: 'PATCH', body: { name: n } }); route(); } } },
        { label: 'Delete folder', danger: true, fn: async () => {
          if (!(await confirmModal({ title: 'Delete folder?', message: `“${f.name}” will be removed. Its scores stay in your library.`, okLabel: 'Delete folder', danger: true }))) return;
          await api(`folders/${f.id}`, { method: 'DELETE' }); location.hash = '#/';
        } },
      ]);
    } }));
    return item;
  });
  sidebar.innerHTML = '';
  sidebar.append(
    h('a', { class: 'brand', href: '#/' }, h('span', { class: 'brand-mark', html: icon('music', 18) }), 'ScoreNest'),
    h('button', { class: 'btn btn-primary btn-block', onclick: () => openNewScore(ctx), html: `${icon('plus', 16)}<span>New score</span>` }),
    h('button', { class: 'btn btn-block', onclick: () => pickFiles(ctx), html: `${icon('upload', 16)}<span>Import / transcribe</span>` }),
    h('nav', { class: 'nav' },
      nav('#/', 'music', 'All scores', ctx.view === 'all', count(() => true)),
      nav('#/recent', 'history', 'Recent', ctx.view === 'recent'),
      nav('#/starred', 'star', 'Starred', ctx.view === 'starred', count((s) => s.starred)),
      nav('#/shared', 'globe', 'Shared', ctx.view === 'shared', count((s) => s.public)),
      nav('#/trash', 'trash', 'Trash', ctx.view === 'trash', state.scores.filter((s) => s.trashed).length)),
    h('div', { class: 'nav-section' }, h('span', {}, 'Folders'),
      h('button', { class: 'icon-btn', title: 'New folder', html: icon('plus', 15), onclick: async () => {
        const name = await promptModal({ title: 'New folder', label: 'Folder name', okLabel: 'Create' });
        if (!name) return;
        const f = await api('folders', { method: 'POST', body: { name } });
        location.hash = `#/folder/${f.id}`;
      } })),
    h('nav', { class: 'nav' }, folders.length ? folders : h('p', { class: 'muted small nav-empty' }, 'No folders yet')),
    h('div', { class: 'sidebar-foot' },
      state.session?.aiEnabled ? h('div', { class: 'ai-pill', html: `${icon('sparkle', 14)}<span>AI transcription on</span>` })
        : h('div', { class: 'ai-pill off', title: 'Add the ANTHROPIC_API_KEY secret in Cloudflare to enable', html: `${icon('sparkle', 14)}<span>AI transcription off</span>` }),
      state.session?.authRequired ? h('button', { class: 'nav-item', onclick: async () => { await api('logout', { method: 'POST' }); state.session = null; route(); } },
        h('span', { html: icon('logout', 17) }), h('span', { class: 'nav-label' }, 'Sign out')) : null));
  sidebar.addEventListener('click', (e) => { if (e.target.closest('a.nav-item')) sidebar.classList.remove('open'); });
}

// ---------- new score ----------
function openNewScore(ctx) {
  const title = h('input', { class: 'input', value: 'Untitled score' });
  const composer = h('input', { class: 'input', placeholder: 'Optional' });
  const tpl = h('div', { class: 'tpl-grid' }, ...Object.entries(TEMPLATES).map(([k, label], i) =>
    h('label', { class: 'tpl' }, h('input', { type: 'radio', name: 'tpl', value: k, checked: i === 0 }), h('span', {}, label))));
  const key = h('select', { class: 'input select' }, ...KEYS.map((k) => h('option', { value: k }, k.replace('b', '♭').replace('#', '♯').replace(/m$/, ' minor').replace(/^([A-G][♭♯]?)$/, '$1 major'))));
  const meter = h('select', { class: 'input select' }, ...METERS.map((m) => h('option', { value: m }, m === 'C' ? 'Common time (4/4)' : m === 'C|' ? 'Cut time (2/2)' : m)));
  const tempo = h('input', { class: 'input', type: 'number', min: 20, max: 300, value: 100 });
  const bars = h('input', { class: 'input', type: 'number', min: 1, max: 64, value: 8 });
  modal({
    title: 'New score', wide: true,
    content: h('div', { class: 'stack' },
      h('div', { class: 'grid-2' }, h('label', { class: 'field' }, h('span', {}, 'Title'), title), h('label', { class: 'field' }, h('span', {}, 'Composer / arranger'), composer)),
      h('div', { class: 'field' }, h('span', {}, 'Instrumentation'), tpl),
      h('div', { class: 'grid-4' },
        h('label', { class: 'field' }, h('span', {}, 'Key'), key), h('label', { class: 'field' }, h('span', {}, 'Time signature'), meter),
        h('label', { class: 'field' }, h('span', {}, 'Tempo (BPM)'), tempo), h('label', { class: 'field' }, h('span', {}, 'Bars'), bars))),
    actions: [{ label: 'Cancel', onClick: (c) => c() }, { label: 'Create score', primary: true, onClick: async (c) => {
      const content = makeTemplate({
        template: $('input[name=tpl]:checked', tpl).value, title: title.value.trim() || 'Untitled score', composer: composer.value.trim(),
        key: key.value, meter: meter.value, tempo: Number(tempo.value) || 100, bars: Math.min(64, Math.max(1, Number(bars.value) || 8)),
      });
      try {
        const meta = await api('scores', { method: 'POST', body: { type: 'abc', title: title.value.trim() || 'Untitled score', composer: composer.value.trim(), content, folder: ctx.view === 'folder' ? ctx.folder : null } });
        c(); location.hash = `#/score/${meta.id}`;
      } catch (e) { toast(e.message, 'error'); }
    } }],
  });
  title.select();
}

// ---------- import ----------
const ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp,.abc,.txt,.musicxml,.xml,.mxl';
function pickFiles(ctx) {
  const input = h('input', { type: 'file', multiple: true, accept: ACCEPT, style: { display: 'none' } });
  input.addEventListener('change', () => { if (input.files.length) openImport([...input.files], ctx); input.remove(); });
  document.body.append(input); input.click();
}

const kindOf = (f) => {
  const n = f.name.toLowerCase();
  if (n.endsWith('.pdf') || f.type === 'application/pdf') return 'pdf';
  if (/\.(png|jpe?g|webp)$/.test(n) || f.type.startsWith('image/')) return 'image';
  if (n.endsWith('.mxl')) return 'mxl';
  if (/\.(musicxml|xml)$/.test(n)) return 'musicxml';
  if (/\.(abc|txt)$/.test(n)) return 'abc';
  return null;
};

function openImport(files, ctx) {
  const usable = files.filter(kindOf);
  if (!usable.length) { toast('Supported files: PDF, PNG, JPG, WebP, MusicXML (.musicxml/.xml/.mxl) and ABC', 'error', 5000); return; }
  const hasScans = usable.some((f) => ['pdf', 'image'].includes(kindOf(f)));
  const ai = state.session?.aiEnabled;
  const modeAi = h('input', { type: 'radio', name: 'imode', value: 'ai', checked: ai, disabled: !ai });
  const modeStore = h('input', { type: 'radio', name: 'imode', value: 'store', checked: !ai });
  const list = h('ul', { class: 'file-list' }, usable.map((f) => h('li', {}, h('span', { class: `badge badge-${kindOf(f)}` }, kindOf(f).toUpperCase()), h('span', { class: 'file-name' }, f.name), h('span', { class: 'muted small' }, `${(f.size / 1024 / 1024).toFixed(1)} MB`))));
  modal({
    title: 'Import scores', wide: true,
    content: h('div', { class: 'stack' }, list,
      hasScans ? h('div', { class: 'field' }, h('span', {}, 'PDFs and photos'),
        h('label', { class: 'choice' }, modeAi, h('div', {}, h('strong', {}, 'Transcribe into editable notation with AI'),
          h('p', { class: 'muted small' }, ai ? 'Claude reads the pages and writes playable, editable notation. The original file is kept alongside for comparison.' : 'Not available until the ANTHROPIC_API_KEY secret is added in Cloudflare.'))),
        h('label', { class: 'choice' }, modeStore, h('div', {}, h('strong', {}, 'Just store and view'),
          h('p', { class: 'muted small' }, 'Keep the PDF or picture in your library. You can transcribe it later.')))) : null,
      h('p', { class: 'muted small' }, 'MusicXML files open in the viewer (and can be made editable). ABC files open straight in the editor.')),
    actions: [{ label: 'Cancel', onClick: (c) => c() }, { label: 'Import', primary: true, onClick: async (c) => {
      c();
      const transcribe = hasScans && modeAi.checked;
      let last = null;
      for (const f of usable) {
        try { last = await importOne(f, transcribe, ctx) || last; }
        catch (e) { toast(`${f.name}: ${e.message}`, 'error', 6000); }
      }
      if (last && usable.length === 1) location.hash = `#/score/${last.id}`;
      else route();
    } }],
  });
}

async function importOne(file, transcribe, ctx) {
  const kind = kindOf(file);
  const folder = ctx.view === 'folder' ? ctx.folder : null;
  const baseTitle = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
  if (kind === 'abc') {
    const text = await file.text();
    return api('scores', { method: 'POST', body: { type: 'abc', title: headerField(text, 'T') || baseTitle, composer: headerField(text, 'C'), content: text, folder } });
  }
  if (kind === 'musicxml') {
    const text = await file.text();
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const t = doc.querySelector('work-title')?.textContent || doc.querySelector('movement-title')?.textContent || baseTitle;
    const c = doc.querySelector('creator[type=composer]')?.textContent || '';
    return api('scores', { method: 'POST', body: { type: 'musicxml', title: t.trim(), composer: c.trim(), content: text, folder } });
  }
  if (kind === 'mxl') {
    const meta = await api('scores', { method: 'POST', body: { type: 'mxl', title: baseTitle, folder } });
    await api(`scores/${meta.id}/file`, { method: 'PUT', body: file, headers: { 'content-type': 'application/octet-stream' } });
    return meta;
  }
  // pdf / image
  if (transcribe) return openTranscribe({ file, folder });
  const meta = await api('scores', { method: 'POST', body: { type: kind, title: baseTitle, folder } });
  await api(`scores/${meta.id}/source`, { method: 'PUT', body: file, headers: { 'content-type': file.type || (kind === 'pdf' ? 'application/pdf' : 'image/jpeg'), 'x-filename': encodeURIComponent(file.name) } });
  try { await api(`scores/${meta.id}/thumb`, { method: 'PUT', body: await thumbFromFile(file, kind === 'pdf'), headers: { 'content-type': 'image/svg+xml' } }); } catch { /* optional */ }
  return meta;
}

// ---------- boot ----------
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) { const s = $('.search-input'); if (s) { e.preventDefault(); s.focus(); } }
});
route();
export { esc };
