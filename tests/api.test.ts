import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';

const folder = mkdtempSync(join(tmpdir(), 'push-api-'));
process.env.DATABASE_PATH = join(folder, 'test.sqlite');
process.env.SESSION_SECRET = 'test-session-secret-at-least-32-characters';
process.env.API_KEY_PEPPER = 'test-api-pepper-at-least-32-characters';
process.env.ADMIN_PASSWORD = 'test-password-long-enough';
process.env.ADMIN_USER = 'admin';
process.env.TRUST_PROXY = 'false';
const { app } = await import('../src/app');
const { db } = await import('../src/db/client');
const { createApiKey } = await import('../src/db/api-keys');
const { generateApiKey, matchIpAllowlist } = await import('../src/services/api-keys');
const { createSessionValue, SESSION_COOKIE } = await import('../src/middleware/session');

function key(name: string) {
  const generated = generateApiKey();
  createApiKey({ name, prefix: generated.prefix, keyHash: generated.keyHash });
  return generated.key;
}
const firstKey = key('first');
const secondKey = key('second');
const input = { deviceId: 'api-device', token: 'ExponentPushToken[test-token]', message: 'Hello' };
const jobResponse = z.object({ job: z.object({ id: z.string().uuid(), status: z.string(), priority: z.enum(['default', 'normal', 'high']) }) });
const batchInput = { devices: [{ deviceId: 'batch-first', token: 'ExponentPushToken[first]' }, { deviceId: 'batch-second', token: 'ExponentPushToken[second]' }], message: 'Hello', name: 'Visitas', priority: 'high' };
const batchResponse = z.object({ batch: z.object({ id: z.string().uuid(), status: z.string(), total: z.number(), progress: z.number() }) });
const send = (body: unknown, apiKey = firstKey, idempotency = 'api-request') => app.request('/v1/notify', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'idempotency-key': idempotency },
  body: JSON.stringify(body),
});
const sendBatch = (body: unknown, apiKey = firstKey, idempotency = 'batch-request') => app.request('/v1/batches', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'idempotency-key': idempotency },
  body: JSON.stringify(body),
});

after(() => {
  db.close();
  rmSync(folder, { recursive: true });
});

test('batch API persists all jobs atomically and exposes status only to its owner', async () => {
  const response = await sendBatch(batchInput);
  assert.equal(response.status, 202);
  const body = batchResponse.parse(await response.json());
  assert.equal(body.batch.status, 'queued');
  assert.equal(body.batch.total, 2);
  assert.equal(body.batch.progress, 0);
  assert.equal(response.headers.get('location'), '/v1/batches/' + body.batch.id);
  assert.equal(batchResponse.parse(await (await sendBatch(batchInput)).json()).batch.id, body.batch.id);
  assert.equal((await sendBatch({ ...batchInput, message: 'changed' })).status, 409);
  const location = response.headers.get('location')!;
  assert.equal((await app.request(location, { headers: { 'x-api-key': firstKey } })).status, 200);
  assert.equal((await app.request(location, { headers: { 'x-api-key': secondKey } })).status, 404);
  assert.equal((await app.request(location)).status, 401);
  const page = await app.request(location + '/jobs?limit=1&offset=1', { headers: { 'x-api-key': firstKey } });
  const jobs = z.object({ total: z.number(), jobs: z.array(z.object({ deviceId: z.string(), priority: z.string() })) }).parse(await page.json());
  assert.equal(jobs.total, 2);
  assert.equal(jobs.jobs.length, 1);
  assert.equal(jobs.jobs[0]?.priority, 'high');
  assert.equal((await app.request(location + '/jobs', { headers: { 'x-api-key': secondKey } })).status, 404);
  assert.equal((await app.request('/api/jobs')).status, 401);
});

test('individual notify contacts Expo synchronously and replays idempotently without sending again', async (context) => {
  db.prepare('UPDATE push_worker SET next_send_at = 0').run();
  let calls = 0;
  context.mock.method(globalThis, 'fetch', async (_url: string | URL | Request, options?: RequestInit) => {
    const messages = JSON.parse(String(options?.body));
    assert.equal(messages.length, 1);
    calls++;
    return Response.json({ data: [{ status: 'ok', id: 'immediate-ticket' }] });
  });
  const response = await send(input);
  assert.equal(response.status, 200);
  const body = jobResponse.parse(await response.json());
  assert.equal(body.job.status, 'awaiting_receipt');
  assert.equal(body.job.priority, 'default');
  assert.equal((await send(input)).status, 200);
  assert.equal(calls, 1);
  assert.equal((await send({ ...input, message: 'different' })).status, 409);
  assert.equal(db.prepare("SELECT id FROM push_jobs WHERE delivery_mode = 'immediate' AND status = 'queued'").get(), undefined);
});

test('immediate upstream failures are not enqueued for automatic retries', async (context) => {
  db.prepare('UPDATE push_worker SET next_send_at = 0').run();
  context.mock.method(globalThis, 'fetch', async () => new Response('', { status: 503 }));
  assert.equal((await send(input, firstKey, 'immediate-failure')).status, 502);
  const job = db.prepare("SELECT status, error FROM push_jobs WHERE idempotency_key = 'immediate-failure'").get() as { status: string; error: string };
  assert.equal(job.status, 'dead');
  assert.equal(job.error, 'expo_http_503');
  const busy = await send(input, firstKey, 'busy');
  assert.equal(busy.status, 202);
  const queued = jobResponse.parse(await busy.json());
  assert.equal(queued.job.status, 'queued');
  assert.equal(busy.headers.get('location'), '/v1/notify/' + queued.job.id);
  db.prepare('UPDATE push_worker SET next_send_at = 0').run();
  const replay = await send(input, firstKey, 'busy');
  assert.equal(replay.status, 202);
  assert.equal(jobResponse.parse(await replay.json()).job.id, queued.job.id);
  assert.equal((db.prepare("SELECT count(*) AS count FROM push_jobs WHERE idempotency_key = 'busy'").get() as { count: number }).count, 1);
  assert.equal((await app.request(busy.headers.get('location')!, { headers: { 'x-api-key': firstKey } })).status, 200);
});

test('Expo throttling queues the same individual job and preserves Retry-After for the worker', async (context) => {
  db.prepare('UPDATE push_worker SET next_send_at = 0').run();
  const before = Date.now();
  let calls = 0;
  context.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response('', { status: 429, headers: { 'Retry-After': '60' } });
  });
  const response = await send(input, firstKey, 'expo-throttled');
  assert.equal(response.status, 202);
  const result = jobResponse.parse(await response.json());
  assert.equal(result.job.status, 'queued');
  const persisted = db.prepare('SELECT delivery_mode, available_at, error FROM push_jobs WHERE id = ?').get(result.job.id) as { delivery_mode: string; available_at: number; error: string };
  assert.equal(persisted.delivery_mode, 'queued');
  assert.ok(persisted.available_at >= before + 60_000);
  assert.equal(persisted.error, 'expo_http_429');
  assert.equal((await send(input, firstKey, 'expo-throttled')).status, 202);
  assert.equal(calls, 1);
});

test('batch validation rejects invalid last recipient, duplicates, empty and oversized batches without partial writes', async () => {
  for (const devices of [[], [...batchInput.devices, { deviceId: 'invalid-last', token: 'bad' }], [batchInput.devices[0], batchInput.devices[0]], Array.from({ length: 1001 }, (_, index) => ({ deviceId: String(index), token: `ExponentPushToken[${index}]` }))]) {
    const response = await sendBatch({ ...batchInput, devices }, firstKey, 'invalid-batch');
    assert.equal(response.status, 400);
  }
  assert.equal(db.prepare("SELECT id FROM push_batches WHERE idempotency_key = 'invalid-batch'").get(), undefined);
  assert.equal(db.prepare("SELECT id FROM devices WHERE id = 'invalid-last'").get(), undefined);
  const devices = Array.from({ length: 350 }, (_, index) => ({ deviceId: `large-${index}`, token: `ExponentPushToken[large-${index}]` }));
  assert.equal((await sendBatch({ message: 'Hello', devices }, firstKey, 'large-valid')).status, 202);
});

test('invalid token and oversized payload leave no device or job', async () => {
  assert.equal((await send({ ...input, deviceId: 'invalid', token: 'bad' }, firstKey, 'invalid')).status, 400);
  assert.equal(db.prepare("SELECT id FROM devices WHERE id = 'invalid'").get(), undefined);
  const large = await send({ ...input, message: '😀'.repeat(1500) }, firstKey, 'large');
  assert.equal(large.status, 400);
  assert.equal(z.object({ error: z.string() }).parse(await large.json()).error, 'payload_too_large');
  assert.equal((await send({ ...input, data: { oversized: 'x'.repeat(20_000) } }, firstKey, 'huge')).status, 413);
});

test('admin can inspect queue and validation rejects malformed allowlists and null bodies', async () => {
  const cookie = `${SESSION_COOKIE}=${createSessionValue()}`;
  assert.equal((await app.request('/api/jobs', { headers: { cookie } })).status, 200);
  assert.equal((await app.request('/api/batches', { headers: { cookie } })).status, 200);
  assert.equal((await app.request('/api/batches')).status, 401);
  for (const body of [null, { name: 'bad', allowedIps: '10.0.0.1/' }, { name: 'bad', allowedIps: 1 }]) {
    const response = await app.request('/api/keys', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(response.status, 400);
  }
  assert.equal(matchIpAllowlist('203.0.113.7', '10.0.0.1/'), false);
  assert.equal(matchIpAllowlist('10.0.0.2', '10.0.0.0/24'), true);
});

test('readiness reports missing worker heartbeat and OpenAPI documents immediate and batch contracts', async () => {
  assert.equal((await app.request('/ready')).status, 503);
  const response = await app.request('/doc', { headers: { cookie: `${SESSION_COOKIE}=${createSessionValue()}` } });
  assert.equal(response.status, 200);
  const doc = z.object({ paths: z.record(z.object({ post: z.object({ responses: z.record(z.unknown()) }).optional() }).passthrough()) })
    .parse(await response.json());
  assert.ok(doc.paths['/v1/notify']?.post?.responses['200']);
  assert.ok(doc.paths['/v1/notify']?.post?.responses['202']);
  assert.ok(doc.paths['/v1/batches']?.post?.responses['202']);
  assert.equal(doc.paths['/v1/notify']?.post?.responses['429'], undefined);
});

test('HTTP requests and login attempts remain authenticated without request throttling', async (context) => {
  context.mock.method(console, 'log', () => {});
  for (let index = 0; index < 125; index++) {
    assert.equal((await app.request('/v1/devices')).status, 401);
  }
  assert.equal((await app.request('/v1/devices', { headers: { 'x-api-key': firstKey } })).status, 200);
  for (let index = 0; index < 12; index++) {
    const response = await app.request('/login', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ user: 'admin', password: 'incorrect' }),
    });
    assert.equal(response.status, 401);
  }
  const response = await app.request('/login', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ user: 'admin', password: 'test-password-long-enough' }),
  });
  assert.equal(response.status, 302);
  assert.ok(response.headers.get('set-cookie'));
});

test('notify only saves the device when saveDevice is true', async (context) => {
  context.mock.method(globalThis, 'fetch', async () => Response.json({ data: [{ status: 'ok', id: 'save-device-ticket' }] }));
  db.prepare('UPDATE push_worker SET next_send_at = 0').run();
  const skipped = await send({ deviceId: 'api-no-save', token: 'ExponentPushToken[api-no-save]', message: 'Hola' }, firstKey, 'api-no-save');
  assert.equal(skipped.status, 200);
  assert.equal(db.prepare("SELECT id FROM devices WHERE id = 'api-no-save'").get(), undefined);

  const saved = await send({ deviceId: 'api-save', token: 'ExponentPushToken[api-save]', message: 'Hola', saveDevice: true }, firstKey, 'api-save');
  assert.ok([200, 202].includes(saved.status));
  assert.equal((db.prepare("SELECT id FROM devices WHERE id = 'api-save'").get() as { id: string }).id, 'api-save');
});
