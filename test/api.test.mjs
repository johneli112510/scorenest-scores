import { onRequest } from '../functions/api/[[route]].js';
import { MockR2 } from './mock-r2.mjs';
import assert from 'node:assert/strict';

const env = { SCORES: new MockR2(), APP_PASSWORD: 'secret', GEMINI_API_KEY: 'k' };
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
const noAi = env.GEMINI_API_KEY; delete env.GEMINI_API_KEY;
r = await call('POST', 'transcribe', { mode: 'first', images: [{ data: 'x', media_type: 'image/jpeg' }] }); assert.equal(r.status, 501);
env.GEMINI_API_KEY = noAi;

// transcribe passes stream through (mock Gemini)
const realFetch = globalThis.fetch;
let sent;
const event = text => 'data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] }) + '\n\n';
globalThis.fetch = async (url, init) => {
  sent = { url, body: JSON.parse(init.body), headers: init.headers };
  return new Response(event('X:1'), { headers: { 'content-type': 'text/event-stream' } });
};
r = await call('POST', 'transcribe', { mode: 'continue', page: 2, pages: 3, header: 'X:1\nK:C', tail: 'CDEF|', images: [{ data: 'abc', media_type: 'image/jpeg' }] });
globalThis.fetch = realFetch;
assert.equal(r.status, 200); assert.match(r.data, /X:1/);
assert.equal(sent.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse');
assert.equal(sent.body.contents[0].parts[0].inlineData.mimeType, 'image/jpeg');
assert.match(sent.body.contents[0].parts[1].text, /page 2/);
assert.equal(sent.headers['x-goog-api-key'], 'k');

// recordings
const audio = new Uint8Array(1000).map((_, i) => i % 256);
r = await call('POST', `scores/${id}/recordings`, audio, { 'content-type': 'audio/mpeg', 'x-filename': encodeURIComponent('Full choir.mp3') });
assert.equal(r.status, 201); const rid = r.data.id; assert.equal(r.data.name, 'Full choir'); assert.equal(r.data.size, 1000);
r = await call('POST', `scores/${id}/recordings`, new Uint8Array([1]), { 'content-type': 'application/pdf' }); assert.equal(r.status, 400);
r = await call('POST', `scores/${id}/recordings`, { youtube: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10', name: 'Live' }); assert.equal(r.data.youtube, 'dQw4w9WgXcQ');
r = await call('POST', `scores/${id}/recordings`, { youtube: 'https://youtu.be/abc' }); assert.equal(r.status, 400);
r = await call('GET', `scores/${id}/recordings/${rid}/file`, undefined, { range: 'bytes=10-19' });
assert.equal(r.status, 206); assert.equal(r.headers.get('content-range'), 'bytes 10-19/1000'); assert.equal(r.headers.get('content-length'), '10');
r = await call('GET', `scores/${id}/recordings/${rid}/file`); assert.equal(r.status, 200); assert.equal(r.headers.get('accept-ranges'), 'bytes');
r = await call('GET', `scores/${id}/recordings/${rid}/file`, undefined, { range: 'bytes=5000-' }); assert.equal(r.status, 416);
r = await call('PATCH', `scores/${id}/recordings/${rid}`, { sync: { anchors: [{ bar: 0, t: 1.2345 }, { bar: 4, t: 9.5 }, { bar: -1, t: 3 }, { bar: 2, t: 'x' }] } });
assert.deepEqual(r.data.sync.anchors, [{ bar: 0, t: 1.235 }, { bar: 4, t: 9.5 }]);
r = await call('GET', 'scores'); assert.equal(r.data.find((s) => s.id === id).recCount, 2);
{ const saved2 = cookie; cookie = '';
  r = await call('GET', `public/${id}/recordings`); assert.equal(r.data.length, 2); assert.equal(r.data[0].size, undefined);
  r = await call('GET', `public/${id}/recordings/${rid}`, undefined, { range: 'bytes=0-1' }); assert.equal(r.status, 206);
  cookie = saved2; }
r = await call('POST', `scores/${id}/duplicate`); const copyId = r.data.id;
r = await call('GET', `scores/${copyId}/recordings`); assert.equal(r.data.length, 2);
r = await call('GET', `scores/${copyId}/recordings/${rid}/file`); assert.equal(r.status, 200);
r = await call('DELETE', `scores/${id}/recordings/${rid}`); assert.equal(r.status, 200);
r = await call('GET', `scores/${id}/recordings`); assert.equal(r.data.length, 1);

// trash + delete
await call('PUT', `scores/${dup}`, { trashed: true });
r = await call('GET', 'scores'); assert.equal(r.data.find((s) => s.id === dup).trashed, true);
r = await call('DELETE', `scores/${dup}`); assert.equal(r.status, 200);
assert.equal([...env.SCORES.store.keys()].filter((k) => k.includes(dup)).length, 0);

// open mode (no password)
delete env.APP_PASSWORD; cookie = '';
r = await call('GET', 'scores'); assert.equal(r.status, 200);
r = await call('GET', 'scores/../meta'); assert.equal(r.status, 404);

// MusicXML conversion retains the source and serves the resulting XML as a score.
const scan = await call('POST', 'scores', { type: 'pdf', title: 'Duet' });
const scanUrl = 'scores/' + scan.data.id;
await call('PUT', scanUrl + '/source', '%PDF-fixture', { 'content-type': 'application/pdf', 'x-filename': 'duet.pdf' });
const xml = '<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1"><measure number="1"><note><rest/><duration>1</duration></note></measure></part></score-partwise>';
const converted = await call('PUT', scanUrl, { type: 'musicxml', content: xml });
assert.equal(converted.data.source, 'duet.pdf');
assert.equal(converted.data.type, 'musicxml');
assert.equal((await call('GET', scanUrl + '/file')).data, xml);
assert.equal((await call('GET', scanUrl + '/source')).data, '%PDF-fixture');

// Exercise the recognition request with a simulated model response.
try {
  globalThis.fetch = async (_url, request) => {
    const prompt = JSON.parse(request.body);
    assert.match(prompt.systemInstruction.parts[0].text, /MusicXML/);
    assert.equal(prompt.contents[0].parts[0].inlineData.data, 'fixture');
    assert.match(prompt.contents[0].parts.at(-1).text, /P1: Piano/);
    return new Response(event(xml));
  };
  const response = await call('POST', 'transcribe', { mode: 'xml-page', images: [{ data: 'fixture', media_type: 'image/jpeg' }], parts: 'P1: Piano' });
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.data.slice(6)).candidates[0].content.parts[0].text, xml);
} finally {
  globalThis.fetch = realFetch;
}
// Exercise all conversion modes through the Worker and the browser's stream reader.
const { streamAI } = await import('../public/js/transcribe.js');
const modes = ['first', 'continue', 'convert', 'xml-abc', 'xml-page'];
try {
  for (const mode of modes) {
    const input = ['convert', 'xml-abc'].includes(mode) ? { text: 'score fixture' } : { images: [{ media_type: 'image/png', data: 'fixture' }] };
    globalThis.fetch = async (url, init) => {
      if (url === '/api/transcribe') {
        return onRequest({ request: new Request('https://x.test/api/transcribe', init), env });
      }
      const body = JSON.parse(init.body);
      assert.equal(body.contents[0].parts.some(p => !!p.inlineData), !!input.images);
      assert.match(body.systemInstruction.parts[0].text, mode.startsWith('xml-') ? /MusicXML/ : /ABC/);
      const thought = JSON.stringify({ candidates: [{ content: { parts: [{ thought: true, text: 'hidden' }, { text: 'a' }] } }] });
      const payload = 'data: ' + thought + '\r\n\r\n' + event('b');
      return new Response(new ReadableStream({ start(controller) {
        const bytes = new TextEncoder().encode(payload);
        controller.enqueue(bytes.slice(0, 15)); controller.enqueue(bytes.slice(15)); controller.close();
      } }));
    };
    assert.equal(await streamAI({ mode, ...input }, () => {}), 'ab');
  }
  globalThis.fetch = async () => new Response('data: {"candidates":[{"finishReason":"MAX_TOKENS"}]}\n\n');
  await assert.rejects(streamAI({}, () => {}), /recognition limit/);
  globalThis.fetch = async () => new Response('data: {"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}\n\n');
  await assert.rejects(streamAI({}, () => {}), /incomplete/);
} finally { globalThis.fetch = realFetch; }
console.log('API: all tests passed');
