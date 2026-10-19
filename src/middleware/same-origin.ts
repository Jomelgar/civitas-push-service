import type { Context, Next } from 'hono';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function requireSameOrigin(c: Context, next: Next): Promise<Response | void> {
  if (!MUTATING_METHODS.has(c.req.method)) return next();

  const site = c.req.header('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'same-site') {
    return c.json({ ok: false, error: 'forbidden_origin' }, 403);
  }

  const origin = c.req.header('origin');
  if (origin === 'null') {
    if (site === 'same-origin') return next();
    return c.json({ ok: false, error: 'forbidden_origin' }, 403);
  }
  if (origin) {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return c.json({ ok: false, error: 'forbidden_origin' }, 403);
    }
    if (originHost !== c.req.header('host')) {
      return c.json({ ok: false, error: 'forbidden_origin' }, 403);
    }
  }

  await next();
}
