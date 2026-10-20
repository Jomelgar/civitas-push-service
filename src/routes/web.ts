import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';

import { config } from '../config';
import {
  createApiKey,
  deleteApiKey,
  getApiKey,
  listApiKeys,
  setApiKeyAllowedIps,
  setApiKeyEnabled,
  type ApiKeyRow,
} from '../db/api-keys';
import { listDevices } from '../db/repository';
import { noStore } from '../middleware/no-store';
import { requireSameOrigin } from '../middleware/same-origin';
import { SESSION_COOKIE, SESSION_MAX_AGE, createSessionValue, hasValidSession, requireWebAuth } from '../middleware/session';
import { generateApiKey, validIpEntry } from '../services/api-keys';
import { z } from 'zod';
import { notifySchema } from '../services/notifications';
import { runNotify } from '../services/dispatch';
import { pageSchema } from '../services/batches';
import { dashboardPage } from '../web/dashboard';
import { loginPage } from '../web/login';
import { queue } from '../queue/runtime';
import { publicJob, QueueError } from '../queue/store';

export const webRoutes = new Hono();

const allowedIpsSchema = z.union([z.string().max(4096), z.array(z.string().max(128)).max(100)])
  .transform(normalizeAllowedIps)
  .refine(value => !value || value.split(',').every(validIpEntry), 'Invalid IP or CIDR');
const createKeySchema = z.object({
  name: z.string().trim().min(1).max(128),
  allowedIps: allowedIpsSchema.optional(),
}).strict();
const updateKeySchema = z.object({
  enabled: z.boolean().optional(),
  allowedIps: allowedIpsSchema.optional(),
}).strict();

webRoutes.use('*', noStore);

function safeEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}

function serializeApiKey(row: ApiKeyRow) {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    enabled: row.enabled === 1,
    allowedIps: row.allowed_ips,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

function normalizeAllowedIps(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter(Boolean).join(',');
  }
  if (typeof value === 'string') {
    return value
      .split(/[,\n]/)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .join(',');
  }
  return '';
}

webRoutes.get('/login', (c) => {
  if (hasValidSession(c)) return c.redirect('/');
  return c.html(loginPage());
});

webRoutes.post(
  '/login',
  requireSameOrigin,
  async (c) => {
    const body = await c.req.parseBody();
    const user = String(body.user ?? '');
    const password = String(body.password ?? '');

    if (!safeEqual(user, config.adminUser) || !safeEqual(password, config.adminPassword)) {
      return c.html(loginPage('Usuario o contraseña incorrectos.'), 401);
    }

    setCookie(c, SESSION_COOKIE, createSessionValue(), {
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
      maxAge: SESSION_MAX_AGE,
      secure: config.isProduction,
    });
    return c.redirect('/');
  },
);

webRoutes.post('/logout', requireSameOrigin, (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.redirect('/login');
});

webRoutes.get('/api/devices', (c) => {
  const devices = listDevices().map((device) => ({
    deviceId: device.id,
    token: device.expo_token,
    platform: device.platform,
    enabled: device.enabled === 1,
    lastSeenAt: device.last_seen_at,
  }));
  return c.json({ ok: true, count: devices.length, devices });
});

webRoutes.post('/api/notify', async (c) => {
  const parsed = notifySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ ok: false, error: 'invalid_body', sent: 0, details: parsed.error.flatten() }, 400);
  }

  try {
    const result = await runNotify(parsed.data, 'admin', c.req.header('idempotency-key'));
    return c.json(result, result.sent === 0 ? 202 : 200);
  } catch (error) {
    if (error instanceof QueueError) {
      if (error.status === 503) c.header('Retry-After', String(Math.max(1, Math.ceil((error.retryAfterMs || 60_000) / 1000))));
      return c.json({ ok: false, error: error.code }, error.status);
    }
    throw error;
  }
});

webRoutes.get('/api/jobs', (c) => c.json({
  ok: true, jobs: queue.list().map(publicJob), counts: queue.stats(), ...queue.health(),
}));

webRoutes.get('/api/batches', (c) => {
  const page = pageSchema.safeParse(c.req.query());
  if (!page.success) return c.json({ ok: false, error: 'invalid_query' }, 400);
  const { limit, offset } = page.data;
  return c.json({ ok: true, batches: queue.batches(undefined, limit, offset), ...page.data, ...queue.health() });
});

webRoutes.get('/api/batches/:id', (c) => {
  const batch = queue.batch(c.req.param('id'));
  if (!batch) return c.json({ ok: false, error: 'not_found' }, 404);
  const page = pageSchema.safeParse(c.req.query());
  if (!page.success) return c.json({ ok: false, error: 'invalid_query' }, 400);
  return c.json({ ok: true, batch, jobs: queue.batchJobs(batch.id, page.data.limit, page.data.offset).map(publicJob), ...page.data });
});

webRoutes.get('/api/jobs/:id', (c) => {
  const job = queue.get(c.req.param('id'));
  return job ? c.json({ ok: true, job: publicJob(job) }) : c.json({ ok: false, error: 'not_found' }, 404);
});

webRoutes.post('/api/jobs/:id/retry', (c) => {
  try {
    return c.json({ ok: true, job: publicJob(queue.retry(c.req.param('id'))) }, 202);
  } catch (error) {
    if (error instanceof QueueError) return c.json({ ok: false, error: error.code }, error.status);
    throw error;
  }
});

webRoutes.get('/api/keys', (c) => {
  const keys = listApiKeys().map(serializeApiKey);
  return c.json({ ok: true, count: keys.length, keys });
});

webRoutes.post('/api/keys', async (c) => {
  const parsed = createKeySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
  const { name, allowedIps } = parsed.data;

  const { key, prefix, keyHash } = generateApiKey();
  const row = createApiKey({
    name,
    prefix,
    keyHash,
    allowedIps,
  });

  return c.json({ ok: true, key, apiKey: serializeApiKey(row) }, 201);
});

webRoutes.patch('/api/keys/:id', async (c) => {
  const id = c.req.param('id');
  const existing = getApiKey(id);
  if (!existing) return c.json({ ok: false, error: 'not_found' }, 404);

  const parsed = updateKeySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
  const body = parsed.data;

  if (typeof body.enabled === 'boolean') {
    setApiKeyEnabled(id, body.enabled);
  }
  if (body.allowedIps !== undefined) {
    setApiKeyAllowedIps(id, normalizeAllowedIps(body.allowedIps));
  }

  return c.json({ ok: true, apiKey: serializeApiKey(getApiKey(id) as ApiKeyRow) });
});

webRoutes.delete('/api/keys/:id', (c) => {
  const id = c.req.param('id');
  if (!getApiKey(id)) return c.json({ ok: false, error: 'not_found' }, 404);
  deleteApiKey(id);
  return c.json({ ok: true });
});

webRoutes.get('/', requireWebAuth, (c) => c.html(dashboardPage(config.adminUser)));
