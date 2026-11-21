// AI transcription: PDF / photo of sheet music -> editable ABC score, streamed live.
import { api, h, modal, toast, loadPdfJs, state, icon } from './lib.js';
import { cleanAiAbc, splitHeader, stripRepeatedHeader } from './abc.js';

const TARGET_WIDTH = 1700;
const MAX_PAGES = 30;

// Turn a canvas into one or two JPEG parts (tall pages are split in half so small notes stay readable).
function canvasToParts(canvas) {
  const toPart = (c) => ({ media_type: 'image/jpeg', data: c.toDataURL('image/jpeg', 0.85).split(',')[1] });
  if (canvas.height < canvas.width * 1.15) return [toPart(canvas)];
  const overlap = Math.round(canvas.height * 0.04);
  const half = Math.round(canvas.height / 2);
  const crop = (y, hgt) => {
    const c = document.createElement('canvas');
    c.width = canvas.width; c.height = hgt;
    c.getContext('2d').drawImage(canvas, 0, y, canvas.width, hgt, 0, 0, canvas.width, hgt);
    return c;
  };
  return [toPart(crop(0, half + overlap)), toPart(crop(half - overlap, canvas.height - half + overlap))];
}

function whiteCanvas(w, hgt) {
  const c = document.createElement('canvas');
  c.width = w; c.height = hgt;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, hgt);
  return c;
}

export async function pdfPageCount(source) {
  const pdfjs = await loadPdfJs();
  const doc = await pdfjs.getDocument(source).promise;
  return doc.numPages;
}

async function* pdfPages(source, from, to) {
  const pdfjs = await loadPdfJs();
  const doc = await pdfjs.getDocument(source).promise;
  const last = Math.min(to || doc.numPages, doc.numPages);
  for (let i = Math.max(1, from || 1); i <= last; i++) {
    const page = await doc.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: TARGET_WIDTH / base.width });
    const canvas = whiteCanvas(Math.round(vp.width), Math.round(vp.height));
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    yield { page: i, total: last - Math.max(1, from || 1) + 1, canvas };
  }
}

async function imageCanvas(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Could not read image')); i.src = url; });
    const scale = Math.min(1, TARGET_WIDTH / img.naturalWidth) || 1;
    const c = whiteCanvas(Math.round(img.naturalWidth * scale), Math.round(img.naturalHeight * scale));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c;
  } finally { URL.revokeObjectURL(url); }
}

// Small preview for library cards (SVG wrapping a JPEG), used for PDF / image scores.
export async function thumbFromFile(blob, isPdf) {
  let canvas;
  if (isPdf) {
    const pdfjs = await loadPdfJs();
    const doc = await pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: 420 / base.width });
    canvas = whiteCanvas(Math.round(vp.width), Math.round(vp.height));
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  } else {
    const full = await imageCanvas(blob);
    canvas = whiteCanvas(420, Math.round((420 * full.height) / full.width));
    canvas.getContext('2d').drawImage(full, 0, 0, canvas.width, canvas.height);
  }
  const data = canvas.toDataURL('image/jpeg', 0.7);
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${canvas.width} ${canvas.height}" width="${canvas.width}" height="${canvas.height}"><image href="${data}" width="${canvas.width}" height="${canvas.height}"/></svg>`;
}

// Stream text from the /api/transcribe endpoint (Claude server-sent events).
async function streamAI(body, onText, signal) {
  const res = await fetch('/api/transcribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
  if (!res.ok) {
    let msg = `Transcription failed (${res.status})`;
    try { msg = (await res.json()).error || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data:')) continue;
        let d; try { d = JSON.parse(line.slice(5)); } catch { continue; }
        if (d.type === 'content_block_delta' && d.delta?.text) { out += d.delta.text; onText(out); }
        else if (d.type === 'error') throw new Error(d.error?.message || 'AI error');
      }
    }
  }
  return out;
}

/**
 * Open the transcription dialog.
 * opts.file   — a File/Blob (PDF or image) to transcribe into a NEW score, or
 * opts.score  — an existing pdf/image score to convert in place (uses its stored source), or
 * opts.musicxml — { text, title } to convert a MusicXML score into a new editable ABC copy.
 */
export function openTranscribe(opts) {
  return new Promise((resolve) => {
    const isXml = !!opts.musicxml;
    const srcName = opts.file?.name || opts.score?.source || opts.musicxml?.title || 'score';
    const isPdf = isXml ? false : /pdf/i.test(opts.file?.type || opts.score?.sourceType || '') || /\.pdf$/i.test(srcName);
    const defaultTitle = (opts.score?.title || opts.musicxml?.title || srcName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ')).trim();

    const title = h('input', { class: 'input', value: defaultTitle });
    const from = h('input', { class: 'input input-sm', type: 'number', min: 1, value: 1 });
    const to = h('input', { class: 'input input-sm', type: 'number', min: 1, value: 1 });
    const pageInfo = h('span', { class: 'muted' }, '');
    const hint = h('textarea', { class: 'input', rows: 2, placeholder: 'Optional: e.g. "SATB choir with piano, lyrics in Tagalog", "lead sheet", "guitar tab — ignore the tab staff"' });
    const setup = h('div', { class: 'stack' },
      h('p', { class: 'muted' }, isXml
        ? 'Claude will rewrite this MusicXML as an editable score. The original stays untouched.'
        : 'Claude reads each page and writes it out as editable notation you can play, transpose and correct. Clean, straight scans give the best results.'),
      h('label', { class: 'field' }, h('span', {}, 'Score title'), title),
      isPdf ? h('div', { class: 'field' }, h('span', {}, 'Pages to transcribe'), h('div', { class: 'row' }, from, h('span', {}, 'to'), to, pageInfo)) : null,
      isXml ? null : h('label', { class: 'field' }, h('span', {}, 'Anything Claude should know?'), hint));

    const status = h('div', { class: 'tx-status' }, 'Preparing…');
    const bar = h('div', { class: 'progress' }, h('div', { class: 'progress-fill' }));
    const live = h('pre', { class: 'tx-live' });
    const preview = h('div', { class: 'tx-preview' });
    const running = h('div', { class: 'stack hidden' }, status, bar, h('div', { class: 'tx-grid' }, h('div', {}, h('div', { class: 'label' }, 'Notation (live)'), live), h('div', {}, h('div', { class: 'label' }, 'Preview'), preview)));

    let controller = null, finished = false, result = '';
    let primaryAction = () => start();
    const m = modal({
      title: isXml ? 'Convert to editable score' : 'Transcribe with AI',
      wide: true,
      content: h('div', {}, setup, running),
      actions: [
        { label: 'Cancel', onClick: (close) => { controller?.abort(); close(); } },
        { label: 'Start transcription', primary: true, onClick: () => primaryAction() },
      ],
      onClose: () => { controller?.abort(); if (!finished) resolve(null); },
    });
    const startBtn = m.el.querySelector('.modal-foot .btn-primary');

    let source;
    const sourceReady = (async () => {
      if (isXml) return;
      if (opts.file) source = opts.file;
      else {
        const res = await fetch(`/api/scores/${opts.score.id}/source`);
        if (!res.ok) throw new Error('Could not load the original file');
        source = await res.blob();
      }
      if (isPdf) {
        const n = await pdfPageCount({ data: new Uint8Array(await source.arrayBuffer()) });
        to.value = Math.min(n, MAX_PAGES); to.max = n; from.max = n;
        pageInfo.textContent = `(${n} page${n > 1 ? 's' : ''}${n > MAX_PAGES ? `, max ${MAX_PAGES} at a time` : ''})`;
      }
    })().catch((e) => toast(e.message, 'error'));

    let renderTimer;
    const showPreview = (abc) => {
      clearTimeout(renderTimer);
      renderTimer = setTimeout(() => { try { window.ABCJS?.renderAbc(preview, abc, { responsive: 'resize', add_classes: true }); } catch { /* partial text */ } }, 600);
    };
    const setProgress = (p) => { bar.firstChild.style.width = `${Math.round(p * 100)}%`; };

    async function start() {
      await sourceReady;
      if (!state.session?.aiEnabled) { toast('AI transcription is not set up on the server yet (ANTHROPIC_API_KEY).', 'error', 6000); return; }
      setup.classList.add('hidden'); running.classList.remove('hidden');
      startBtn.disabled = true; startBtn.textContent = 'Transcribing…';
      controller = new AbortController();
      const signal = controller.signal;
      let full = '';
      try {
        if (isXml) {
          status.textContent = 'Converting MusicXML…';
          full = cleanAiAbc(await streamAI({ mode: 'convert', text: opts.musicxml.text }, (t) => { live.textContent = t; live.scrollTop = 1e9; showPreview(cleanAiAbc(t)); setProgress(Math.min(0.95, t.length / 8000)); }, signal));
        } else {
          const pages = [];
          if (isPdf) {
            const data = new Uint8Array(await source.arrayBuffer());
            const f = Math.max(1, Number(from.value) || 1);
            const t = Math.min(Number(to.value) || f, f + MAX_PAGES - 1);
            status.textContent = 'Reading the PDF…';
            for await (const p of pdfPages({ data }, f, t)) pages.push({ page: p.page, total: p.total, parts: canvasToParts(p.canvas) });
          } else {
            pages.push({ page: 1, total: 1, parts: canvasToParts(await imageCanvas(source)) });
          }
          let header = '';
          for (let i = 0; i < pages.length; i++) {
            const pg = pages[i];
            status.textContent = `Transcribing page ${i + 1} of ${pages.length}…`;
            setProgress(i / pages.length);
            const before = full;
            const body = i === 0
              ? { mode: 'first', images: pg.parts, page: i + 1, pages: pages.length, title: title.value, hint: hint.value }
              : { mode: 'continue', images: pg.parts, page: i + 1, pages: pages.length, header, tail: before.split('\n').slice(-6).join('\n'), hint: hint.value };
            const text = await streamAI(body, (t) => {
              const cur = i === 0 ? cleanAiAbc(t) : `${before}\n${stripRepeatedHeader(t)}`;
              live.textContent = cur; live.scrollTop = 1e9; showPreview(cur);
            }, signal);
            full = i === 0 ? cleanAiAbc(text) : `${before}\n% --- page ${pg.page} ---\n${stripRepeatedHeader(text)}`;
            if (i === 0) header = splitHeader(full).header;
          }
        }
        if (title.value.trim()) full = /^T:/m.test(full) ? full.replace(/^T:.*$/m, `T:${title.value.trim()}`) : full.replace(/^(X:.*)$/m, `$1\nT:${title.value.trim()}`);
        if (!/^X:/m.test(full)) full = `X:1\n${full}`;
        setProgress(1);
        status.textContent = 'Done — saving your score…';
        result = full;
        const saved = await save(result);
        finished = true;
        m.close();
        toast('Transcription finished. Check it against the original and fix anything Claude misread.', 'success', 6000);
        resolve(saved);
      } catch (e) {
        if (e.name === 'AbortError') return;
        status.textContent = `Stopped: ${e.message}`;
        startBtn.disabled = false;
        if (full || live.textContent) {
          startBtn.textContent = 'Save what was transcribed';
          primaryAction = async () => { finished = true; const s = await save(full || cleanAiAbc(live.textContent)); m.close(); resolve(s); };
        } else { startBtn.textContent = 'Try again'; primaryAction = () => { setup.classList.remove('hidden'); running.classList.add('hidden'); startBtn.textContent = 'Start transcription'; primaryAction = () => start(); }; }
        toast(e.message, 'error', 7000);
      }
    }

    async function save(abc) {
      const name = title.value.trim() || defaultTitle;
      if (opts.score) {
        return api(`scores/${opts.score.id}`, { method: 'PUT', body: { type: 'abc', content: abc, title: name, snapshot: true } });
      }
      const meta = await api('scores', { method: 'POST', body: { type: 'abc', title: name, content: abc, transcribed: true, folder: opts.folder || null } });
      if (opts.file) {
        await api(`scores/${meta.id}/source`, { method: 'PUT', body: opts.file, headers: { 'content-type': opts.file.type || 'application/octet-stream', 'x-filename': encodeURIComponent(opts.file.name || 'source') } });
      }
      return meta;
    }
  });
}

export const transcribeIcon = () => icon('sparkle');
