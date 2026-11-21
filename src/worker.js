// Cloudflare Worker entry point.
// /api/* is handled by the API; everything else is served from the static files in /public.
import { onRequest } from '../functions/api/[[route]].js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return onRequest({ request, env, ctx });
    }
    return env.ASSETS.fetch(request);
  },
};
