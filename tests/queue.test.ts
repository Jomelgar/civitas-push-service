import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueStore, publicJob } from '../src/queue/store';
import { PushWorker } from '../src/queue/worker';
import { ExpoRequestError, type PushTransport } from '../src/services/expo-push';

function database(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY, expo_token TEXT, platform TEXT, enabled INTEGER,
    created_at TEXT, updated_at TEXT, last_seen_at TEXT
  )`);
  return db;
}

const message = { to: 'ExponentPushToken[test]', title: 'Hello', body: 'World' };
const goodTransport: PushTransport = {
  async send(messages) { return messages.map((_, index) => ({ status: 'ok', id: `ticket-${index}` })); },
  async receipts(ids) { return Object.fromEntries(ids.map(id => [id, { status: 'ok' }])); },
};

test('jobs persist after reopening SQLite and preserve device platform', () => {
  const folder = mkdtempSync(join(tmpdir(), 'push-queue-'));
  const path = join(folder, 'queue.sqlite');
  let db = database(path);
  try {
    db.prepare("INSERT INTO devices VALUES ('device', 'old', 'android', 1, '', '', '')").run();
    const store = new QueueStore(db);
    const job = store.enqueue('owner', 'device', { ...message, priority: 'high' }, 'request');
    assert.equal((db.prepare("SELECT platform FROM devices WHERE id = 'device'").get() as { platform: string }).platform, 'android');
    db.close();
    db = database(path);
    const recovered = new QueueStore(db);
    assert.equal(recovered.get(job.id)?.status, 'queued');
    assert.equal(recovered.get(job.id)?.priority, 2);
    assert.equal(publicJob(recovered.get(job.id)!).priority, 'high');
    assert.equal(recovered.enqueue('owner', 'device', { ...message, priority: 'high' }, 'request').id, job.id);
  } finally {
    db.close();
    rmSync(folder, { recursive: true });
  }
});

test('idempotency is scoped to owner and rejects changed payload', () => {
  const db = database();
  try {
    const store = new QueueStore(db);
    const first = store.enqueue('a', 'd', message, 'key');
    assert.equal(store.enqueue('a', 'd', message, 'key').id, first.id);
    assert.throws(() => store.enqueue('a', 'd', { ...message, body: 'changed' }, 'key'), /idempotency_conflict/);
    assert.notEqual(store.enqueue('b', 'd', message, 'key').id, first.id);
    const nested = store.enqueue('a', 'nested', { ...message, data: { a: 1, b: 2 } }, 'nested');
    assert.equal(store.enqueue('a', 'nested', { ...message, data: { b: 2, a: 1 } }, 'nested').id, nested.id);
    assert.equal('token' in publicJob(first), false);
    assert.equal('payload' in publicJob(first), false);
  } finally { db.close(); }
});

test('capacity rejection is atomic and does not modify device', () => {
  const db = database();
  try {
    const store = new QueueStore(db, 1);
    store.enqueue('a', 'first', message);
    assert.throws(() => store.enqueue('a', 'second', message), /queue_full/);
    assert.equal(db.prepare("SELECT id FROM devices WHERE id = 'second'").get(), undefined);
  } finally { db.close(); }
});

test('shared lease excludes another connection and recovers interrupted jobs', () => {
  const folder = mkdtempSync(join(tmpdir(), 'push-lease-'));
  const path = join(folder, 'queue.sqlite');
  const db = database(path);
  const other = database(path);
  try {
    const a = new QueueStore(db);
    const b = new QueueStore(other);
    const job = a.enqueue('a', 'device', message, undefined, 0);
    assert.equal(a.acquire('one', 1000), true);
    assert.equal(b.acquire('two', 1001), false);
    assert.equal(a.claim('one', 8, 1000).length, 1);
    assert.equal(b.claim('two', 8, 1000).length, 0);
    assert.equal(b.acquire('two', 121001), true);
    assert.equal(a.owns('one', 121001), false);
    assert.equal(b.get(job.id)?.status, 'queued');
    assert.equal(b.claim('two', 8, 121001)[0]?.attempts, 2);
  } finally {
    other.close();
    db.close();
    rmSync(folder, { recursive: true });
  }
});

test('batch size and persistent pacing limit multiple workers', () => {
  const db = database();
  try {
    const store = new QueueStore(db);
    for (let i = 0; i < 220; i++) store.enqueue('a', `d-${i}`, message, undefined, 0);
    store.acquire('one', 1000);
    assert.equal(store.claim('one', 8, 1000).length, 100);
    store.pace('one', 100, 400, 1000);
    assert.equal(store.claim('one', 8, 1249).length, 0);
    assert.equal(store.claim('one', 8, 1250).length, 100);
    store.pace('one', 100, 400, 1250);
    assert.equal(store.claim('one', 8, 1499).length, 0);
  } finally { db.close(); }
});

test('worker sends tickets then checks receipts without resending', async () => {
  const db = database();
  try {
    const store = new QueueStore(db);
    const job = store.enqueue('a', 'd', message);
    let sends = 0;
    const worker = new PushWorker(store, { ...goodTransport, async send(messages) {
      sends++;
      return goodTransport.send(messages);
    } });
    await worker.tick();
    assert.equal(store.get(job.id)?.status, 'awaiting_receipt');
    db.prepare('UPDATE push_jobs SET available_at = 0').run();
    await worker.tick();
    assert.equal(store.get(job.id)?.status, 'accepted');
    assert.equal(sends, 1);
    await worker.stop();
  } finally { db.close(); }
});

test('429 schedules retries and applies global Retry-After cooldown', async () => {
  const db = database();
  try {
    const store = new QueueStore(db);
    const job = store.enqueue('a', 'd', message);
    const before = Date.now();
    let sends = 0;
    const worker = new PushWorker(store, { ...goodTransport, async send() {
      sends++;
      throw new ExpoRequestError('expo_http_429', true, 120_000);
    } });
    await worker.tick();
    assert.equal(store.get(job.id)?.status, 'queued');
    assert.ok(store.get(job.id)!.available_at >= before + 120_000);
    store.enqueue('a', 'other', message);
    await worker.tick();
    assert.equal(sends, 1);
    await worker.stop();
  } finally { db.close(); }
});

test('permanent ticket errors retire tokens and reject future sends until registration', async () => {
  const db = database();
  try {
    const store = new QueueStore(db);
    const job = store.enqueue('a', 'd', message);
    const worker = new PushWorker(store, { ...goodTransport, async send() {
      return [{ status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }];
    } });
    await worker.tick();
    assert.equal(store.get(job.id)?.status, 'dead');
    assert.throws(() => store.enqueue('a', 'd', message), /device_not_registered/);
    assert.throws(() => store.retry(job.id), /device_not_registered/);
    store.registerToken(String(message.to));
    assert.equal(store.enqueue('a', 'd', message).status, 'queued');
    await worker.stop();
  } finally { db.close(); }
});

test('missing receipts expire without resending; transient retries stop at configured maximum', async () => {
  const db = database();
  try {
    const store = new QueueStore(db);
    const job = store.enqueue('a', 'd', message);
    store.update(job.id, 'awaiting_receipt', null, 0, 'missing', Date.now() - 24 * 60 * 60_000);
    const worker = new PushWorker(store, { ...goodTransport, async receipts() { return {}; },
      async send() { throw new ExpoRequestError('offline', true); } }, 400, 1);
    await worker.tick();
    assert.equal(store.get(job.id)?.error, 'receipt_unavailable');
    const second = store.enqueue('a', 'second', message);
    await worker.tick();
    assert.equal(store.get(second.id)?.status, 'dead');
    assert.equal(store.retry(second.id).status, 'queued');
    await worker.stop();
  } finally { db.close(); }
});

test('expired worker cannot persist a late response after takeover', async () => {
  const db = database();
  try {
    const store = new QueueStore(db);
    const job = store.enqueue('a', 'd', message);
    const worker = new PushWorker(store, { ...goodTransport, async send(messages) {
      db.prepare('UPDATE push_worker SET lease_until = 0').run();
      assert.equal(store.acquire('replacement'), true);
      return goodTransport.send(messages);
    } });
    await worker.tick();
    assert.equal(store.get(job.id)?.status, 'queued');
    assert.equal(store.get(job.id)?.ticket_id, null);
    await worker.stop();
  } finally { db.close(); }
});

test('expired queued jobs become terminal without calling Expo', async () => {
  const db = database();
  try {
    const store = new QueueStore(db, 10, 1000);
    const job = store.enqueue('a', 'd', message, undefined, Date.now() - 2000);
    let sends = 0;
    const worker = new PushWorker(store, { ...goodTransport, async send(messages) {
      sends++;
      return goodTransport.send(messages);
    } });
    await worker.tick();
    assert.equal(sends, 0);
    assert.equal(store.get(job.id)?.error, 'job_expired');
    assert.throws(() => store.retry(job.id), /job_expired/);
    await worker.stop();
  } finally { db.close(); }
});

test('terminal retention preserves active jobs and recent idempotency records', () => {
  const db = database();
  try {
    const store = new QueueStore(db);
    const old = store.enqueue('a', 'old', message);
    const active = store.enqueue('a', 'active', message);
    const recent = store.enqueue('a', 'recent', message, 'recent');
    store.update(old.id, 'dead', 'failed', 0, null, Date.now() - 31 * 24 * 60 * 60_000);
    store.update(recent.id, 'accepted', null, 0);
    store.prune();
    assert.equal(store.get(old.id), undefined);
    assert.equal(store.get(active.id)?.status, 'queued');
    assert.equal(store.enqueue('a', 'recent', message, 'recent').id, recent.id);
  } finally { db.close(); }
});

test('batch acceptance is atomic for capacity and retired tokens', () => {
  const db = database();
  try {
    const store = new QueueStore(db, 2);
    const entries = [0, 1, 2].map(index => ({ deviceId: `batch-${index}`, message: { ...message, to: `ExponentPushToken[${index}]` } }));
    assert.throws(() => store.enqueueBatch('owner', entries, 'Too large'), /queue_full/);
    assert.equal(store.batches().length, 0);
    assert.equal(store.list().length, 0);
    store.invalidate(String(entries[1]!.message.to));
    assert.throws(() => store.enqueueBatch('owner', entries.slice(0, 2), 'Invalid'), /device_not_registered/);
    assert.equal(db.prepare('SELECT id FROM devices').get(), undefined);
    store.registerToken(String(entries[1]!.message.to));
    const batch = store.enqueueBatch('owner', entries.slice(0, 2), 'Valid', 'key');
    assert.equal(batch.total, 2);
    assert.equal(store.enqueueBatch('owner', entries.slice(0, 2), 'Valid', 'key').id, batch.id);
    assert.throws(() => store.enqueueBatch('owner', entries.slice(0, 2), 'Changed', 'key'), /idempotency_conflict/);
  } finally { db.close(); }
});

test('batch progress follows tickets and receipts and survives reopening', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'push-batch-'));
  const path = join(folder, 'queue.sqlite');
  let db = database(path);
  try {
    let store = new QueueStore(db);
    const batch = store.enqueueBatch('owner', [0, 1].map(index => ({ deviceId: `batch-${index}`, message: { ...message, to: `ExponentPushToken[${index}]` } })), 'Visit');
    const worker = new PushWorker(store, { ...goodTransport, async send() { return [
      { status: 'ok', id: 'batch-receipt' },
      { status: 'error', message: 'too big', details: { error: 'MessageTooBig' } },
    ]; } });
    await worker.tick();
    assert.equal(store.batch(batch.id)?.status, 'awaiting_receipts');
    assert.equal(store.batch(batch.id)?.progress, 100);
    assert.equal(store.batch(batch.id)?.finished, 1);
    await worker.stop();
    db.close();
    db = database(path);
    store = new QueueStore(db);
    assert.equal(store.batch(batch.id)?.counts.dead, 1);
    assert.equal(store.batch(batch.id, 'other-owner'), undefined);
    db.prepare('UPDATE push_jobs SET available_at = 0').run();
    const recoveredWorker = new PushWorker(store, goodTransport);
    await recoveredWorker.tick();
    assert.equal(store.batch(batch.id)?.status, 'partial_failure');
    assert.equal(store.batch(batch.id)?.finished, 2);
    await recoveredWorker.stop();
  } finally {
    db.close();
    rmSync(folder, { recursive: true });
  }
});

test('immediate sends reserve shared capacity and are never recovered into the queue', () => {
  const db = database();
  try {
    const store = new QueueStore(db);
    store.enqueue('owner', 'queued', message, undefined, 1000);
    const { job } = store.beginImmediate('owner', 'immediate', message, 'key', 1000);
    const fallback = store.beginImmediate('owner', 'other', message, undefined, 1001).job;
    assert.equal(fallback.status, 'queued');
    assert.equal(fallback.delivery_mode, 'queued');
    store.acquire('worker', 1001);
    assert.equal(store.get(job.id)?.status, 'sending');
    assert.equal(store.claim('worker', 8, 1001).length, 0);
    store.acquire('replacement', 121002);
    assert.equal(store.get(job.id)?.status, 'dead');
    assert.equal(store.get(job.id)?.error, 'send_outcome_unknown');
    const claimed = store.claim('replacement', 8, 121002);
    assert.equal(claimed.length, 2);
    assert.equal(claimed.some(entry => entry.id === job.id), false);
    assert.throws(() => store.retry(job.id), /immediate_job_not_retryable/);
  } finally { db.close(); }
});

test('individual fallback is persistent, idempotent and consumed by the worker', async () => {
  const db = database();
  try {
    const store = new QueueStore(db);
    const active = store.beginImmediate('owner', 'first', message).job;
    const fallback = store.beginImmediate('owner', 'second', message, 'fallback').job;
    assert.equal(store.beginImmediate('owner', 'second', message, 'fallback').job.id, fallback.id);
    assert.equal(fallback.attempts, 0);
    store.completeImmediate(active.id, 400, 0, Date.now() - 1000);
    const worker = new PushWorker(store, goodTransport);
    await worker.tick();
    assert.equal(store.get(fallback.id)?.status, 'awaiting_receipt');
    assert.equal(store.get(fallback.id)?.attempts, 1);
    assert.equal(store.get(active.id)?.status, 'sending');
    await worker.stop();
  } finally { db.close(); }
});

test('individual fallback rejects a full queue without accepting or duplicating a job', () => {
  const db = database();
  try {
    const store = new QueueStore(db, 1);
    store.beginImmediate('owner', 'first', message);
    assert.throws(() => store.beginImmediate('owner', 'second', message, 'fallback'), /queue_full/);
    assert.equal(store.list().length, 1);
  } finally { db.close(); }
});

test('immediate receipt errors never schedule automatic sending', async () => {
  const db = database();
  try {
    const store = new QueueStore(db);
    const { job } = store.beginImmediate('owner', 'immediate', message);
    store.update(job.id, 'awaiting_receipt', null, 0, 'receipt');
    store.completeImmediate(job.id, 400);
    const worker = new PushWorker(store, { ...goodTransport,
      async receipts() { return { receipt: { status: 'error', message: 'rate', details: { error: 'MessageRateExceeded' } } }; },
      async send() { assert.fail('Immediate jobs must never enter worker sending'); },
    });
    await worker.tick();
    assert.equal(store.get(job.id)?.status, 'dead');
    await worker.stop();
  } finally { db.close(); }
});

test('migration preserves previously queued notifications and is repeatable', () => {
  const db = database();
  try {
    let store = new QueueStore(db);
    const previous = store.enqueue('owner', 'legacy', message);
    db.exec(`DROP INDEX push_jobs_batch;
      ALTER TABLE push_jobs DROP COLUMN batch_id;
      ALTER TABLE push_jobs DROP COLUMN delivery_mode;
      ALTER TABLE push_worker DROP COLUMN send_reservation;`);
    store = new QueueStore(db);
    assert.equal(store.get(previous.id)?.status, 'queued');
    assert.equal(store.get(previous.id)?.delivery_mode, 'queued');
    assert.equal(store.get(previous.id)?.batch_id, null);
    store = new QueueStore(db);
    assert.equal(store.enqueueBatch('owner', [{ deviceId: 'new', message }], 'New batch').total, 1);
  } finally { db.close(); }
});

test('retention keeps whole batches until all recipients have aged terminal results', () => {
  const db = database();
  try {
    const store = new QueueStore(db);
    const old = Date.now() - 31 * 24 * 60 * 60_000;
    const batch = store.enqueueBatch('owner', [0, 1].map(index => ({ deviceId: String(index), message })), 'Old', undefined, old);
    const jobs = store.batchJobs(batch.id);
    store.update(jobs[0]!.id, 'accepted', null, 0, null, old);
    store.prune();
    assert.equal(store.batchJobs(batch.id).length, 2);
    assert.equal(store.batch(batch.id)?.total, 2);
    store.update(jobs[1]!.id, 'dead', 'expired', 0, null, old);
    store.prune();
    assert.equal(store.batch(batch.id), undefined);
    assert.equal(store.batchJobs(batch.id).length, 0);
  } finally { db.close(); }
});

test('queue priority selects urgent jobs ahead of an older backlog and keeps FIFO ties', () => {
  const db = database();
  try {
    const store = new QueueStore(db);
    const normal = Array.from({ length: 105 }, (_, index) => store.enqueue('owner', `normal-${index}`, { ...message, priority: 'normal' }, undefined, 1000));
    const urgent = store.enqueue('owner', 'urgent', { ...message, priority: 'high' }, undefined, 2000);
    store.acquire('worker', 3000);
    const jobs = store.claim('worker', 8, 3000);
    assert.equal(jobs.length, 100);
    assert.equal(jobs[0]?.id, urgent.id);
    assert.deepEqual(jobs.slice(1).map(job => job.id), normal.slice(0, 99).map(job => job.id));
  } finally { db.close(); }
});

test('queue priority ranks all levels and leaves delayed urgent retries waiting', () => {
  const db = database();
  try {
    const store = new QueueStore(db);
    const defaultJob = store.enqueue('owner', 'default', { ...message, priority: 'default' }, undefined, 1000);
    const unspecified = store.enqueue('owner', 'unspecified', message, undefined, 1000);
    const normal = store.enqueue('owner', 'normal', { ...message, priority: 'normal' }, undefined, 2000);
    const high = store.enqueue('owner', 'high', { ...message, priority: 'high' }, undefined, 2000);
    const delayed = store.enqueue('owner', 'delayed', { ...message, priority: 'high' }, undefined, 1000);
    store.update(delayed.id, 'queued', 'MessageRateExceeded', 5000);
    store.acquire('worker', 3000);
    assert.deepEqual(store.claim('worker', 8, 3000).map(job => job.id), [high.id, normal.id, defaultJob.id, unspecified.id]);
    assert.equal(store.get(delayed.id)?.attempts, 0);
    store.pace('worker', 4, 400, 3000);
    assert.equal(store.claim('worker', 8, 4999).length, 0);
    assert.equal(store.claim('worker', 8, 5000)[0]?.id, delayed.id);
  } finally { db.close(); }
});

test('queue priority survives manual retry and immediate-to-queue fallback', () => {
  const db = database();
  try {
    const store = new QueueStore(db);
    const normal = store.enqueue('owner', 'normal', { ...message, priority: 'normal' });
    const high = store.enqueue('owner', 'high', { ...message, priority: 'high' });
    store.update(high.id, 'dead', 'temporary', 0);
    assert.equal(store.retry(high.id).priority, 2);
    const direct = store.beginImmediate('owner', 'direct', { ...message, priority: 'high' }).job;
    const fallback = store.beginImmediate('owner', 'fallback', { ...message, priority: 'high' }).job;
    assert.equal(fallback.delivery_mode, 'queued');
    assert.equal(fallback.priority, 2);
    assert.equal(store.deferImmediate(direct.id, 'expo_http_429', 0).priority, 2);
    store.completeImmediate(direct.id, 400, 0, Date.now() - 1000);
    store.acquire('worker');
    const jobs = store.claim('worker', 8);
    assert.deepEqual(jobs.map(job => job.id), [high.id, direct.id, fallback.id, normal.id]);
  } finally { db.close(); }
});

test('queue priority migration backfills legacy payloads without changing idempotency', () => {
  const db = database();
  try {
    let store = new QueueStore(db);
    const defaultJob = store.enqueue('owner', 'default', message, undefined, 1000);
    const normal = store.enqueue('owner', 'normal', { ...message, priority: 'normal' }, undefined, 1000);
    const high = store.enqueue('owner', 'high', { ...message, priority: 'high' }, 'high-key', 1000);
    db.exec('DROP INDEX push_jobs_priority; ALTER TABLE push_jobs DROP COLUMN priority;');
    store = new QueueStore(db);
    store = new QueueStore(db);
    assert.equal(store.get(defaultJob.id)?.priority, 0);
    assert.equal(store.get(normal.id)?.priority, 1);
    assert.equal(store.get(high.id)?.priority, 2);
    assert.equal(store.get(high.id)?.payload, high.payload);
    assert.equal(store.enqueue('owner', 'high', { ...message, priority: 'high' }, 'high-key', 2000).id, high.id);
    store.acquire('worker', 3000);
    assert.deepEqual(store.claim('worker', 8, 3000).map(job => job.id), [high.id, normal.id, defaultJob.id]);
  } finally { db.close(); }
});

test('queue priority applies to the actual worker transport across different batches', async () => {
  const db = database();
  try {
    const store = new QueueStore(db);
    const normal = store.enqueueBatch('owner', [{ deviceId: 'normal', message: { ...message, to: 'ExponentPushToken[normal]', priority: 'normal' } }], 'Earlier');
    const urgent = store.enqueueBatch('owner', [{ deviceId: 'urgent', message: { ...message, to: 'ExponentPushToken[urgent]', priority: 'high' } }], 'Urgent');
    const worker = new PushWorker(store, { ...goodTransport, async send(messages) {
      assert.deepEqual(messages.map(entry => entry.to), ['ExponentPushToken[urgent]', 'ExponentPushToken[normal]']);
      assert.deepEqual(messages.map(entry => entry.priority), ['high', 'normal']);
      return goodTransport.send(messages);
    } });
    await worker.tick();
    assert.equal(store.batch(urgent.id)?.counts.awaiting_receipt, 1);
    assert.equal(store.batch(normal.id)?.counts.awaiting_receipt, 1);
    await worker.stop();
  } finally { db.close(); }
});
