import { api, h, modal, download, safeName, state, toast } from './lib.js';
import { pdfPages, pdfPageCount, imageCanvas, canvasToParts, streamAI } from './transcribe.js';

const parts = doc => [...doc.documentElement.children].filter(el => el.localName === 'part');
const measures = part => [...part.children].filter(el => el.localName === 'measure');

export function appendPage(score, raw) {
  const xml = raw.trim().replace(/^\x60\x60\x60(?:xml|musicxml)?\s*/i, '').replace(/\s*\x60\x60\x60$/, '');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const page = parts(doc);
  const labels = [...doc.querySelectorAll('part-list > score-part')].map(p => p.id);
  if (doc.documentElement.localName !== 'score-partwise' || doc.querySelector('parsererror') ||
      !page.length || !doc.querySelector('measure > note') || labels.length !== page.length ||
      new Set(page.map(p => p.id)).size !== page.length ||
      page.some(p => !p.id || !labels.includes(p.id) || !measures(p).length)) {
    throw new Error('Recognition returned an incomplete score. Try a clearer scan or a shorter selection.');
  }
  if (!score) return doc;
  const targets = parts(score);
  if (targets.length !== page.length || targets.some(t => !page.some(p => p.id === t.id))) {
    throw new Error('The instrument parts changed between pages. Convert the sections separately.');
  }
  for (const target of targets) {
    const incoming = page.find(p => p.id === target.id);
    const prior = measures(target);
    let next = Number(prior.at(-1).getAttribute('number'));
    if (!Number.isInteger(next)) next = prior.length;
    for (const m of measures(incoming)) {
      const copy = score.importNode(m, true);
      copy.setAttribute('number', String(++next));
      target.append(copy);
    }
  }
  return score;
}

export async function convertMusicXML(meta, abc) {
  if (!state.session?.aiEnabled) {
    toast('MusicXML recognition needs a Gemini API key in the Worker settings.', 'error');
    return null;
  }
  const controller = new AbortController();
  const { signal } = controller;
  const pdf = meta.type === 'pdf';
  const from = h('input', { class: 'input input-sm', type: 'number', value: 1, min: 1, 'aria-label': 'First page' });
  const to = h('input', { class: 'input input-sm', type: 'number', value: 1, min: 1, 'aria-label': 'Last page' });
  const status = h('p', { class: 'muted', role: 'status' }, 'Preparing score…');
  const progress = h('progress', { class: 'xml-progress', max: 1, value: 0, 'aria-label': 'Recognition progress' });
  let source, pageCount = 1, result = null;
  return new Promise(resolve => {
    const dialog = modal({
      title: 'Convert to MusicXML',
      content: h('div', { class: 'stack' }, h('strong', {}, meta.title),
        h('p', {}, 'Send the selected music to Gemini for recognition. Review pitches and rhythms before engraving.'),
        pdf && h('div', { class: 'row' }, 'Pages', from, 'through', to), progress, status),
      actions: [{ label: 'Cancel', onClick: close => close() }, { label: 'Convert score', primary: true, onClick: run }],
      onClose: () => { controller.abort(); resolve(result); }
    });
    const button = dialog.el.querySelector('.btn-primary');
    button.disabled = true;
    async function prepare() {
      if (abc === undefined) {
        const res = await fetch('/api/scores/' + meta.id + '/source', { signal });
        if (!res.ok) throw new Error('Could not open the original file.');
        source = await res.blob();
        if (pdf) pageCount = await pdfPageCount({ data: new Uint8Array(await source.arrayBuffer()) });
      }
      if (signal.aborted) return;
      from.max = to.max = pageCount;
      to.value = Math.min(pageCount, 30);
      status.textContent = pdf ? pageCount + ' pages available · up to 30 per conversion' : 'Ready to convert';
      button.disabled = false;
    }
    prepare().catch(e => { status.textContent = e.message; });
    async function run() {
      const first = +from.value, last = +to.value;
      if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last < first || last > pageCount || last - first >= 30) {
        status.textContent = 'Choose a valid range of up to 30 pages.'; return;
      }
      button.disabled = from.disabled = to.disabled = true;
      let score;
      try {
        async function recognize(body, n) {
          signal.throwIfAborted();
          status.textContent = 'Recognizing ' + (pdf ? 'page ' + n + ' of ' + pageCount : 'score') + '…';
          body.parts = score ? [...score.querySelectorAll('part-list > score-part')].map(p => p.id + ': ' + p.querySelector('part-name')?.textContent).join(', ') : '';
          score = appendPage(score, await streamAI(body, () => {}, signal));
          progress.value = (n - first + 1) / (last - first + 1);
        }
        if (abc !== undefined) await recognize({ mode: 'xml-abc', text: abc }, 1);
        else if (pdf) {
          for await (const pg of pdfPages({ data: new Uint8Array(await source.arrayBuffer()) }, first, last)) {
            await recognize({ mode: 'xml-page', images: canvasToParts(pg.canvas) }, pg.page);
          }
        } else await recognize({ mode: 'xml-page', images: canvasToParts(await imageCanvas(source)) }, 1);
        signal.throwIfAborted();
        const content = new XMLSerializer().serializeToString(score);
        if (abc !== undefined) download(content, safeName(meta.title) + '.musicxml', 'application/vnd.recordare.musicxml+xml');
        else {
          status.textContent = 'Saving MusicXML…';
          result = await api('scores/' + meta.id, { method: 'PUT', body: { type: 'musicxml', content } });
        }
        dialog.close();
      } catch (e) {
        if (signal.aborted) return;
        status.textContent = e.message;
        progress.value = 0;
        button.disabled = from.disabled = to.disabled = false;
        button.textContent = 'Try again';
      }
    }
  });
}
