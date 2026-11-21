import { api, h, modal, toast } from './lib.js';

export function shareModal(meta, onChange) {
  const link = `${location.origin}/#/s/${meta.id}`;
  const input = h('input', { class: 'input', value: link, readonly: true, onclick: (e) => e.target.select() });
  const linkRow = h('div', { class: `row ${meta.public ? '' : 'hidden'}` }, input,
    h('button', { class: 'btn', onclick: async () => { try { await navigator.clipboard.writeText(link); toast('Link copied', 'success'); } catch { input.select(); } } }, 'Copy'));
  const toggle = h('input', { type: 'checkbox', checked: !!meta.public });
  const note = h('p', { class: 'muted small' }, meta.public ? 'Anyone with the link can view, play and transpose this score. They cannot edit it.' : 'Only you (signed-in users) can see this score.');
  toggle.addEventListener('change', async () => {
    try {
      const m = await api(`scores/${meta.id}`, { method: 'PUT', body: { public: toggle.checked } });
      Object.assign(meta, m);
      linkRow.classList.toggle('hidden', !meta.public);
      note.textContent = meta.public ? 'Anyone with the link can view, play and transpose this score. They cannot edit it.' : 'Only you (signed-in users) can see this score.';
      onChange?.(meta);
    } catch (e) { toast(e.message, 'error'); toggle.checked = !toggle.checked; }
  });
  modal({
    title: `Share “${meta.title}”`,
    content: h('div', { class: 'stack' }, h('label', { class: 'switch-row' }, toggle, h('span', {}, 'Anyone with the link can view')), note, linkRow),
    actions: [{ label: 'Done', primary: true, onClick: (c) => c() }],
  });
}
