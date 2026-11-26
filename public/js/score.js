// Score page: ABC editor (live render, playback, on-score editing), MusicXML / PDF / image viewers,
// and the read-only public share view.
import { api, h, $, $$, modal, toast, download, safeName, debounce, timeAgo, icon, loadOSMD, renderPdfInto, confirmModal, state } from './lib.js';
import { headerField, durationSuffix, midiToAbc, shiftPitch, setPitchLetter, setDuration, toRest, toggleAccidental } from './abc.js';
import { openTranscribe, thumbFromFile } from './transcribe.js';
import { shareModal } from './share.js';
import { unpackMxl } from './mxl.js';
import { convertMusicXML } from './musicxml.js';
import { createPlayer } from './player.js';

const ABCJS = () => window.ABCJS;

// ---------- shared bits ----------
function serializeSvg(svg) {
  const clone = svg.cloneNode(true);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.querySelectorAll('title,desc').forEach((n) => n.remove());
  if (!clone.getAttribute('viewBox')) {
    const w = svg.getAttribute('width') || svg.clientWidth, hgt = svg.getAttribute('height') || svg.clientHeight;
    clone.setAttribute('viewBox', `0 0 ${parseFloat(w)} ${parseFloat(hgt)}`);
  }
  clone.removeAttribute('style');
  clone.setAttribute('style', 'background:#fff');
  return new XMLSerializer().serializeToString(clone);
}

async function uploadThumb(id, svgEl) {
  if (!svgEl) return;
  try {
    const svg = serializeSvg(svgEl);
    if (svg.length < 590000) await api(`scores/${id}/thumb`, { method: 'PUT', body: svg, headers: { 'content-type': 'image/svg+xml' } });
  } catch { /* thumbnails are best-effort */ }
}

function printSvgs(title, svgs) {
  const w = window.open('', '_blank');
  if (!w) { toast('Allow pop-ups to print or save as PDF', 'error'); return; }
  const body = svgs.map((s) => `<div class="pg">${serializeSvg(s)}</div>`).join('');
  w.document.write(`<!doctype html><html><head><title>${title.replace(/</g, '&lt;')}</title><style>
    @page{margin:12mm} body{margin:0;font-family:sans-serif} .pg svg{width:100%;height:auto;display:block} .pg{break-inside:avoid;margin-bottom:6mm}
  </style></head><body>${body}<script>window.onload=()=>{setTimeout(()=>window.print(),300)}<\/script></body></html>`);
  w.document.close();
}

function topBar({ meta, publicMode, onTitle, extra = [] }) {
  const titleEl = publicMode
    ? h('h1', { class: 'ed-title-static' }, meta.title)
    : h('input', { class: 'ed-title', value: meta.title, 'aria-label': 'Score title', onchange: (e) => onTitle?.({ title: e.target.value.trim() || 'Untitled score' }) });
  const composerEl = publicMode
    ? (meta.composer ? h('div', { class: 'ed-composer-static' }, meta.composer) : null)
    : h('input', { class: 'ed-composer', value: meta.composer || '', placeholder: 'Composer / arranger', 'aria-label': 'Composer', onchange: (e) => onTitle?.({ composer: e.target.value.trim() }) });
  return h('header', { class: 'ed-top' },
    publicMode ? h('a', { class: 'brand-sm', href: '#/' }, h('span', { class: 'brand-mark', html: icon('music', 16) }), 'ScoreNest')
      : h('a', { class: 'icon-btn', href: '#/', title: 'Back to library', html: icon('back') }),
    h('div', { class: 'ed-titles' }, titleEl, composerEl),
    h('div', { class: 'ed-top-actions' }, ...extra));
}

function exportMenu(items) {
  const btn = h('button', { class: 'btn', html: `${icon('download', 16)}<span>Export</span>` });
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    $$('.popover').forEach((p) => p.remove());
    const pop = h('div', { class: 'popover' }, items.filter(Boolean).map(([label, fn]) => h('button', { class: 'popover-item', onclick: () => { pop.remove(); fn(); } }, label)));
    document.body.append(pop);
    const r = btn.getBoundingClientRect();
    pop.style.top = `${r.bottom + 6 + window.scrollY}px`;
    pop.style.left = `${Math.max(8, r.right - pop.offsetWidth)}px`;
    setTimeout(() => document.addEventListener('click', () => pop.remove(), { once: true }), 0);
  });
  return btn;
}

// ---------- entry point ----------
export async function renderScore(root, id, { publicMode = false } = {}) {
  root.innerHTML = '<div class="loading">Loading score…</div>';
  let data;
  try { data = await api(publicMode ? `public/${id}` : `scores/${id}`); }
  catch (e) {
    root.innerHTML = '';
    root.append(h('div', { class: 'empty' }, h('h2', {}, 'Score not available'), h('p', {}, e.message), h('a', { class: 'btn', href: '#/' }, 'Go to library')));
    return () => {};
  }
  const { meta, content } = data;
  document.title = `${meta.title} · ScoreNest`;
  if (meta.type === 'abc') return abcEditor(root, meta, content, publicMode);
  if (meta.type === 'musicxml' || meta.type === 'mxl') return xmlViewer(root, meta, content, publicMode);
  return fileViewer(root, meta);
}

// ---------- PDF / image viewer (stored, not yet transcribed) ----------
function fileViewer(root, meta) {
  const url = `/api/scores/${meta.id}/source`;
  const view = h('div', { class: 'file-view' });
  const save = (patch) => api(`scores/${meta.id}`, { method: 'PUT', body: patch }).then((m) => Object.assign(meta, m)).catch((e) => toast(e.message, 'error'));
  const transcribeBtn = h('button', { class: 'btn', html: `${icon('sparkle', 16)}<span>Transcribe to editable</span>`, onclick: async () => {
    const res = await openTranscribe({ score: meta });
    if (res) { location.hash = `#/score/${meta.id}`; window.dispatchEvent(new HashChangeEvent('hashchange')); }
  } });
  root.innerHTML = '';
  root.append(h('div', { class: 'editor' },
    topBar({ meta, onTitle: save, extra: [h('button', { class: 'btn btn-primary', onclick: async () => {
      if (await convertMusicXML(meta)) window.dispatchEvent(new HashChangeEvent('hashchange'));
    } }, 'Convert to MusicXML'), transcribeBtn, h('a', { class: 'btn', href: url, target: '_blank', rel: 'noopener', html: `${icon('file', 16)}<span>Open original</span>` })] }),
    h('div', { class: 'file-note' }, 'This score is stored as a ', meta.type === 'pdf' ? 'PDF' : 'picture', '. Transcribe it to play it back, transpose it and edit the notes.'),
    view));
  if (meta.type === 'pdf') renderPdfInto(view, url).catch((e) => { view.textContent = e.message; });
  else view.append(h('img', { src: url, alt: meta.title, class: 'file-img' }));
  return () => {};
}

// ---------- MusicXML viewer ----------
async function xmlViewer(root, meta, content, publicMode) {
  const paper = h('div', { class: 'osmd-paper' });
  let zoom = 1, osmd;
  const fileUrl = publicMode ? `/api/public/${meta.id}/file` : `/api/scores/${meta.id}/file`;
  let extracted;
  function scoreText() {
    if (meta.type !== 'mxl') return Promise.resolve(content);
    extracted ??= fetch(fileUrl).then(async res => {
      if (!res.ok) throw new Error('Could not open the MXL file.');
      return unpackMxl(await res.arrayBuffer());
    }).catch(err => { extracted = undefined; throw err; });
    return extracted;
  }
  const save = (patch) => api(`scores/${meta.id}`, { method: 'PUT', body: patch }).then((m) => Object.assign(meta, m)).catch((e) => toast(e.message, 'error'));
  const zoomBy = (d) => { zoom = Math.min(2.5, Math.max(0.4, zoom + d)); if (osmd) { osmd.Zoom = zoom; osmd.render(); } };

  const extra = [
    h('button', { class: 'icon-btn', title: 'Zoom out', onclick: () => zoomBy(-0.1), html: '−' }),
    h('button', { class: 'icon-btn', title: 'Zoom in', onclick: () => zoomBy(0.1), html: '+' }),
  ];
  if (!publicMode) {
    extra.push(h('button', { class: 'btn btn-primary', html: `${icon('sparkle', 16)}<span>Make editable</span>`, onclick: async () => {
      let text;
      try { text = await scoreText(); } catch (e) { toast(e.message, 'error'); return; }
      const res = await openTranscribe({ musicxml: { text, title: meta.title } });
      if (res) location.hash = `#/score/${res.id}`;
    } }));
    extra.push(h('button', { class: 'btn', html: `${icon('share', 16)}<span>Share</span>`, onclick: () => shareModal(meta) }));
  }
  const original = h('aside', { class: 'xml-original hidden', 'aria-label': 'Original score' });
  const workspace = h('div', { class: 'xml-workspace' }, original, h('div', { class: 'osmd-wrap' }, paper));
  if (meta.source && !publicMode) {
    const url = '/api/scores/' + meta.id + '/source';
    extra.unshift(h('button', { class: 'btn', 'aria-pressed': 'false', onclick: e => {
      const opened = workspace.classList.toggle('compare');
      e.currentTarget.setAttribute('aria-pressed', String(opened));
      original.classList.toggle('hidden', !opened);
      if (opened && !original.hasChildNodes()) {
        original.append(h('h3', {}, 'Original score'));
        if (/pdf/i.test(meta.sourceType) || /\.pdf$/i.test(meta.source)) renderPdfInto(original, url).catch(error => { original.textContent = error.message; });
        else original.append(h('img', { class: 'file-img', src: url, alt: 'Original score' }));
      }
    } }, 'Compare original'));
  }
  extra.push(h('button', { class: 'btn btn-primary', onclick: async () => {
    try { download(await scoreText(), safeName(meta.title) + '.musicxml', 'application/vnd.recordare.musicxml+xml'); }
    catch (e) { toast(e.message, 'error'); }
  } }, 'Download MusicXML'));
  extra.push(exportMenu([
    ['MusicXML file', () => fetch(fileUrl).then((r) => r.blob()).then((b) => download(b, `${safeName(meta.title)}.${meta.type === 'mxl' ? 'mxl' : 'musicxml'}`))],
    ['Print / save as PDF', () => printSvgs(meta.title, $$('svg', paper))],
  ]));

  root.innerHTML = '';
  root.append(h('div', { class: 'editor' }, topBar({ meta, publicMode, onTitle: save, extra }), workspace));
  try {
    const OSMD = await loadOSMD();
    osmd = new OSMD.OpenSheetMusicDisplay(paper, { autoResize: true, drawTitle: true, backend: 'svg' });
    await osmd.load(await scoreText());
    osmd.render();
    if (!publicMode) uploadThumb(meta.id, paper.querySelector('svg'));
  } catch (e) {
    paper.append(h('div', { class: 'empty' }, h('p', {}, `Could not display this MusicXML: ${e.message}`)));
  }
  return () => {};
}

// ---------- ABC editor ----------
function abcEditor(root, meta, initial, publicMode) {
  let text = initial || '';
  let tunes = null;
  let selection = null; // { start, end }
  let zoom = Number(localStorage.getItem('sn_zoom') || 1);
  let dirty = false, saving = false, lastThumb = 0;
  let duration = [1, 4]; // current note value (quarter)
  let octaveBase = 60;
  let midiAccess = null;
  const readOnly = publicMode;

  // --- elements
  const paper = h('div', { class: 'paper', id: 'paper' });
  const code = h('textarea', { class: 'code', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', 'aria-label': 'ABC notation' });
  code.value = text;
  const warnings = h('div', { class: 'warnings' });
  const status = h('span', { class: 'save-status' }, readOnly ? '' : 'Saved');
  const originalPane = h('div', { class: 'original-pane hidden' });

  const setStatus = (s, cls = '') => { status.textContent = s; status.className = `save-status ${cls}`; };

  // --- saving
  const persist = async (snapshot = false) => {
    if (readOnly || (!dirty && !snapshot)) return;
    saving = true; setStatus('Saving…');
    try {
      const m = await api(`scores/${meta.id}`, { method: 'PUT', body: { content: text, snapshot } });
      Object.assign(meta, m);
      dirty = false; setStatus(snapshot ? 'Version saved' : 'Saved', 'ok');
      if (Date.now() - lastThumb > 20000) { lastThumb = Date.now(); uploadThumb(meta.id, paper.querySelector('svg')); }
    } catch (e) { setStatus('Not saved — retrying', 'bad'); setTimeout(() => persist(snapshot), 5000); }
    saving = false;
  };
  const autosave = debounce(() => persist(false), 1500);
  const saveMeta = (patch) => api(`scores/${meta.id}`, { method: 'PUT', body: patch }).then((m) => { Object.assign(meta, m); document.title = `${meta.title} · ScoreNest`; }).catch((e) => toast(e.message, 'error'));

  // --- rendering
  let player = null; // created once the page is built

  function render() {
    if (!ABCJS()) { paper.textContent = 'Notation engine failed to load. Check your connection and reload.'; return; }
    tunes = ABCJS().renderAbc(paper, text, {
      responsive: 'resize', add_classes: true, scale: zoom, staffwidth: 760,
      clickListener: onScoreClick, dragging: !readOnly, selectionColor: '#3056d3',
      wrap: { minSpacing: 1.8, maxSpacing: 2.7, preferredMeasuresPerLine: 4 },
      oneSvgPerLine: false, foregroundColor: '#14161f',
    });
    const w = (tunes[0]?.warnings || []).slice(0, 5);
    warnings.innerHTML = '';
    if (w.length) warnings.append(h('div', { class: 'warn-head' }, `${w.length} notation issue${w.length > 1 ? 's' : ''}`), ...w.map((x) => h('div', { class: 'warn', html: x })));
    if (selection && tunes[0]?.engraver?.rangeHighlight) { try { tunes[0].engraver.rangeHighlight(selection.start, selection.end); } catch { /* ignore */ } }
    player?.onRender();
  }
  const renderSoon = debounce(render, 250);

  // --- text editing helpers
  function setText(next, sel) {
    text = next; code.value = next;
    if (sel) { selection = sel; code.setSelectionRange(sel.start, sel.end); }
    dirty = true; setStatus('Unsaved changes'); autosave(); render();
  }
  function replaceRange(start, end, str, select = true) {
    const next = text.slice(0, start) + str + text.slice(end);
    setText(next, select ? { start, end: start + str.length } : { start: start + str.length, end: start + str.length });
  }
  function insertAtCursor(str) {
    let pos = selection && document.activeElement !== code ? selection.end : code.selectionEnd;
    if (pos == null || pos < 0) pos = text.length;
    const before = text.slice(0, pos);
    const pad = before && !/[\s|\[(:]$/.test(before) && /^[|]/.test(str) ? ' ' : '';
    replaceRange(pos, pos, pad + str, false);
    selection = null;
  }
  const currentToken = () => (selection ? text.slice(selection.start, selection.end) : null);
  const editSelected = (fn) => {
    const tok = currentToken();
    if (!tok) { toast('Click a note on the score first', 'info', 1800); return false; }
    const next = fn(tok);
    if (next !== tok) replaceRange(selection.start, selection.end, next, true);
    return true;
  };

  function onScoreClick(abcElem, tuneNumber, classes, analysis, drag, ev) {
    if (abcElem.startChar == null || abcElem.endChar == null) return;
    if (drag?.step && abcElem.el_type === 'note' && !readOnly) {
      selection = { start: abcElem.startChar, end: abcElem.endChar };
      while (selection.end > selection.start && /\s/.test(text[selection.end - 1])) selection.end--;
      editSelected((t) => shiftPitch(t, -drag.step));
      return;
    }
    player?.onNoteClick(abcElem, ev);
    if (readOnly) return;
    selection = { start: abcElem.startChar, end: abcElem.endChar };
    while (selection.end > selection.start && /\s/.test(text[selection.end - 1])) selection.end--;
    if (window.innerWidth > 900) {
      code.setSelectionRange(selection.start, selection.end);
      const lineNo = text.slice(0, selection.start).split('\n').length;
      code.scrollTop = Math.max(0, (lineNo - 4) * parseFloat(getComputedStyle(code).lineHeight || 20));
    }
  }

  // Keyboard editing on the score (Flat-style): arrows move pitch, letters set pitch, Delete -> rest, 1-6 durations.
  const DUR_KEYS = { 1: [1, 16], 2: [1, 8], 3: [1, 4], 4: [1, 2], 5: [1, 1], 6: [3, 8] };
  function onKey(e) {
    if (player?.handleKey(e)) return;
    if (readOnly) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); autosave.cancel(); persist(true); return; }
    if (document.activeElement === code || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return;
    if (!selection) return;
    const k = e.key;
    if (k === 'ArrowUp' || k === 'ArrowDown') { e.preventDefault(); editSelected((t) => shiftPitch(t, (k === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 7 : 1))); }
    else if (/^[a-gA-G]$/.test(k) && !e.ctrlKey && !e.metaKey) { e.preventDefault(); editSelected((t) => setPitchLetter(t, k)); }
    else if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); editSelected(toRest); }
    else if (DUR_KEYS[k]) { e.preventDefault(); editSelected((t) => setDuration(t, durationSuffix(...DUR_KEYS[k], text))); }
    else if (k === '+' || k === '=') { e.preventDefault(); editSelected((t) => toggleAccidental(t, '^')); }
    else if (k === '-') { e.preventDefault(); editSelected((t) => toggleAccidental(t, '_')); }
    else if (k === 'Escape') { selection = null; render(); }
  }

  code.addEventListener('input', () => { text = code.value; selection = null; dirty = true; setStatus('Unsaved changes'); autosave(); renderSoon(); });
  code.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') { e.preventDefault(); const s = code.selectionStart; code.setRangeText('  ', s, code.selectionEnd, 'end'); code.dispatchEvent(new Event('input')); }
  });
  document.addEventListener('keydown', onKey);

  // --- palette
  const durBtns = [
    ['𝅝', 'Whole', [1, 1]], ['𝅗𝅥', 'Half', [1, 2]], ['♩', 'Quarter', [1, 4]], ['♪', 'Eighth', [1, 8]], ['𝅘𝅥𝅯', '16th', [1, 16]],
    ['♩.', 'Dotted quarter', [3, 8]], ['♪.', 'Dotted eighth', [3, 16]],
  ].map(([sym, label, d]) => {
    const b = h('button', { class: `pal-btn ${d[0] === duration[0] && d[1] === duration[1] ? 'active' : ''}`, title: `${label} (applies to the selected note, or to new notes)` }, sym);
    b.addEventListener('click', () => {
      duration = d;
      $$('.pal-dur .pal-btn').forEach((x) => x.classList.remove('active')); b.classList.add('active');
      if (selection) editSelected((t) => setDuration(t, durationSuffix(...d, text)));
    });
    return b;
  });
  const ins = (label, str, title) => h('button', { class: 'pal-btn', title: title || str, onclick: () => insertAtCursor(typeof str === 'function' ? str() : str) }, label);
  const act = (label, fn, title) => h('button', { class: 'pal-btn', title, onclick: fn }, label);
  const restStr = () => `z${durationSuffix(...duration, text)}`;

  function noteFromMidi(midi) {
    const str = midiToAbc(midi) + durationSuffix(...duration, text);
    if (selection) editSelected((t) => {
      const durMatch = t.match(/(\d*(?:\/+\d*)?)([^A-Ga-g\]]*)$/);
      return midiToAbc(midi) + (durMatch ? durMatch[1] : '') + (durMatch ? durMatch[2] : '');
    });
    else insertAtCursor(str);
    try { ABCJS().synth.playEvent([{ pitch: midi, volume: 90, start: 0, duration: 0.6, instrument: 0, gap: 0 }], [], 1000).catch(() => {}); } catch { /* ignore */ }
  }

  const piano = h('div', { class: 'piano' });
  const drawPiano = () => {
    piano.innerHTML = '';
    const whites = [0, 2, 4, 5, 7, 9, 11];
    for (let o = 0; o < 2; o++) {
      for (const pc of whites) {
        const midi = octaveBase + o * 12 + pc;
        const key = h('button', { class: 'pkey white', title: midiToAbc(midi), onclick: () => noteFromMidi(midi) }, pc === 0 ? `C${Math.floor(midi / 12) - 1}` : '');
        if ([0, 2, 5, 7, 9].includes(pc)) key.append(h('span', { class: 'pkey black', title: midiToAbc(midi + 1), onclick: (e) => { e.stopPropagation(); noteFromMidi(midi + 1); } }));
        piano.append(key);
      }
    }
  };
  drawPiano();

  async function toggleMidiInput(btn) {
    if (midiAccess) { midiAccess.inputs.forEach((i) => { i.onmidimessage = null; }); midiAccess = null; btn.classList.remove('active'); toast('MIDI input off'); return; }
    if (!navigator.requestMIDIAccess) { toast('This browser does not support MIDI keyboards (try Chrome or Edge).', 'error'); return; }
    try {
      midiAccess = await navigator.requestMIDIAccess();
      let n = 0;
      midiAccess.inputs.forEach((input) => { n++; input.onmidimessage = (m) => { const [st, note, vel] = m.data; if ((st & 0xf0) === 0x90 && vel > 0) noteFromMidi(note); }; });
      btn.classList.add('active');
      toast(n ? `MIDI keyboard connected (${n} input${n > 1 ? 's' : ''})` : 'No MIDI keyboard found — plug one in and try again', n ? 'success' : 'error');
    } catch { toast('MIDI access was blocked', 'error'); }
  }

  const transpose = (steps) => {
    if (!tunes) return;
    try { setText(ABCJS().strTranspose(text, tunes, steps)); toast(`Transposed ${steps > 0 ? 'up' : 'down'} a ${Math.abs(steps) === 1 ? 'half step' : 'whole step'}`, 'info', 1500); }
    catch (e) { toast(`Could not transpose: ${e.message}`, 'error'); }
  };
  const setZoom = (z) => { zoom = Math.min(2, Math.max(0.5, z)); localStorage.setItem('sn_zoom', zoom); render(); };

  const palette = readOnly ? null : h('div', { class: 'palette' },
    h('div', { class: 'pal-group pal-dur' }, ...durBtns),
    h('div', { class: 'pal-group' },
      ins('𝄽', restStr, 'Rest'), act('♯', () => editSelected((t) => toggleAccidental(t, '^')), 'Sharp (selected note)'),
      act('♭', () => editSelected((t) => toggleAccidental(t, '_')), 'Flat (selected note)'),
      act('♮', () => editSelected((t) => toggleAccidental(t, '=')), 'Natural (selected note)'),
      act('↑', () => editSelected((t) => shiftPitch(t, 1)), 'Up a step (↑)'), act('↓', () => editSelected((t) => shiftPitch(t, -1)), 'Down a step (↓)'),
      act('8va', () => editSelected((t) => shiftPitch(t, 7)), 'Up an octave'), act('8vb', () => editSelected((t) => shiftPitch(t, -7)), 'Down an octave')),
    h('div', { class: 'pal-group' },
      ins('|', ' | ', 'Bar line'), ins('||', ' || ', 'Double bar'), ins('|:', ' |: ', 'Start repeat'), ins(':|', ' :| ', 'End repeat'), ins('|]', ' |]', 'Final bar'),
      ins('⁀', '-', 'Tie'), ins('( )', '(', 'Start slur — close it with ")"'), ins(')', ')', 'End slur'), ins('³', '(3', 'Triplet (next 3 notes)'),
      ins('𝄐', 'H', 'Fermata (before a note)'), ins('>', '!>!', 'Accent'), ins('·', '.', 'Staccato')),
    h('div', { class: 'pal-group' }, ...['pp', 'p', 'mp', 'mf', 'f', 'ff'].map((d) => ins(d, `!${d}!`, `Dynamic ${d}`)), ins('<', '!<(!', 'Crescendo start'), ins('>', '!<)!', 'Crescendo end')),
    h('div', { class: 'pal-group' },
      act('Chord', async () => { const c = prompt('Chord symbol (e.g. Am7, G/B):'); if (c) insertAtCursor(`"${c.replace(/"/g, '')}"`); }, 'Chord symbol above the next note'),
      act('Lyrics', () => insertAtCursor('\nw: '), 'Add a lyrics line under the previous music line'),
      act('Text', async () => { const c = prompt('Text above the staff:'); if (c) insertAtCursor(`"^${c.replace(/"/g, '')}"`); }, 'Text annotation')),
    h('div', { class: 'pal-group pal-piano' },
      act('‹', () => { octaveBase = Math.max(24, octaveBase - 12); drawPiano(); }, 'Lower octave'), piano, act('›', () => { octaveBase = Math.min(84, octaveBase + 12); drawPiano(); }, 'Higher octave'),
      h('button', { class: 'pal-btn', title: 'Use a MIDI keyboard to enter notes', html: icon('keyboard', 16), onclick: (e) => toggleMidiInput(e.currentTarget) })));

  // --- history
  async function showHistory() {
    const list = h('div', { class: 'versions' }, 'Loading…');
    const preview = h('div', { class: 'version-preview muted' }, 'Pick a version to preview it.');
    let chosen = null;
    const m = modal({
      title: 'Version history', wide: true, content: h('div', { class: 'history-grid' }, list, preview),
      actions: [{ label: 'Close', onClick: (c) => c() }, { label: 'Restore this version', primary: true, onClick: async (c) => {
        if (!chosen) return;
        await persist(true); // keep the current state as a version first
        setText(chosen); await persist(true); c(); toast('Version restored', 'success');
      } }],
    });
    try {
      const versions = await api(`scores/${meta.id}/versions`);
      list.innerHTML = '';
      if (!versions.length) list.append(h('p', { class: 'muted' }, 'No saved versions yet. Press Ctrl/⌘+S to save one; versions are also kept automatically every 15 minutes while you edit.'));
      for (const v of versions) {
        list.append(h('button', { class: 'version-item', onclick: async (e) => {
          $$('.version-item', list).forEach((x) => x.classList.remove('active')); e.currentTarget.classList.add('active');
          const { content } = await api(`scores/${meta.id}/versions/${v.id}`);
          chosen = content; preview.innerHTML = '';
          ABCJS().renderAbc(preview, content, { responsive: 'resize', scale: 0.8 });
        } }, h('strong', {}, new Date(v.at).toLocaleString()), h('span', { class: 'muted' }, timeAgo(v.at))));
      }
    } catch (e) { list.textContent = e.message; }
    return m;
  }

  // --- original (source PDF/image) pane
  let originalLoaded = false;
  async function showOriginal(on) {
    originalPane.classList.toggle('hidden', !on);
    code.parentElement.classList.toggle('hidden', on);
    if (on && !originalLoaded) {
      originalLoaded = true;
      const url = `/api/scores/${meta.id}/source`;
      if (/pdf/.test(meta.sourceType || '') || /\.pdf$/i.test(meta.source || '')) renderPdfInto(originalPane, url, { scale: 1.2 }).catch((e) => { originalPane.textContent = e.message; });
      else originalPane.append(h('img', { src: url, alt: 'Original', class: 'file-img' }));
    }
  }

  // --- layout
  const tabs = !readOnly && meta.source ? h('div', { class: 'tabs' },
    h('button', { class: 'tab active', onclick: (e) => { $$('.tab', tabs).forEach((t) => t.classList.remove('active')); e.currentTarget.classList.add('active'); showOriginal(false); } }, 'Notation'),
    h('button', { class: 'tab', onclick: (e) => { $$('.tab', tabs).forEach((t) => t.classList.remove('active')); e.currentTarget.classList.add('active'); showOriginal(true); } }, 'Original')) : null;

  const left = readOnly ? null : h('section', { class: 'ed-left' },
    tabs || h('div', { class: 'pane-label' }, 'ABC notation ', h('a', { href: 'https://abcnotation.com/wiki/abc:standard:v2.1', target: '_blank', rel: 'noopener', class: 'muted small' }, 'syntax help')),
    h('div', { class: 'code-wrap' }, code, warnings), originalPane);

  const layoutBtn = readOnly ? null : h('button', { class: 'icon-btn', title: 'Show / hide the notation code', html: icon('menu'), onclick: () => root.querySelector('.editor').classList.toggle('code-hidden') });

  const extra = [
    readOnly ? null : status,
    readOnly ? null : h('button', { class: 'icon-btn', title: 'Version history', html: icon('history'), onclick: showHistory }),
    readOnly ? null : h('button', { class: 'btn', html: `${icon('share', 16)}<span>Share</span>`, onclick: () => shareModal(meta) }),
    exportMenu([
      !readOnly && ['MusicXML (.musicxml)', () => convertMusicXML(meta, text)],
      ['ABC notation (.abc)', () => download(text, `${safeName(meta.title)}.abc`, 'text/plain')],
      ['MIDI file', () => {
        const midi = ABCJS().synth.getMidiFile(text, { midiOutputType: 'binary' });
        download(new Blob([midi[0]], { type: 'audio/midi' }), `${safeName(meta.title)}.mid`);
      }],
      ['Audio (.wav)', async () => {
        try { toast('Preparing audio…', 'info', 1500); await player.exportWav(`${safeName(meta.title)}.wav`); }
        catch (e) { toast(`Audio export failed: ${e.message || e}`, 'error'); }
      }],
      ['SVG image', () => download(serializeSvg(paper.querySelector('svg')), `${safeName(meta.title)}.svg`, 'image/svg+xml')],
      ['Print / save as PDF', () => printSvgs(meta.title, $$('svg', paper))],
      !readOnly && meta.source ? ['Original file', () => window.open(`/api/scores/${meta.id}/source`, '_blank')] : null,
    ]),
  ];

  const toolbar = h('div', { class: 'ed-toolbar' },
    layoutBtn,
    h('div', { class: 'tool-group transpose-group' }, h('span', { class: 'tool-label' }, 'Transpose'),
      readOnly ? null : h('button', { class: 'pal-btn', title: 'Down a half step', onclick: () => transpose(-1) }, '−½'),
      readOnly ? null : h('button', { class: 'pal-btn', title: 'Up a half step', onclick: () => transpose(1) }, '+½')),
    h('div', { class: 'tool-group' }, h('span', { class: 'tool-label' }, 'Zoom'),
      h('button', { class: 'pal-btn', onclick: () => setZoom(zoom - 0.1) }, '−'), h('button', { class: 'pal-btn', onclick: () => setZoom(zoom + 0.1) }, '+')),
    readOnly || !meta.source || !state.session?.aiEnabled ? null : h('button', { class: 'btn btn-ghost', html: `${icon('sparkle', 16)}<span>Re-transcribe</span>`, onclick: async () => {
      if (!(await confirmModal({ title: 'Transcribe again?', message: 'Gemini will read the original again and replace the current notation. Your current version is kept in the version history.', okLabel: 'Transcribe again' }))) return;
      await persist(true);
      const res = await openTranscribe({ score: { ...meta } });
      if (res) { const d = await api(`scores/${meta.id}`); setText(d.content); dirty = false; setStatus('Saved', 'ok'); }
    } }));

  // Transposition in the public view only changes what's shown (doesn't save).
  if (readOnly) {
    const [down, up] = [h('button', { class: 'pal-btn', onclick: () => { text = ABCJS().strTranspose(text, tunes, -1); render(); } }, '−½'), h('button', { class: 'pal-btn', onclick: () => { text = ABCJS().strTranspose(text, tunes, 1); render(); } }, '+½')];
    toolbar.querySelector('.transpose-group').append(down, up);
  }

  root.innerHTML = '';
  player = createPlayer({ meta, publicMode, paper, getTune: () => tunes?.[0], getText: () => text });
  const hint = readOnly
    ? 'Click a note to jump there · Shift+click a second note to loop · Space plays · [ ] change speed'
    : 'Click a note to select & jump there · Shift+click to loop · ↑/↓ or drag to change pitch · A–G pitch · 1–6 duration · Del = rest · Space plays · Ctrl/⌘+S saves a version';
  root.append(h('div', { class: `editor ${readOnly ? 'readonly code-hidden' : ''}` },
    topBar({ meta, publicMode, onTitle: saveMeta, extra }),
    toolbar,
    h('div', { class: 'ed-main' }, left, h('section', { class: 'ed-score' }, player.mediaPane, h('div', { class: 'paper-wrap' }, paper), h('div', { class: 'hint' }, hint))),
    h('div', { class: 'ed-bottom' }, player.keyboard, player.syncBar, player.transport, palette)));

  if (!readOnly && window.innerWidth < 900) root.querySelector('.editor').classList.add('code-hidden');
  render();
  if (!readOnly && !meta.thumb) setTimeout(() => { lastThumb = Date.now(); uploadThumb(meta.id, paper.querySelector('svg')); }, 800);

  const beforeUnload = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', beforeUnload);

  // cleanup when leaving the page
  return () => {
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('beforeunload', beforeUnload);
    try { player?.destroy(); } catch { /* ignore */ }
    if (midiAccess) midiAccess.inputs.forEach((i) => { i.onmidimessage = null; });
    if (dirty && !saving) { autosave.cancel(); persist(false); }
    if (!readOnly) uploadThumb(meta.id, paper.querySelector('svg'));
  };
}

export { thumbFromFile };
