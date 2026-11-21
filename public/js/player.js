// Practice player (Soundslice-style): plays the notation (synth) or a real recording (audio/video file
// or YouTube), keeps the score cursor in sync, click-to-seek, looping, slow-down, voice mixer,
// metronome, visual keyboard, and a tap-to-sync tool that aligns recordings with the bars.
import { api, h, $$, toast, modal, icon, confirmModal, debounce } from './lib.js';

const ABCJS = () => window.ABCJS;
const fmt = (s) => { if (!Number.isFinite(s) || s < 0) s = 0; const m = Math.floor(s / 60); return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`; };

// ---------- media backends ----------
class FileMedia {
  constructor(url, isVideo, container) {
    this.el = document.createElement(isVideo ? 'video' : 'audio');
    this.el.src = url; this.el.preload = 'auto'; this.el.playsInline = true;
    this.el.preservesPitch = true; this.el.mozPreservesPitch = true; this.el.webkitPreservesPitch = true;
    if (isVideo) { this.el.className = 'media-video'; container?.append(this.el); }
    this.ready = new Promise((res) => {
      if (this.el.readyState >= 1) res();
      this.el.addEventListener('loadedmetadata', () => res(), { once: true });
      this.el.addEventListener('error', () => res(), { once: true });
    });
    this.el.addEventListener('ended', () => this.onended?.());
  }
  play() { return this.el.play(); }
  pause() { this.el.pause(); }
  get playing() { return !this.el.paused && !this.el.ended; }
  time() { return this.el.currentTime || 0; }
  seek(t) { try { this.el.currentTime = Math.max(0, Math.min(t, this.duration() || t)); } catch { /* not ready */ } }
  setRate(r) { this.el.playbackRate = r; return r; }
  duration() { return Number.isFinite(this.el.duration) ? this.el.duration : 0; }
  destroy() { this.el.pause(); this.el.removeAttribute('src'); try { this.el.load(); } catch { /* ignore */ } this.el.remove(); }
}

let ytApi;
function loadYouTube() {
  ytApi ||= new Promise((resolve, reject) => {
    if (window.YT?.Player) { resolve(window.YT); return; }
    window.onYouTubeIframeAPIReady = () => resolve(window.YT);
    const s = h('script', { src: 'https://www.youtube.com/iframe_api' });
    s.onerror = () => reject(new Error('Could not load YouTube'));
    document.head.append(s);
  });
  return ytApi;
}
class YouTubeMedia {
  constructor(videoId, container) {
    const target = h('div');
    this.box = h('div', { class: 'media-yt' }, target);
    container.append(this.box);
    this.ready = loadYouTube().then((YT) => new Promise((res) => {
      this.p = new YT.Player(target, {
        videoId, width: '100%', height: '100%',
        playerVars: { playsinline: 1, rel: 0, modestbranding: 1, controls: 1 },
        events: { onReady: () => res(), onStateChange: (e) => { if (e.data === 0) this.onended?.(); } },
      });
    })).catch((e) => toast(e.message, 'error'));
  }
  play() { this.p?.playVideo(); return Promise.resolve(); }
  pause() { this.p?.pauseVideo(); }
  get playing() { return this.p?.getPlayerState?.() === 1; }
  time() { return this.p?.getCurrentTime?.() || 0; }
  seek(t) { this.p?.seekTo(Math.max(0, t), true); }
  setRate(r) {
    const rates = this.p?.getAvailablePlaybackRates?.() || [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
    const best = rates.reduce((a, b) => (Math.abs(b - r) < Math.abs(a - r) ? b : a), 1);
    this.p?.setPlaybackRate(best);
    return best;
  }
  duration() { return this.p?.getDuration?.() || 0; }
  destroy() { try { this.p?.destroy(); } catch { /* ignore */ } this.box.remove(); }
}

// ---------- sync map (performed bar index <-> recording time) ----------
function buildPoints(anchors, barMs, endMs) {
  const pts = (anchors || [])
    .filter((a) => a.bar >= 0 && a.bar <= barMs.length)
    .map((a) => [a.bar >= barMs.length ? endMs : barMs[a.bar], a.t * 1000])
    .sort((x, y) => x[0] - y[0]);
  const clean = [];
  for (const p of pts) if (!clean.length || (p[0] > clean.at(-1)[0] && p[1] > clean.at(-1)[1])) clean.push(p);
  return clean;
}
function interp(pts, x, from, to) {
  if (!pts.length) return x;
  if (pts.length === 1) return x - pts[0][from] + pts[0][to];
  const i = pts.findIndex((p) => p[from] > x);
  const [a, b] = i === -1 ? [pts.at(-2), pts.at(-1)] : i === 0 ? [pts[0], pts[1]] : [pts[i - 1], pts[i]];
  return a[to] + ((x - a[from]) * (b[to] - a[to])) / (b[from] - a[from]);
}

function voiceNames(text, count) {
  const names = [];
  for (const m of text.matchAll(/^V:\s*(\S+)([^\n]*)$/gm)) {
    const id = m[1];
    if (names.some((n) => n.id === id)) continue;
    const nm = m[2].match(/(?:^|\s)name="([^"]+)"/) || m[2].match(/(?:^|\s)nm="([^"]+)"/);
    names.push({ id, name: nm ? nm[1] : id });
  }
  return Array.from({ length: count }, (_, i) => names[i]?.name || `Part ${i + 1}`);
}

// ---------- player ----------
export function createPlayer({ meta, publicMode, paper, getTune, getText }) {
  const base = publicMode ? `public/${meta.id}/recordings` : `scores/${meta.id}/recordings`;
  let recordings = [];
  let source = 'synth';
  let media = null;
  let events = [], barMs = [0], endMs = 0, pts = [];
  let synth = { key: null, url: null, offset: 0, building: null };
  let rate = 1, loop = null, loopOn = false, metronome = false;
  let muted = new Set();
  let lastEventIdx = -1, raf = 0, wasPlaying = false;
  let syncMode = false, nextBar = 0;
  let synthDirty = true;

  // --- DOM
  const mediaPane = h('div', { class: 'media-pane hidden' });
  const playBtn = h('button', { class: 'tp-play', title: 'Play / pause (Space)', html: icon('play', 20) });
  const backBtn = h('button', { class: 'tp-btn', title: 'Back to start', html: '⏮' });
  const timeEl = h('span', { class: 'tp-time' }, '0:00');
  const durEl = h('span', { class: 'tp-time muted' }, '0:00');
  const barEl = h('span', { class: 'tp-bar' }, 'Bar 1');
  const seekEl = h('input', { type: 'range', class: 'tp-seek', min: 0, max: 1000, value: 0, step: 1, 'aria-label': 'Position' });
  const rateEl = h('input', { type: 'range', class: 'tp-rate', min: 25, max: 150, step: 5, value: 100, 'aria-label': 'Speed' });
  const rateLbl = h('button', { class: 'tp-chip', title: 'Reset speed to 100%' }, '100%');
  const loopBtn = h('button', { class: 'tp-chip', title: 'Loop (L). Click a note, then Shift+click another note to set the loop.' }, '⟲ Loop');
  const metroBtn = h('button', { class: 'tp-chip', title: 'Metronome with a one-bar count-in (computer playback)' }, '𝅘𝅥 Click');
  const mixBtn = h('button', { class: 'tp-chip', title: 'Solo or mute parts (computer playback)' }, 'Parts');
  const kbBtn = h('button', { class: 'tp-chip', title: 'Show the notes on a keyboard' }, '🎹');
  const srcSel = h('select', { class: 'tp-source', 'aria-label': 'Playback source' });
  const syncBtn = publicMode ? null : h('button', { class: 'tp-chip', title: 'Align the recording with the bars' }, 'Sync');
  const recBtn = publicMode ? null : h('button', { class: 'tp-chip', title: 'Add or manage recordings', html: `${icon('plus', 14)}<span>Recording</span>` });
  const syncBadge = h('span', { class: 'sync-badge hidden' }, 'Not synced');

  const syncInfo = h('span', {}, '');
  const syncBar = h('div', { class: 'sync-bar hidden' },
    h('strong', {}, 'Sync: '), syncInfo,
    h('button', { class: 'btn btn-primary btn-sm', onclick: () => tap() }, 'Tap (T)'),
    h('button', { class: 'btn btn-sm', onclick: () => undoTap() }, 'Undo'),
    h('button', { class: 'btn btn-sm', title: 'Click a note first, then restart tapping from its bar', onclick: () => fromSelectedBar() }, 'From selected bar'),
    h('button', { class: 'btn btn-sm', title: 'Mark the moment the music ends (helps with steady-tempo recordings)', onclick: () => markEnd() }, 'Mark end'),
    h('button', { class: 'btn btn-sm btn-ghost-danger', onclick: () => clearSync() }, 'Clear'),
    h('button', { class: 'btn btn-sm', onclick: () => toggleSync(false) }, 'Done'));

  const keyboard = h('div', { class: 'viz-keyboard hidden' });
  const keyEls = new Map();
  (function drawKeyboard() {
    const lo = 36, hi = 96; // C2..C7
    for (let m = lo; m <= hi; m++) {
      const black = [1, 3, 6, 8, 10].includes(m % 12);
      const k = h('div', { class: `vk ${black ? 'vk-b' : 'vk-w'}` }, !black && m % 12 === 0 ? `C${m / 12 - 1}` : '');
      keyEls.set(m, k);
      keyboard.append(k);
    }
  })();

  const transport = h('div', { class: 'transport' },
    h('div', { class: 'tp-main' }, backBtn, playBtn, timeEl, seekEl, durEl, barEl),
    h('div', { class: 'tp-tools' },
      h('label', { class: 'tp-src' }, h('span', { class: 'muted small' }, 'Hear'), srcSel), syncBadge,
      h('div', { class: 'tp-rate-wrap', title: 'Speed (keeps the pitch)' }, h('span', { class: 'muted small' }, 'Speed'), rateEl, rateLbl),
      loopBtn, metroBtn, mixBtn, kbBtn, syncBtn, recBtn));

  // --- timing from the rendered notation
  function computeTimings() {
    const tune = getTune();
    events = []; barMs = [0]; endMs = 0;
    if (!tune || !ABCJS()?.TimingCallbacks) return;
    try {
      const tc = new (ABCJS().TimingCallbacks)(tune, {});
      const all = tc.noteTimings || [];
      events = all.filter((e) => e.type === 'event');
      endMs = all.length ? all.at(-1).milliseconds : 0;
      events.forEach((e, i) => { if (i > 0 && e.measureStart && e.milliseconds > barMs.at(-1)) barMs.push(e.milliseconds); });
    } catch { /* tune not drawn yet */ }
    rebuildMap();
  }
  const currentRec = () => recordings.find((r) => r.id === source);
  function rebuildMap() {
    const rec = currentRec();
    pts = rec ? buildPoints(rec.sync?.anchors, barMs, endMs) : [];
    syncBadge.classList.toggle('hidden', !rec || pts.length > 0);
  }
  // source time (s) -> notation time (ms), and back
  const toNotation = (t) => (source === 'synth' ? (t - synth.offset) * 1000 : interp(pts, t * 1000, 1, 0));
  const toSource = (ms) => (source === 'synth' ? ms / 1000 + synth.offset : interp(pts, ms, 0, 1) / 1000);

  function eventIndexAt(ms) {
    let lo = 0, hi = events.length - 1, ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (events[mid].milliseconds <= ms) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans;
  }
  const barIndexAt = (ms) => { let i = 0; while (i + 1 < barMs.length && barMs[i + 1] <= ms) i++; return i; };

  // --- highlighting
  function clearHighlight() {
    $$('.abcjs-playing', paper).forEach((e) => e.classList.remove('abcjs-playing'));
    keyEls.forEach((k) => k.classList.remove('on'));
  }
  function showEvent(idx, scroll = true) {
    if (idx === lastEventIdx) return;
    lastEventIdx = idx;
    clearHighlight();
    const ev = events[idx];
    if (!ev) { paper.querySelector('.abcjs-cursor')?.remove(); return; }
    for (const group of ev.elements || []) for (const el of group) el.classList?.add('abcjs-playing');
    for (const p of ev.midiPitches || []) keyEls.get(p.pitch)?.classList.add('on');
    let cursor = paper.querySelector('.abcjs-cursor');
    const svg = paper.querySelector('svg');
    if (!cursor && svg) { cursor = document.createElementNS('http://www.w3.org/2000/svg', 'line'); cursor.setAttribute('class', 'abcjs-cursor'); svg.appendChild(cursor); }
    if (cursor && ev.left != null) {
      cursor.setAttribute('x1', ev.left - 2); cursor.setAttribute('x2', ev.left - 2);
      cursor.setAttribute('y1', ev.top); cursor.setAttribute('y2', ev.top + ev.height);
    }
    const first = ev.elements?.[0]?.[0];
    if (scroll && first) {
      const r = first.getBoundingClientRect(), wrap = paper.parentElement.getBoundingClientRect();
      if (r.top < wrap.top + 30 || r.bottom > wrap.bottom - 30) first.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }
  function markLoop() {
    $$('.in-loop', paper).forEach((e) => e.classList.remove('in-loop'));
    if (!loop) return;
    for (const ev of events) if (ev.milliseconds >= loop.a && ev.milliseconds < loop.b) for (const g of ev.elements || []) for (const el of g) el.classList?.add('in-loop');
  }

  // --- the animation loop
  function tick() {
    raf = requestAnimationFrame(tick);
    if (!media) return;
    const t = media.time();
    const dur = media.duration() || (source === 'synth' ? endMs / 1000 + synth.offset : 0);
    const playing = media.playing;
    if (playing !== wasPlaying) { wasPlaying = playing; playBtn.innerHTML = playing ? '<span class="pause-ic"></span>' : icon('play', 20); }
    timeEl.textContent = fmt(t); durEl.textContent = fmt(dur);
    if (!seekEl.matches(':active')) seekEl.value = dur ? Math.round((t / dur) * 1000) : 0;
    const ms = toNotation(t);
    if (loop && loopOn && playing && ms >= loop.b) { media.seek(toSource(loop.a)); return; }
    if (playing || syncMode) {
      showEvent(eventIndexAt(ms), playing);
      barEl.textContent = `Bar ${barIndexAt(ms) + 1}`;
    }
  }

  // --- synth (computer playback) rendered to a WAV so it shares the same player as recordings
  async function buildSynth() {
    const tune = getTune();
    const key = JSON.stringify([getText(), [...muted], metronome]);
    if (synth.url && synth.key === key) return;
    if (synth.building && synth.buildingKey === key) return synth.building;
    synth.buildingKey = key;
    synth.building = (async () => {
      timeEl.textContent = '…';
      const opts = {};
      if (muted.size) opts.voicesOff = [...muted];
      let offset = 0;
      if (metronome) {
        const n = Math.max(1, Math.round(tune.getBeatsPerMeasure()));
        opts.drum = `${'d'.repeat(n)} 76 ${Array(n - 1).fill(77).join(' ')} 100 ${Array(n - 1).fill(70).join(' ')}`.replace(/\s+/g, ' ').trim();
        opts.drumBars = 1; opts.drumIntro = 1;
        offset = tune.millisecondsPerMeasure() / 1000;
      }
      const s = new (ABCJS().synth.CreateSynth)();
      await s.init({ visualObj: tune, options: opts });
      await s.prime();
      const url = s.download();
      if (synth.url) URL.revokeObjectURL(synth.url);
      synth = { key, url, offset, building: null };
      synthDirty = false;
    })();
    try { await synth.building; } finally { synth.building = null; }
  }

  async function useSource(id, { keepPosition = true } = {}) {
    const wasAt = media ? toNotation(media.time()) : 0;
    const resume = media?.playing;
    media?.pause(); media?.destroy(); media = null;
    source = id;
    mediaPane.innerHTML = ''; mediaPane.classList.add('hidden');
    rebuildMap();
    const rec = currentRec();
    if (!rec) {
      try { await buildSynth(); } catch (e) { toast(`Playback failed: ${e.message || e}`, 'error'); return; }
      media = new FileMedia(synth.url, false);
    } else if (rec.kind === 'youtube') {
      mediaPane.classList.remove('hidden');
      media = new YouTubeMedia(rec.youtube, mediaPane);
    } else {
      const video = /^video\//.test(rec.mime || '');
      if (video) mediaPane.classList.remove('hidden');
      media = new FileMedia(`/api/${base}/${rec.id}${publicMode ? '' : '/file'}`, video, mediaPane);
    }
    media.onended = () => { if (loop && loopOn) { media.seek(toSource(loop.a)); media.play(); } };
    await media.ready;
    rate = media.setRate(rate);
    if (keepPosition && wasAt > 0) media.seek(toSource(wasAt));
    if (resume) media.play().catch(() => {});
    if (syncBtn) syncBtn.disabled = !rec;
    if (!rec && syncMode) toggleSync(false);
  }

  async function togglePlay() {
    if (source === 'synth' && (synthDirty || !media)) {
      const at = media ? toNotation(media.time()) : 0;
      await useSource('synth', { keepPosition: false });
      if (at > 0) media.seek(toSource(at));
    }
    if (!media) await useSource(source);
    if (!media) return;
    if (media.playing) { media.pause(); return; }
    if (loop && loopOn) { const ms = toNotation(media.time()); if (ms < loop.a || ms >= loop.b) media.seek(toSource(loop.a)); }
    try { await media.play(); } catch (e) { toast(`Could not play: ${e.message || e}`, 'error'); }
  }

  function setRate(pct) {
    pct = Math.min(150, Math.max(25, Math.round(pct / 5) * 5));
    rate = pct / 100;
    if (media) rate = media.setRate(rate);
    rateEl.value = Math.round(rate * 100); rateLbl.textContent = `${Math.round(rate * 100)}%`;
  }

  function setLoopOn(on) {
    loopOn = on && !!loop;
    loopBtn.classList.toggle('active', loopOn);
    paper.classList.toggle('looping', loopOn);
    if (on && !loop) toast('Click a note, then Shift+click a later note to choose what to loop', 'info', 3500);
  }

  // --- recordings
  async function loadRecordings() {
    try { recordings = await api(base); } catch { recordings = []; }
    fillSources();
  }
  function fillSources() {
    srcSel.innerHTML = '';
    srcSel.append(h('option', { value: 'synth' }, 'Computer playback'));
    for (const r of recordings) srcSel.append(h('option', { value: r.id }, `${r.kind === 'youtube' ? '▶ ' : '♪ '}${r.name}`));
    if (!recordings.some((r) => r.id === source)) source = 'synth';
    srcSel.value = source;
    srcSel.parentElement?.classList.toggle('hidden', publicMode && !recordings.length);
  }

  function recordingsModal() {
    const list = h('div', { class: 'rec-list' });
    const draw = () => {
      list.innerHTML = '';
      if (!recordings.length) list.append(h('p', { class: 'muted' }, 'No recordings yet. Add a rehearsal track, a performance video, or a YouTube link, then sync it to the bars.'));
      for (const r of recordings) {
        const synced = (r.sync?.anchors || []).length;
        list.append(h('div', { class: 'rec-item' },
          h('span', { class: 'rec-kind' }, r.kind === 'youtube' ? '▶' : /^video/.test(r.mime || '') ? '🎬' : '♪'),
          h('div', { class: 'rec-text' }, h('strong', {}, r.name), h('span', { class: 'muted small' }, `${r.kind === 'youtube' ? 'YouTube' : `${((r.size || 0) / 1048576).toFixed(1)} MB`} · ${synced ? `synced (${synced} points)` : 'not synced'}`)),
          h('button', { class: 'btn btn-sm', onclick: async () => {
            const name = prompt('Recording name', r.name);
            if (!name) return;
            Object.assign(r, await api(`${base}/${r.id}`, { method: 'PATCH', body: { name } })); draw(); fillSources();
          } }, 'Rename'),
          h('button', { class: 'btn btn-sm btn-ghost-danger', onclick: async () => {
            if (!(await confirmModal({ title: 'Delete recording?', message: `“${r.name}” and its sync points will be deleted.`, okLabel: 'Delete', danger: true }))) return;
            await api(`${base}/${r.id}`, { method: 'DELETE' });
            recordings = recordings.filter((x) => x.id !== r.id);
            if (source === r.id) await useSource('synth');
            draw(); fillSources();
          } }, 'Delete')));
      }
    };
    draw();
    const file = h('input', { type: 'file', accept: 'audio/*,video/mp4,video/webm,video/quicktime', class: 'hidden' });
    const prog = h('div', { class: 'progress hidden' }, h('div', { class: 'progress-fill' }));
    const yt = h('input', { class: 'input', placeholder: 'Paste a YouTube link' });
    file.addEventListener('change', async () => {
      const f = file.files[0]; if (!f) return;
      if (f.size > 95 * 1048576) { toast('Files must be under 95 MB', 'error'); return; }
      prog.classList.remove('hidden');
      try {
        const rec = await uploadWithProgress(`/api/${base}`, f, (p) => { prog.firstChild.style.width = `${Math.round(p * 100)}%`; });
        recordings.push(rec); draw(); fillSources(); toast('Recording added. Choose it under “Hear”, then press Sync.', 'success', 4500);
        srcSel.value = rec.id; await useSource(rec.id, { keepPosition: false });
      } catch (e) { toast(e.message, 'error'); }
      prog.classList.add('hidden'); file.value = '';
    });
    modal({
      title: 'Recordings', wide: true,
      content: h('div', { class: 'stack' }, list,
        h('div', { class: 'rec-add' },
          h('button', { class: 'btn', onclick: () => file.click(), html: `${icon('upload', 16)}<span>Upload audio or video</span>` }), file,
          h('div', { class: 'row grow' }, yt, h('button', { class: 'btn', onclick: async () => {
            try {
              const rec = await api(base, { method: 'POST', body: { youtube: yt.value, name: 'YouTube video' } });
              const name = prompt('Name for this video', 'YouTube video'); if (name) Object.assign(rec, await api(`${base}/${rec.id}`, { method: 'PATCH', body: { name } }));
              recordings.push(rec); yt.value = ''; draw(); fillSources();
              srcSel.value = rec.id; await useSource(rec.id, { keepPosition: false });
            } catch (e) { toast(e.message, 'error'); }
          } }, 'Add link'))),
        prog,
        h('p', { class: 'muted small' }, 'MP3, M4A, WAV, OGG, MP4 or WebM, up to 95 MB each. After adding a recording, press “Sync” and tap at the start of each bar while it plays.')),
      actions: [{ label: 'Done', primary: true, onClick: (c) => c() }],
    });
  }

  function uploadWithProgress(url, file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      xhr.setRequestHeader('content-type', file.type || 'audio/mpeg');
      xhr.setRequestHeader('x-filename', encodeURIComponent(file.name));
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onload = () => { let d; try { d = JSON.parse(xhr.responseText); } catch { d = {}; } xhr.status < 300 ? resolve(d) : reject(new Error(d.error || `Upload failed (${xhr.status})`)); };
      xhr.onerror = () => reject(new Error('Upload failed — check your connection'));
      xhr.send(file);
    });
  }

  // --- sync tool
  const saveSync = debounce(async () => {
    const rec = currentRec(); if (!rec || publicMode) return;
    try { await api(`${base}/${rec.id}`, { method: 'PATCH', body: { sync: rec.sync } }); } catch (e) { toast(`Sync not saved: ${e.message}`, 'error'); }
  }, 800);
  function updateSyncInfo() {
    const rec = currentRec();
    const n = rec?.sync?.anchors?.length || 0;
    syncInfo.textContent = nextBar < barMs.length
      ? `play the recording and tap on beat 1 of every bar — next: bar ${nextBar + 1} of ${barMs.length} (${n} points)`
      : `all ${barMs.length} bars tapped — press “Mark end” when the music stops, then Done`;
  }
  function toggleSync(on) {
    const rec = currentRec();
    if (on && !rec) { toast('Choose a recording under “Hear” first (or add one)', 'info'); return; }
    syncMode = on;
    syncBar.classList.toggle('hidden', !on);
    syncBtn?.classList.toggle('active', on);
    if (on) {
      const anchors = rec.sync?.anchors || [];
      nextBar = anchors.length ? Math.min(barMs.length, Math.max(...anchors.filter((a) => a.bar < barMs.length).map((a) => a.bar), -1) + 1) : 0;
      updateSyncInfo();
    } else saveSync.flush?.();
  }
  function tap() {
    const rec = currentRec(); if (!rec || !media) return;
    if (nextBar >= barMs.length) { toast('All bars are tapped. Use “From selected bar” to redo a section.', 'info'); return; }
    const t = media.time();
    rec.sync ||= { anchors: [] };
    // keep earlier anchors, replace this bar and anything after it that's now out of order
    rec.sync.anchors = rec.sync.anchors.filter((a) => a.bar < nextBar || (a.bar > nextBar && a.t > t));
    rec.sync.anchors.push({ bar: nextBar, t: Math.round(t * 1000) / 1000 });
    rec.sync.anchors.sort((a, b) => a.bar - b.bar);
    nextBar++;
    rebuildMap(); updateSyncInfo(); saveSync();
    syncBar.classList.add('flash'); setTimeout(() => syncBar.classList.remove('flash'), 120);
  }
  function undoTap() {
    const rec = currentRec(); if (!rec?.sync?.anchors?.length) return;
    const last = rec.sync.anchors.filter((a) => a.bar < barMs.length).sort((a, b) => b.bar - a.bar)[0];
    if (!last) return;
    rec.sync.anchors = rec.sync.anchors.filter((a) => a !== last);
    nextBar = last.bar;
    rebuildMap(); updateSyncInfo(); saveSync();
  }
  let selectedMs = null;
  function fromSelectedBar() {
    if (selectedMs == null) { toast('Click a note in the bar you want to restart from', 'info'); return; }
    nextBar = barIndexAt(selectedMs);
    if (media) media.seek(Math.max(0, toSource(barMs[nextBar]) - 2));
    updateSyncInfo();
    toast(`Tapping restarts at bar ${nextBar + 1}. Press play and tap on its first beat.`, 'info');
  }
  function markEnd() {
    const rec = currentRec(); if (!rec || !media) return;
    rec.sync.anchors = rec.sync.anchors.filter((a) => a.bar < barMs.length).concat({ bar: barMs.length, t: media.time() });
    rebuildMap(); saveSync(); toast('End marked', 'success', 1500);
  }
  async function clearSync() {
    const rec = currentRec(); if (!rec) return;
    if (!(await confirmModal({ title: 'Clear sync?', message: 'All sync points for this recording will be removed.', okLabel: 'Clear', danger: true }))) return;
    rec.sync = { anchors: [] }; nextBar = 0; rebuildMap(); updateSyncInfo(); saveSync();
  }

  function mixerModal() {
    const tune = getTune();
    const count = (tune?.lines || []).reduce((mx, l) => Math.max(mx, (l.staff || []).reduce((n, st) => n + (st.voices?.length || 0), 0)), 0);
    if (count < 2) { toast('This score has only one part', 'info'); return; }
    const names = voiceNames(getText(), count);
    const rows = names.map((name, i) => {
      const cb = h('input', { type: 'checkbox', checked: !muted.has(i) });
      const solo = h('button', { class: 'btn btn-sm', onclick: () => { $$('.mix-row input', box).forEach((c, j) => { c.checked = j === i; }); } }, 'Solo');
      return h('label', { class: 'mix-row' }, cb, h('span', { class: 'grow' }, name), solo);
    });
    const box = h('div', { class: 'stack' }, h('p', { class: 'muted small' }, 'Choose which parts the computer plays. Great for practising your own line with the others, or hearing it alone.'), ...rows,
      h('button', { class: 'btn btn-sm', onclick: () => $$('.mix-row input', box).forEach((c) => { c.checked = true; }) }, 'All parts'));
    modal({
      title: 'Parts', content: box,
      actions: [{ label: 'Apply', primary: true, onClick: async (c) => {
        muted = new Set($$('.mix-row input', box).map((cb, i) => (cb.checked ? -1 : i)).filter((i) => i >= 0));
        mixBtn.classList.toggle('active', muted.size > 0);
        c(); synthDirty = true;
        if (source !== 'synth') { srcSel.value = 'synth'; }
        await useSource('synth');
      } }],
    });
  }

  // --- wire up
  playBtn.addEventListener('click', togglePlay);
  backBtn.addEventListener('click', () => { media?.seek(loop && loopOn ? toSource(loop.a) : toSource(0)); lastEventIdx = -1; });
  seekEl.addEventListener('input', () => { if (!media) return; const d = media.duration() || endMs / 1000; media.seek((seekEl.value / 1000) * d); lastEventIdx = -1; showEvent(eventIndexAt(toNotation(media.time())), false); });
  rateEl.addEventListener('input', () => setRate(Number(rateEl.value)));
  rateLbl.addEventListener('click', () => setRate(100));
  loopBtn.addEventListener('click', () => setLoopOn(!loopOn));
  metroBtn.addEventListener('click', async () => { metronome = !metronome; metroBtn.classList.toggle('active', metronome); synthDirty = true; if (source === 'synth' && media) await useSource('synth'); else if (metronome) toast('The click plays with computer playback', 'info'); });
  mixBtn.addEventListener('click', mixerModal);
  kbBtn.addEventListener('click', () => { keyboard.classList.toggle('hidden'); kbBtn.classList.toggle('active', !keyboard.classList.contains('hidden')); });
  srcSel.addEventListener('change', () => useSource(srcSel.value));
  syncBtn?.addEventListener('click', () => toggleSync(!syncMode));
  recBtn?.addEventListener('click', recordingsModal);
  raf = requestAnimationFrame(tick);
  loadRecordings().then(() => {
    // public links open on the first synced recording, like a lesson
    if (publicMode) { const r = recordings.find((x) => x.sync?.anchors?.length) || recordings[0]; if (r) { srcSel.value = r.id; useSource(r.id, { keepPosition: false }); } }
  });

  return {
    transport, mediaPane, keyboard, syncBar,
    // call after every render of the notation
    onRender() { synthDirty = true; lastEventIdx = -1; computeTimings(); markLoop(); if (syncMode) updateSyncInfo(); },
    // a note was clicked: jump there (and Shift+click sets a loop)
    onNoteClick(abcElem, ev) {
      const matches = events.filter((e) => e.startChar === abcElem.startChar || (e.elements || []).some((g) => g.some((el) => abcElem.abselem?.elemset?.includes(el))));
      if (!matches.length) return;
      const now = media ? toNotation(media.time()) : 0;
      const target = matches.find((e) => e.milliseconds >= now - 1) || matches[0];
      if (ev?.shiftKey && selectedMs != null) {
        const idx = events.indexOf(target);
        const end = events[idx + 1]?.milliseconds ?? endMs;
        const a = Math.min(selectedMs, target.milliseconds), b = Math.max(end, selectedMs);
        loop = { a, b }; markLoop(); setLoopOn(true);
        toast(`Looping bars ${barIndexAt(a) + 1}–${barIndexAt(b - 1) + 1}`, 'info', 1800);
        if (media) media.seek(toSource(a));
        return;
      }
      selectedMs = target.milliseconds;
      if (media) { media.seek(toSource(target.milliseconds)); lastEventIdx = -1; }
      barEl.textContent = `Bar ${barIndexAt(target.milliseconds) + 1}`;
    },
    // global shortcuts; returns true when handled
    handleKey(e) {
      if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return false;
      if (e.ctrlKey || e.metaKey || e.altKey) return false;
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); return true; }
      if (e.key === 'l' || e.key === 'L') { setLoopOn(!loopOn); return true; }
      if (e.key === '[') { setRate(rate * 100 - 5); return true; }
      if (e.key === ']') { setRate(rate * 100 + 5); return true; }
      if (syncMode && (e.key === 't' || e.key === 'T')) { e.preventDefault(); tap(); return true; }
      return false;
    },
    async exportWav(filename) {
      await buildSynth();
      const a = h('a', { href: synth.url, download: filename }); document.body.append(a); a.click(); a.remove();
    },
    stop() { media?.pause(); },
    destroy() { cancelAnimationFrame(raf); media?.pause(); media?.destroy(); if (synth.url) URL.revokeObjectURL(synth.url); },
  };
}
