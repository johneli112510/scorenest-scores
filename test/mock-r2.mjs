// Minimal in-memory R2 bucket for tests
export class MockR2 {
  constructor() { this.store = new Map(); }
  async put(key, value, opts = {}) {
    let bytes;
    if (typeof value === 'string') bytes = new TextEncoder().encode(value);
    else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
    else if (value instanceof Uint8Array) bytes = value;
    else if (value && typeof value.getReader === 'function') bytes = new Uint8Array(await new Response(value).arrayBuffer());
    else if (value == null) bytes = new Uint8Array();
    else throw new Error('unsupported put value');
    this.store.set(key, { bytes, httpMetadata: opts.httpMetadata || {}, customMetadata: opts.customMetadata || {} });
  }
  async get(key) {
    const o = this.store.get(key); if (!o) return null;
    const bytes = o.bytes;
    return {
      key, size: bytes.length, httpMetadata: o.httpMetadata, customMetadata: o.customMetadata, httpEtag: '"e"',
      get body() { return new Response(bytes).body; },
      text: async () => new TextDecoder().decode(bytes), json: async () => JSON.parse(new TextDecoder().decode(bytes)),
      arrayBuffer: async () => bytes.buffer,
      writeHttpMetadata(h) { if (o.httpMetadata.contentType) h.set('content-type', o.httpMetadata.contentType); },
    };
  }
  async list({ prefix = '', cursor, limit = 1000, include = [] } = {}) {
    const keys = [...this.store.keys()].filter((k) => k.startsWith(prefix)).sort();
    const start = cursor ? Number(cursor) : 0;
    const slice = keys.slice(start, start + limit);
    return { objects: slice.map((k) => ({ key: k, size: this.store.get(k).bytes.length, customMetadata: include.includes('customMetadata') ? this.store.get(k).customMetadata : undefined })),
      truncated: start + limit < keys.length, cursor: String(start + limit) };
  }
  async delete(keys) { for (const k of [].concat(keys)) this.store.delete(k); }
}
