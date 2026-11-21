// ScoreNest API — Cloudflare Pages Function (catch-all for /api/*)
// Storage: R2 bucket bound as SCORES.
//
// Object layout in R2
//   meta/{id}                 JSON metadata for a score (also mirrored in customMetadata.m)
//   scores/{id}/content       the score itself (ABC text, MusicXML text, or .mxl binary)
//   scores/{id}/source        original uploaded PDF / image used for transcription
//   scores/{id}/thumb.svg     preview image for the library
//   scores/{id}/v/{timestamp} saved versions (history)
//   folders.json              list of folders

const TEXT_TYPES = new Set(['abc', 'musicxml']);
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const SESSION_DAYS = 30;
const SNAPSHOT_EVERY_MS = 15 * 60 * 1000;
const MAX_VERSIONS = 50;

const CONTENT_TYPES = {
  abc: 'text/vnd.abc; charset=utf-8',
  musicxml: 'application/vnd.recordare.musicxml+xml; charset=utf-8',
  mxl: 'application/vnd.recordare.musicxml',
};

// ---------- helpers ----------
const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...extra } });
const err = (message, status = 400) => json({ error: message }, status);

function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('');
}
const validId = (id) => typeof id === 'string' && /^[a-z0-9]{6,32}$/.test(id);
const clip = (s, n) => (typeof s === 'string' ? s.slice(0, n) : '');

async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}

// ---------- auth (optional shared password) ----------
async function hmac(secret, message) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' }[c]));
}
const authRequired = (env) => !!env.APP_PASSWORD;
const sessionSecret = (env) => env.SESSION_SECRET || `scorenest:${env.APP_PASSWORD}`;

function getCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

async function isAuthenticated(request, env) {
  if (!authRequired(env)) return true;
  const token = getCookie(request, 'sn_session');
  if (!token) return false;
  const [exp, sig] = token.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return (await hmac(sessionSecret(env), exp)) === sig;
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ---------- metadata ----------
async function getMeta(env, id) {
  const obj = await env.SCORES.get(`meta/${id}`);
  return obj ? obj.json() : null;
}

async function putMeta(env, meta) {
  const body = JSON.stringify(meta);
  await env.SCORES.put(`meta/${meta.id}`, body, {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { m: body.length < 1900 ? body : JSON.stringify({ id: meta.id, title: meta.title, type: meta.type, updated: meta.updated }) },
  });
  return meta;
}

async function listMetas(env) {
  const out = [];
  let cursor;
  do {
    const page = await env.SCORES.list({ prefix: 'meta/', include: ['customMetadata'], cursor, limit: 1000 });
    for (const obj of page.objects) {
      let meta = null;
      try { meta = JSON.parse(obj.customMetadata?.m || 'null'); } catch { /* fallthrough */ }
      if (!meta || meta.created === undefined) meta = await getMeta(env, obj.key.slice(5)); // fallback: full read
      if (meta) out.push(meta);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out.sort((a, b) => (b.updated || 0) - (a.updated || 0));
}

async function deletePrefix(env, prefix) {
  let cursor;
  do {
    const page = await env.SCORES.list({ prefix, cursor, limit: 1000 });
    const keys = page.objects.map((o) => o.key);
    if (keys.length) await env.SCORES.delete(keys);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

async function saveVersion(env, meta, content) {
  const ts = Date.now();
  await env.SCORES.put(`scores/${meta.id}/v/${ts}`, content, {
    customMetadata: { title: meta.title || '' },
  });
  meta.lastSnap = ts;
  // prune old versions
  const page = await env.SCORES.list({ prefix: `scores/${meta.id}/v/`, limit: 1000 });
  const keys = page.objects.map((o) => o.key).sort();
  if (keys.length > MAX_VERSIONS) await env.SCORES.delete(keys.slice(0, keys.length - MAX_VERSIONS));
}

const publicMeta = (m) => ({ id: m.id, title: m.title, composer: m.composer, type: m.type, updated: m.updated });

// ---------- folders ----------
async function getFolders(env) {
  const obj = await env.SCORES.get('folders.json');
  return obj ? obj.json() : [];
}
async function putFolders(env, folders) {
  await env.SCORES.put('folders.json', JSON.stringify(folders), { httpMetadata: { contentType: 'application/json' } });
  return folders;
}

// ---------- AI transcription (Claude vision) ----------
const ABC_RULES = `Output rules:
- Output ONLY valid ABC notation (standard 2.1). No commentary, no markdown, no code fences.
- Be faithful to the page: pitches, rhythms, rests, ties, slurs, accidentals, key and time signature changes, repeats and voltas, dynamics (!p! !f! etc.), fermatas, tempo text, chord symbols in quotes.
- Multiple staves or parts (e.g. SATB, piano): declare each with V: lines (with name= and clef=) and add a %%score line; write the music bar-aligned per voice, a few bars per line, labelled with [V:...].
- Lyrics: put them under the notes with w: lines, hyphenating syllables.
- Use one line of music per system where practical and end every bar with |.
- If something is unreadable, make the most musically plausible choice rather than leaving gaps.`;

function buildTranscribePrompt(body) {
  const mode = body.mode;
  if (mode === 'convert') {
    return [{ type: 'text', text: `Convert this MusicXML score into equivalent ABC notation.\n${ABC_RULES}\n\nMusicXML:\n${clip(body.text, 400000)}` }];
  }
  const images = (Array.isArray(body.images) ? body.images : []).slice(0, 4).map((img) => ({
    type: 'image',
    source: { type: 'base64', media_type: /^image\/(png|jpeg|webp|gif)$/.test(img.media_type) ? img.media_type : 'image/jpeg', data: img.data },
  }));
  const hint = body.hint ? `\nNotes from the user about this score: ${clip(body.hint, 500)}` : '';
  let text;
  if (mode === 'continue') {
    text = `These images are page ${body.page} (of ${body.pages}) of a score you are already transcribing. The ABC header and voice definitions already written are:\n\n${clip(body.header, 4000)}\n\nThe last lines transcribed so far were:\n${clip(body.tail, 2000)}\n\nContinue the transcription with the music on this page ONLY. Do NOT repeat the header (no X:, T:, M:, K: or V: definitions), but do use [V:...] markers for each voice exactly as defined, and inline [M:] / [K:] fields for any changes.${hint}\n${ABC_RULES}`;
  } else {
    text = `Transcribe this sheet music (page ${body.page || 1} of ${body.pages || 1}) into ABC notation. Start with a full header: X:1, T: (title from the page${body.title ? `, or "${clip(body.title, 120)}"` : ''}), C: (composer/arranger if shown), M:, L:, Q: (if shown), voice definitions, and K: last.${hint}\n${ABC_RULES}`;
  }
  return [...images, { type: 'text', text }];
}

async function transcribe(request, env) {
  if (!env.ANTHROPIC_API_KEY) return err('AI transcription is not configured. Add the ANTHROPIC_API_KEY secret in Cloudflare.', 501);
  const body = await readJson(request);
  const content = buildTranscribePrompt(body);
  if (body.mode !== 'convert' && !content.some((c) => c.type === 'image')) return err('No page images received');

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: env.CLAUDE_MODEL || 'claude-sonnet-5-5',
      max_tokens: 16000,
      stream: true,
      system: 'You are an expert music engraver and optical music recognition system. You read printed or handwritten sheet music and write it out precisely in ABC notation.',
      messages: [{ role: 'user', content }],
    }),
  });
  if (!upstream.ok) {
    const detail = await upstream.text();
    return err(`AI service error (${upstream.status}): ${detail.slice(0, 400)}`, 502);
  }
  // Stream the server-sent events straight through to the browser so the user sees notes appear live.
  return new Response(upstream.body, {
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' },
  });
}

// ---------- raw object responses ----------
function objectResponse(obj, fallbackType, extra = {}) {
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  if (!headers.get('content-type')) headers.set('content-type', fallbackType || 'application/octet-stream');
  headers.set('etag', obj.httpEtag);
  headers.set('cache-control', 'no-store');
  headers.set('x-content-type-options', 'nosniff');
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(obj.body, { headers });
}
const SVG_SAFE = { 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:" };

// ---------- router ----------
export async function onRequest(context) {
  const { request, env } = context;
  if (!env.SCORES) return err('R2 bucket binding "SCORES" is missing. See README.', 500);

  const url = new URL(request.url);
  const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const method = request.method;
  const [root, id, sub, subId] = parts;

  try {
    // ----- open routes -----
    if (root === 'session' && method === 'GET') {
      return json({ authRequired: authRequired(env), authenticated: await isAuthenticated(request, env), aiEnabled: !!env.ANTHROPIC_API_KEY });
    }
    if (root === 'login' && method === 'POST') {
      if (!authRequired(env)) return json({ ok: true });
      const { password } = await readJson(request);
      if (!safeEqual(String(password || ''), env.APP_PASSWORD)) return err('Wrong password', 401);
      const exp = String(Date.now() + SESSION_DAYS * 864e5);
      const token = `${exp}.${await hmac(sessionSecret(env), exp)}`;
      return json({ ok: true }, 200, { 'set-cookie': `sn_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}` });
    }
    if (root === 'logout' && method === 'POST') {
      return json({ ok: true }, 200, { 'set-cookie': 'sn_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0' });
    }
    if (root === 'public') {
      if (!validId(id)) return err('Not found', 404);
      const meta = await getMeta(env, id);
      if (!meta || !meta.public || meta.trashed) return err('This score is not shared', 404);
      if (!sub && method === 'GET') {
        let content = null;
        if (TEXT_TYPES.has(meta.type)) { const o = await env.SCORES.get(`scores/${id}/content`); content = o ? await o.text() : ''; }
        return json({ meta: publicMeta(meta), content });
      }
      if (sub === 'file' && method === 'GET') {
        const o = await env.SCORES.get(`scores/${id}/content`);
        return o ? objectResponse(o, CONTENT_TYPES[meta.type]) : err('Not found', 404);
      }
      return err('Not found', 404);
    }

    // ----- everything else needs a session -----
    if (!(await isAuthenticated(request, env))) return err('Please sign in', 401);

    if (root === 'transcribe' && method === 'POST') return transcribe(request, env);

    // ----- folders -----
    if (root === 'folders') {
      const folders = await getFolders(env);
      if (!id && method === 'GET') return json(folders);
      if (!id && method === 'POST') {
        const { name } = await readJson(request);
        if (!name || !String(name).trim()) return err('Folder name required');
        const folder = { id: newId(), name: clip(String(name).trim(), 80), created: Date.now() };
        await putFolders(env, [...folders, folder]);
        return json(folder, 201);
      }
      const folder = folders.find((f) => f.id === id);
      if (!folder) return err('Folder not found', 404);
      if (method === 'PATCH') {
        const { name } = await readJson(request);
        if (name && String(name).trim()) folder.name = clip(String(name).trim(), 80);
        await putFolders(env, folders);
        return json(folder);
      }
      if (method === 'DELETE') {
        await putFolders(env, folders.filter((f) => f.id !== id));
        const metas = await listMetas(env);
        await Promise.all(metas.filter((m) => m.folder === id).map((m) => putMeta(env, { ...m, folder: null })));
        return json({ ok: true });
      }
      return err('Method not allowed', 405);
    }

    // ----- scores -----
    if (root !== 'scores') return err('Not found', 404);

    if (!id) {
      if (method === 'GET') return json(await listMetas(env));
      if (method === 'POST') {
        const body = await readJson(request);
        const type = ['abc', 'musicxml', 'mxl', 'pdf', 'image'].includes(body.type) ? body.type : 'abc';
        const now = Date.now();
        const meta = {
          id: newId(), title: clip(body.title || 'Untitled score', 200), composer: clip(body.composer || '', 120),
          type, folder: body.folder || null, created: now, updated: now,
          starred: false, trashed: false, public: false, source: null, transcribed: !!body.transcribed, lastSnap: 0,
        };
        if (TEXT_TYPES.has(type)) {
          const content = typeof body.content === 'string' ? body.content : '';
          await env.SCORES.put(`scores/${meta.id}/content`, content, { httpMetadata: { contentType: CONTENT_TYPES[type] } });
          meta.size = content.length;
        }
        await putMeta(env, meta);
        return json(meta, 201);
      }
      return err('Method not allowed', 405);
    }

    if (!validId(id)) return err('Not found', 404);
    const meta = await getMeta(env, id);
    if (!meta) return err('Score not found', 404);

    if (!sub) {
      if (method === 'GET') {
        let content = null;
        if (TEXT_TYPES.has(meta.type)) { const o = await env.SCORES.get(`scores/${id}/content`); content = o ? await o.text() : ''; }
        return json({ meta, content });
      }
      if (method === 'PUT' || method === 'PATCH') {
        const body = await readJson(request);
        for (const k of ['title', 'composer']) if (typeof body[k] === 'string') meta[k] = clip(body[k], k === 'title' ? 200 : 120);
        for (const k of ['starred', 'trashed', 'public']) if (typeof body[k] === 'boolean') meta[k] = body[k];
        if ('folder' in body) meta.folder = body.folder || null;
        if (body.trashed === true) meta.trashedAt = Date.now();
        // A stored PDF / image / MusicXML score can be turned into an editable ABC score (after AI transcription)
        if (body.type === 'abc' && meta.type !== 'abc' && typeof body.content === 'string') {
          if (meta.type === 'musicxml' || meta.type === 'mxl') await env.SCORES.delete(`scores/${id}/content`);
          meta.type = 'abc'; meta.transcribed = true; meta.lastSnap = 0;
        }
        if (typeof body.content === 'string' && TEXT_TYPES.has(meta.type)) {
          await env.SCORES.put(`scores/${id}/content`, body.content, { httpMetadata: { contentType: CONTENT_TYPES[meta.type] } });
          meta.size = body.content.length;
          if (body.snapshot || Date.now() - (meta.lastSnap || 0) > SNAPSHOT_EVERY_MS) await saveVersion(env, meta, body.content);
        }
        if (typeof body.content === 'string' || body.touch) meta.updated = Date.now();
        await putMeta(env, meta);
        return json(meta);
      }
      if (method === 'DELETE') {
        await deletePrefix(env, `scores/${id}/`);
        await env.SCORES.delete(`meta/${id}`);
        return json({ ok: true });
      }
      return err('Method not allowed', 405);
    }

    if (sub === 'duplicate' && method === 'POST') {
      const now = Date.now();
      const copy = { ...meta, id: newId(), title: `${meta.title} (copy)`, created: now, updated: now, public: false, starred: false, lastSnap: 0 };
      for (const key of ['content', 'source', 'thumb.svg']) {
        const o = await env.SCORES.get(`scores/${id}/${key}`);
        if (o) await env.SCORES.put(`scores/${copy.id}/${key}`, o.body, { httpMetadata: o.httpMetadata, customMetadata: o.customMetadata });
      }
      await putMeta(env, copy);
      return json(copy, 201);
    }

    if (sub === 'file') {
      if (method === 'GET') {
        const o = await env.SCORES.get(`scores/${id}/content`);
        return o ? objectResponse(o, CONTENT_TYPES[meta.type]) : err('Not found', 404);
      }
      if (method === 'PUT') {
        const data = await request.arrayBuffer();
        await env.SCORES.put(`scores/${id}/content`, data, { httpMetadata: { contentType: CONTENT_TYPES[meta.type] } });
        meta.size = data.byteLength; meta.updated = Date.now();
        await putMeta(env, meta);
        return json(meta);
      }
    }

    if (sub === 'source') {
      if (method === 'GET') {
        const o = await env.SCORES.get(`scores/${id}/source`);
        if (!o) return err('No source file', 404);
        const name = (meta.source || 'source').replace(/["\\\r\n]/g, '');
        const inline = /^(application\/pdf|image\/(png|jpeg|webp|gif))/.test(o.httpMetadata?.contentType || '');
        return objectResponse(o, 'application/octet-stream', {
          'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${name}"`,
        });
      }
      if (method === 'PUT') {
        const ct = request.headers.get('content-type') || 'application/octet-stream';
        const name = clip(decodeURIComponent(request.headers.get('x-filename') || 'source'), 200);
        await env.SCORES.put(`scores/${id}/source`, request.body, { httpMetadata: { contentType: ct } });
        meta.source = name; meta.sourceType = ct;
        await putMeta(env, meta);
        return json(meta);
      }
    }

    if (sub === 'thumb') {
      if (method === 'GET') {
        const o = await env.SCORES.get(`scores/${id}/thumb.svg`);
        return o ? objectResponse(o, 'image/svg+xml', SVG_SAFE) : err('No thumbnail', 404);
      }
      if (method === 'PUT') {
        const svg = await request.text();
        if (svg.length > 600000 || !svg.trimStart().startsWith('<svg') || /<script|<foreignobject|\son[a-z]+\s*=|javascript:/i.test(svg)) return err('Invalid thumbnail');
        await env.SCORES.put(`scores/${id}/thumb.svg`, svg, { httpMetadata: { contentType: 'image/svg+xml' } });
        if (!meta.thumb) { meta.thumb = true; await putMeta(env, meta); }
        return json({ ok: true });
      }
    }

    if (sub === 'versions') {
      if (!subId && method === 'GET') {
        const page = await env.SCORES.list({ prefix: `scores/${id}/v/`, limit: 1000 });
        return json(page.objects.map((o) => ({ id: o.key.split('/').pop(), size: o.size, at: Number(o.key.split('/').pop()) })).sort((a, b) => b.at - a.at));
      }
      if (subId && method === 'GET') {
        if (!/^\d+$/.test(subId)) return err('Not found', 404);
        const o = await env.SCORES.get(`scores/${id}/v/${subId}`);
        return o ? json({ content: await o.text(), at: Number(subId) }) : err('Version not found', 404);
      }
    }

    return err('Not found', 404);
  } catch (e) {
    return err(`Server error: ${e.message}`, 500);
  }
}
