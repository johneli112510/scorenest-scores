import { onRequest } from '../functions/api/[[route]].js';
import { MockR2 } from './mock-r2.mjs';
import assert from 'node:assert/strict';

const env = { SCORES: new MockR2(), APP_PASSWORD: 'secret', ANTHROPIC_API_KEY: 'k' };
let cookie = '';
async function call(method, path, body, headers = {}) {
  const init = { method, headers: { ...headers, cookie } };
  if (body !== undefined) { init.body = typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body); if (typeof body === 'object' && !(body instanceof Uint8Array)) init.headers['content-type'] = 'application/json'; init.duplex = 'half'; }
  const res = await onRequest({ request: new Request(`https://x.test/api/${path}`, init), env });
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, data: ct.includes('json') ? await res.json() : await res.text(), headers: res.headers };
}

let r = await call('GET', 'session'); assert.equal(r.data.authRequired, true); assert.equal(r.data.authenticated, false);
r = await call('GET', 'scores'); assert.equal(r.status, 401);
r = await call('POST', 'login', { password: 'nope' }); assert.equal(r.status, 401);
r = await call('POST', 'login', { password: 'secret' }); assert.equal(r.status, 200); assert.ok(cookie.startsWith('sn_session='));
r = await call('GET', 'session'); assert.equal(r.data.authenticated, true); assert.equal(r.data.aiEnabled, true);

// create + read + update
r = await call('POST', 'scores', { title: 'Ave Maria', composer: 'Schubert', type: 'abc', content: 'X:1\nT:Ave\nK:C\nCDEF|' });
assert.equal(r.status, 201); const id = r.data.id;
r = await call('GET', `scores/${id}`); assert.equal(r.data.content, 'X:1\nT:Ave\nK:C\nCDEF|'); assert.equal(r.data.meta.composer, 'Schubert');
r = await call('PUT', `scores/${id}`, { content: 'X:1\nK:C\nGABc|', snapshot: true }); assert.equal(r.status, 200);
r = await call('GET', `scores/${id}/versions`); assert.equal(r.data.length, 1);
r = await call('GET', `scores/${id}/versions/${r.data[0].id}`); assert.equal(r.data.content, 'X:1\nK:C\nGABc|');
r = await call('PUT', `scores/${id}`, { starred: true, title: 'Ave Maria (SATB)' }); assert.equal(r.data.starred, true);
r = await call('GET', 'scores'); assert.equal(r.data.length, 1); assert.equal(r.data[0].title, 'Ave Maria (SATB)'); assert.equal(r.data[0].starred, true);

// folders
r = await call('POST', 'folders', { name: 'Christmas' }); const fid = r.data.id;
await call('PUT', `scores/${id}`, { folder: fid });
r = await call('GET', 'scores'); assert.equal(r.data[0].folder, fid);
await call('DELETE', `folders/${fid}`);
r = await call('GET', 'scores'); assert.equal(r.data[0].folder, null);

// thumbnails
r = await call('PUT', `scores/${id}/thumb`, '<svg xmlns="http://www.w3.org/2000/svg"><rect onload="x"/></svg>'); assert.equal(r.status, 400);
r = await call('PUT', `scores/${id}/thumb`, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path class="abcjs-note" d="M0 0"/></svg>'); assert.equal(r.status, 200);
r = await call('GET', `scores/${id}/thumb`); assert.match(r.headers.get('content-type'), /svg/); assert.ok(r.headers.get('content-security-policy'));

// pdf score -> source -> convert to abc
r = await call('POST', 'scores', { title: 'Scan', type: 'pdf' }); const pid = r.data.id;
r = await call('PUT', `scores/${pid}/source`, new Uint8Array([37, 80, 68, 70]), { 'content-type': 'application/pdf', 'x-filename': encodeURIComponent('My scan.pdf') });
assert.equal(r.data.source, 'My scan.pdf');
r = await call('GET', `scores/${pid}/source`); assert.equal(r.data, '%PDF'); assert.match(r.headers.get('content-disposition'), /inline/);
r = await call('PUT', `scores/${pid}`, { type: 'abc', content: 'X:1\nK:G\nGAB|', snapshot: true }); assert.equal(r.data.type, 'abc'); assert.equal(r.data.transcribed, true);
r = await call('GET', `scores/${pid}`); assert.equal(r.data.content, 'X:1\nK:G\nGAB|');

// duplicate
r = await call('POST', `scores/${pid}/duplicate`); assert.equal(r.status, 201); const dup = r.data.id;
r = await call('GET', `scores/${dup}/source`); assert.equal(r.data, '%PDF');

// mxl upload
r = await call('POST', 'scores', { title: 'Zipped', type: 'mxl' }); const mid = r.data.id;
r = await call('PUT', `scores/${mid}/file`, new Uint8Array([80, 75, 3, 4]), { 'content-type': 'application/octet-stream' }); assert.equal(r.data.size, 4);
r = await call('GET', `scores/${mid}`); assert.equal(r.data.content, null);

// sharing
r = await call('GET', `public/${id}`); assert.equal(r.status, 404);
await call('PUT', `scores/${id}`, { public: true });
const saved = cookie; cookie = '';
r = await call('GET', `public/${id}`); assert.equal(r.status, 200); assert.equal(r.data.content, 'X:1\nK:C\nGABc|'); assert.equal(r.data.meta.starred, undefined);
r = await call('GET', `scores/${id}`); assert.equal(r.status, 401);
cookie = saved;

// transcribe validation (no network call when no images)
r = await call('POST', 'transcribe', { mode: 'first', images: [] }); assert.equal(r.status, 400);
const noAi = env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_API_KEY;
r = await call('POST', 'transcribe', { mode: 'first', images: [{ data: 'x', media_type: 'image/jpeg' }] }); assert.equal(r.status, 501);
env.ANTHROPIC_API_KEY = noAi;

// transcribe passes stream through (mock Anthropic)
const realFetch = globalThis.fetch;
let sent;
globalThis.fetch = async (url, init) => { sent = { url, body: JSON.parse(init.body), headers: init.headers }; return new Response('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"X:1"}}\n\n', { headers: { 'content-type': 'text/event-stream' } }); };
r = await call('POST', 'transcribe', { mode: 'continue', page: 2, pages: 3, header: 'X:1\nK:C', tail: 'CDEF|', images: [{ data: 'abc', media_type: 'image/jpeg' }] });
globalThis.fetch = realFetch;
assert.equal(r.status, 200); assert.match(r.data, /text_delta/);
assert.equal(sent.url, 'https://api.anthropic.com/v1/messages'); assert.equal(sent.body.stream, true); assert.equal(sent.body.messages[0].content[0].type, 'image');
assert.match(sent.body.messages[0].content[1].text, /page 2/); assert.equal(sent.headers['x-api-key'], 'k');

// trash + delete
await call('PUT', `scores/${dup}`, { trashed: true });
r = await call('GET', 'scores'); assert.equal(r.data.find((s) => s.id === dup).trashed, true);
r = await call('DELETE', `scores/${dup}`); assert.equal(r.status, 200);
assert.equal([...env.SCORES.store.keys()].filter((k) => k.includes(dup)).length, 0);

// open mode (no password)
delete env.APP_PASSWORD; cookie = '';
r = await call('GET', 'scores'); assert.equal(r.status, 200);
r = await call('GET', 'scores/../meta'); assert.equal(r.status, 404);
console.log('API: all tests passed');
