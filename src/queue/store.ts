import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ExpoPushMessage } from 'expo-server-sdk';

export interface Job {
  id: string;
  owner: string;
  device_id: string;
  token: string;
  payload: string;
  status: 'queued' | 'sending' | 'awaiting_receipt' | 'accepted' | 'dead';
  attempts: number;
  available_at: number;
  created_at: number;
  updated_at: number;
  ticket_id: string | null;
  error: string | null;
  batch_id: string | null;
  delivery_mode: 'queued' | 'immediate';
  priority: 0 | 1 | 2;
}

export interface BatchEntry { deviceId: string; message: ExpoPushMessage }
interface BatchRow { id: string; owner: string; name: string; total: number; created_at: number }

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
}

export class QueueError extends Error {
  constructor(public code: string, public status: 400 | 409 | 502 | 503, public retryAfterMs = 0) {
    super(code);
  }
}

export class QueueStore {
  constructor(private db: DatabaseSync, private capacity = 100_000, private ttlMs = 24 * 60 * 60_000) {
    db.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS push_jobs (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        idempotency_key TEXT,
        fingerprint TEXT NOT NULL,
        device_id TEXT NOT NULL,
        token TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','sending','awaiting_receipt','accepted','dead')),
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        ticket_id TEXT,
        error TEXT,
        UNIQUE(owner, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS push_jobs_due ON push_jobs(status, available_at);
      CREATE INDEX IF NOT EXISTS push_jobs_owner ON push_jobs(owner, created_at);
      CREATE TABLE IF NOT EXISTS push_worker (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        holder TEXT,
        lease_until INTEGER NOT NULL DEFAULT 0,
        next_send_at INTEGER NOT NULL DEFAULT 0,
        heartbeat_at INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO push_worker(id) VALUES (1);
      CREATE TABLE IF NOT EXISTS invalid_push_tokens (
        token TEXT PRIMARY KEY,
        detected_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS push_batches (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL,
        idempotency_key TEXT, fingerprint TEXT NOT NULL, total INTEGER NOT NULL,
        created_at INTEGER NOT NULL, UNIQUE(owner, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS push_batches_owner ON push_batches(owner, created_at);
    `);
    this.transaction(() => {
      const columns = this.db.prepare('PRAGMA table_info(push_jobs)').all() as { name: string }[];
      if (!columns.some(column => column.name === 'batch_id')) this.db.exec('ALTER TABLE push_jobs ADD COLUMN batch_id TEXT');
      if (!columns.some(column => column.name === 'delivery_mode')) this.db.exec("ALTER TABLE push_jobs ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'queued'");
      if (!columns.some(column => column.name === 'priority')) {
        this.db.exec(`ALTER TABLE push_jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 0 CHECK(priority IN (0, 1, 2));
          UPDATE push_jobs SET priority = CASE WHEN json_valid(payload) THEN
            CASE json_extract(payload, '$.priority') WHEN 'high' THEN 2 WHEN 'normal' THEN 1 ELSE 0 END
            ELSE 0 END;`);
      }
      const workerColumns = this.db.prepare('PRAGMA table_info(push_worker)').all() as { name: string }[];
      if (!workerColumns.some(column => column.name === 'send_reservation')) this.db.exec('ALTER TABLE push_worker ADD COLUMN send_reservation TEXT');
      this.db.exec('CREATE INDEX IF NOT EXISTS push_jobs_batch ON push_jobs(batch_id, created_at, id)');
      this.db.exec("CREATE INDEX IF NOT EXISTS push_jobs_priority ON push_jobs(priority DESC, created_at) WHERE status = 'queued'");
    });
  }

  transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = operation();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  enqueue(owner: string, deviceId: string, message: ExpoPushMessage, key?: string, now = Date.now()) {
    const payload = canonical(message);
    const token = String(message.to);
    const fingerprint = createHash('sha256').update(deviceId + '\n' + payload).digest('hex');
    return this.transaction(() => {
      if (key) {
        const previous = this.db.prepare('SELECT * FROM push_jobs WHERE owner = ? AND idempotency_key = ?')
          .get(owner, key) as unknown as Job & { fingerprint: string } | undefined;
        if (previous) {
          if (previous.fingerprint !== fingerprint) throw new QueueError('idempotency_conflict', 409);
          return previous;
        }
      }
      if (this.db.prepare('SELECT token FROM invalid_push_tokens WHERE token = ?').get(token)) {
        throw new QueueError('device_not_registered', 400);
      }
      const active = this.db.prepare("SELECT count(*) AS count FROM push_jobs WHERE status IN ('queued','sending','awaiting_receipt')")
        .get() as { count: number };
      if (active.count >= this.capacity) throw new QueueError('queue_full', 503);
      return this.insert(owner, deviceId, message, now, null, 'queued', key);
    });
  }

  private insert(owner: string, deviceId: string, message: ExpoPushMessage, now: number, batchId: string | null, mode: Job['delivery_mode'], key?: string, saveDevice = true) {
    const id = randomUUID();
    const payload = canonical(message);
    const token = String(message.to);
    const fingerprint = createHash('sha256').update(deviceId + '\n' + payload).digest('hex');
    const priority = message.priority === 'high' ? 2 : message.priority === 'normal' ? 1 : 0;
    this.db.prepare(`INSERT INTO push_jobs
      (id, owner, idempotency_key, fingerprint, device_id, token, payload, status, attempts, available_at, created_at, updated_at, batch_id, delivery_mode, priority)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, owner, key ?? null, fingerprint, deviceId, token, payload, mode === 'immediate' ? 'sending' : 'queued', mode === 'immediate' ? 1 : 0, now, now, now, batchId, mode, priority);
    if (saveDevice) {
      const timestamp = new Date(now).toISOString();
      this.db.prepare(`INSERT INTO devices (id, expo_token, platform, enabled, created_at, updated_at, last_seen_at)
        VALUES (?, ?, 'unknown', 1, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET expo_token = excluded.expo_token, updated_at = excluded.updated_at`)
        .run(deviceId, token, timestamp, timestamp, timestamp);
    }
    return this.get(id)!;
  }

  enqueueBatch(owner: string, entries: BatchEntry[], name: string, key?: string, now = Date.now()) {
    const fingerprint = createHash('sha256').update(canonical({ entries, name })).digest('hex');
    return this.transaction(() => {
      if (key) {
        const previous = this.db.prepare('SELECT id, fingerprint FROM push_batches WHERE owner = ? AND idempotency_key = ?')
          .get(owner, key) as { id: string; fingerprint: string } | undefined;
        if (previous) {
          if (previous.fingerprint !== fingerprint) throw new QueueError('idempotency_conflict', 409);
          return this.batch(previous.id)!;
        }
      }
      const active = this.db.prepare("SELECT count(*) AS count FROM push_jobs WHERE status IN ('queued','sending','awaiting_receipt')").get() as { count: number };
      if (active.count + entries.length > this.capacity) throw new QueueError('queue_full', 503);
      for (const entry of entries) {
        if (this.db.prepare('SELECT token FROM invalid_push_tokens WHERE token = ?').get(String(entry.message.to))) throw new QueueError('device_not_registered', 400);
      }
      const id = randomUUID();
      this.db.prepare('INSERT INTO push_batches (id, owner, name, idempotency_key, fingerprint, total, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, owner, name, key ?? null, fingerprint, entries.length, now);
      for (const entry of entries) this.insert(owner, entry.deviceId, entry.message, now, id, 'queued');
      return this.batch(id)!;
    });
  }

  beginImmediate(owner: string, deviceId: string, message: ExpoPushMessage, key?: string, now = Date.now(), saveDevice = true) {
    return this.transaction(() => {
      if (key) {
        const previous = this.db.prepare('SELECT * FROM push_jobs WHERE owner = ? AND idempotency_key = ?').get(owner, key) as unknown as Job | undefined;
        if (previous) {
          if (previous.batch_id !== null || previous.device_id !== deviceId || previous.payload !== canonical(message)) throw new QueueError('idempotency_conflict', 409);
          return { job: previous, replayed: true };
        }
      }
      const lock = this.db.prepare('SELECT next_send_at FROM push_worker WHERE id = 1').get() as { next_send_at: number };
      const active = this.db.prepare("SELECT count(*) AS count FROM push_jobs WHERE status IN ('queued','sending','awaiting_receipt')").get() as { count: number };
      if (active.count >= this.capacity) throw new QueueError('queue_full', 503);
      if (this.db.prepare('SELECT token FROM invalid_push_tokens WHERE token = ?').get(String(message.to))) throw new QueueError('device_not_registered', 400);
      const mode = lock.next_send_at > now ? 'queued' : 'immediate';
      const job = this.insert(owner, deviceId, message, now, null, mode, key, saveDevice);
      if (mode === 'immediate') this.db.prepare('UPDATE push_worker SET next_send_at = ?, send_reservation = ? WHERE id = 1').run(now + 120_000, job.id);
      return { job, replayed: false };
    });
  }

  completeImmediate(id: string, rate: number, cooldown = 0, now = Date.now()) {
    this.db.prepare('UPDATE push_worker SET next_send_at = ?, send_reservation = NULL WHERE send_reservation = ?')
      .run(now + Math.max(cooldown, Math.ceil(1000 / rate)), id);
  }

  deferImmediate(id: string, error: string, delay: number, now = Date.now()) {
    return this.transaction(() => {
      if (!this.ownsImmediate(id, now)) throw new QueueError('send_outcome_unknown', 502);
      this.db.prepare("UPDATE push_jobs SET delivery_mode = 'queued', status = 'queued', error = ?, available_at = ?, updated_at = ? WHERE id = ? AND status = 'sending'")
        .run(error, now + delay, now, id);
      return this.get(id)!;
    });
  }

  ownsImmediate(id: string, now = Date.now()) {
    return Boolean(this.db.prepare('SELECT id FROM push_worker WHERE send_reservation = ? AND next_send_at > ?').get(id, now));
  }

  batch(id: string, owner?: string) {
    const row = (owner
      ? this.db.prepare('SELECT * FROM push_batches WHERE id = ? AND owner = ?').get(id, owner)
      : this.db.prepare('SELECT * FROM push_batches WHERE id = ?').get(id)) as unknown as BatchRow | undefined;
    if (!row) return undefined;
    const counts = { queued: 0, sending: 0, awaiting_receipt: 0, accepted: 0, dead: 0 };
    for (const state of this.db.prepare('SELECT status, count(*) AS count FROM push_jobs WHERE batch_id = ? GROUP BY status').all(id) as { status: Job['status']; count: number }[]) counts[state.status] = state.count;
    const processed = row.total - counts.queued - counts.sending;
    const finished = counts.accepted + counts.dead;
    const status = counts.queued === row.total ? 'queued' : counts.queued + counts.sending > 0 ? 'processing'
      : counts.awaiting_receipt > 0 ? 'awaiting_receipts' : counts.dead === 0 ? 'completed' : counts.dead === row.total ? 'failed' : 'partial_failure';
    return { id: row.id, name: row.name, total: row.total, status, counts, processed, finished,
      progress: Math.floor(processed * 100 / row.total), createdAt: new Date(row.created_at).toISOString() };
  }

  batches(owner?: string, limit = 50, offset = 0) {
    const rows = (owner
      ? this.db.prepare('SELECT id FROM push_batches WHERE owner = ? ORDER BY created_at DESC, id LIMIT ? OFFSET ?').all(owner, limit, offset)
      : this.db.prepare('SELECT id FROM push_batches ORDER BY created_at DESC, id LIMIT ? OFFSET ?').all(limit, offset)) as { id: string }[];
    return rows.map(row => this.batch(row.id)!);
  }

  batchJobs(id: string, limit = 50, offset = 0): Job[] {
    return this.db.prepare('SELECT * FROM push_jobs WHERE batch_id = ? ORDER BY created_at, id LIMIT ? OFFSET ?').all(id, limit, offset) as unknown as Job[];
  }

  get(id: string): Job | undefined {
    return this.db.prepare('SELECT * FROM push_jobs WHERE id = ?').get(id) as unknown as Job | undefined;
  }

  list(owner?: string, limit = 50): Job[] {
    return (owner
      ? this.db.prepare('SELECT * FROM push_jobs WHERE owner = ? ORDER BY created_at DESC LIMIT ?').all(owner, limit)
      : this.db.prepare('SELECT * FROM push_jobs ORDER BY created_at DESC LIMIT ?').all(limit)) as unknown as Job[];
  }

  stats() {
    return this.db.prepare('SELECT status, count(*) AS count FROM push_jobs GROUP BY status').all();
  }

  acquire(holder: string, now = Date.now()): boolean {
    return this.transaction(() => {
      const lock = this.db.prepare('SELECT * FROM push_worker WHERE id = 1')
        .get() as { holder: string | null; lease_until: number };
      if (lock.lease_until > now && lock.holder !== holder) return false;
      if (lock.holder !== holder) {
        this.db.prepare("UPDATE push_jobs SET status = 'queued', error = 'worker_interrupted', available_at = ? WHERE status = 'sending' AND delivery_mode = 'queued'").run(now);
      }
      this.db.prepare("UPDATE push_jobs SET status = 'dead', error = 'send_outcome_unknown', updated_at = ? WHERE status = 'sending' AND delivery_mode = 'immediate' AND updated_at <= ?").run(now, now - 120_000);
      this.db.prepare('UPDATE push_worker SET holder = ?, lease_until = ?, heartbeat_at = ? WHERE id = 1')
        .run(holder, now + 120_000, now);
      return true;
    });
  }

  release(holder: string) {
    this.db.prepare('UPDATE push_worker SET holder = NULL, lease_until = 0 WHERE id = 1 AND holder = ?').run(holder);
  }

  owns(holder: string, now = Date.now()): boolean {
    return Boolean(this.db.prepare('SELECT id FROM push_worker WHERE holder = ? AND lease_until > ?').get(holder, now));
  }

  health(now = Date.now()) {
    const state = this.db.prepare('SELECT heartbeat_at FROM push_worker WHERE id = 1').get() as { heartbeat_at: number };
    return { workerHealthy: now - state.heartbeat_at < 120_000, heartbeatAt: state.heartbeat_at };
  }

  retry(id: string) {
    return this.transaction(() => {
      const job = this.get(id);
      if (!job || job.status !== 'dead') throw new QueueError('job_not_retryable', 409);
      if (job.delivery_mode === 'immediate') throw new QueueError('immediate_job_not_retryable', 409);
      if (Date.now() - job.created_at >= this.ttlMs) throw new QueueError('job_expired', 409);
      if (this.db.prepare('SELECT token FROM invalid_push_tokens WHERE token = ?').get(job.token)) {
        throw new QueueError('device_not_registered', 400);
      }
      const active = this.db.prepare("SELECT count(*) AS count FROM push_jobs WHERE status IN ('queued','sending','awaiting_receipt')").get() as { count: number };
      if (active.count >= this.capacity) throw new QueueError('queue_full', 503);
      this.db.prepare("UPDATE push_jobs SET status = 'queued', attempts = 0, error = NULL, ticket_id = NULL, available_at = ?, updated_at = ? WHERE id = ?")
        .run(Date.now(), Date.now(), id);
      return this.get(id)!;
    });
  }

  registerToken(token: string) {
    this.db.prepare('DELETE FROM invalid_push_tokens WHERE token = ?').run(token);
  }

  claim(holder: string, maxAttempts: number, now = Date.now()): Job[] {
    return this.transaction(() => {
      const lock = this.db.prepare('SELECT * FROM push_worker WHERE id = 1')
        .get() as { holder: string | null; lease_until: number; next_send_at: number };
      if (lock.holder !== holder || lock.lease_until <= now || lock.next_send_at > now) return [];
      this.db.prepare("UPDATE push_jobs SET status = 'dead', error = 'job_expired', updated_at = ? WHERE status = 'queued' AND created_at <= ?")
        .run(now, now - this.ttlMs);
      this.db.prepare("UPDATE push_jobs SET status = 'dead', error = 'attempts_exhausted', updated_at = ? WHERE status = 'queued' AND attempts >= ?")
        .run(now, maxAttempts);
      const jobs = this.db.prepare("SELECT * FROM push_jobs WHERE status = 'queued' AND available_at <= ? ORDER BY priority DESC, created_at, rowid LIMIT 100")
        .all(now) as unknown as Job[];
      for (const job of jobs) {
        this.db.prepare("UPDATE push_jobs SET status = 'sending', attempts = attempts + 1, updated_at = ? WHERE id = ?").run(now, job.id);
        job.attempts++;
      }
      if (jobs.length) this.db.prepare('UPDATE push_worker SET next_send_at = ?, send_reservation = ? WHERE id = 1').run(now + 120_000, holder);
      return jobs;
    });
  }

  pace(holder: string, count: number, rate: number, now = Date.now(), cooldown = 0) {
    this.db.prepare('UPDATE push_worker SET next_send_at = ?, send_reservation = NULL WHERE id = 1 AND holder = ? AND (send_reservation IS NULL OR send_reservation = ?)')
      .run(now + Math.max(cooldown, Math.ceil(count * 1000 / rate)), holder, holder);
  }

  update(id: string, status: Job['status'], error: string | null, due: number, ticket: string | null = null, now = Date.now()) {
    this.db.prepare('UPDATE push_jobs SET status = ?, error = ?, available_at = ?, ticket_id = COALESCE(?, ticket_id), updated_at = ? WHERE id = ?')
      .run(status, error, due, ticket, now, id);
  }

  receipts(now = Date.now()): Job[] {
    return this.db.prepare("SELECT * FROM push_jobs WHERE status = 'awaiting_receipt' AND available_at <= ? ORDER BY available_at LIMIT 1000")
      .all(now) as unknown as Job[];
  }

  invalidate(token: string, now = Date.now()) {
    this.transaction(() => {
      this.db.prepare('INSERT OR REPLACE INTO invalid_push_tokens(token, detected_at) VALUES (?, ?)').run(token, now);
      this.db.prepare("UPDATE devices SET enabled = 0 WHERE expo_token = ?").run(token);
      this.db.prepare("UPDATE push_jobs SET status = 'dead', error = 'DeviceNotRegistered', updated_at = ? WHERE token = ? AND status IN ('queued','sending')")
        .run(now, token);
    });
  }

  prune(now = Date.now()) {
    this.db.prepare("DELETE FROM push_jobs WHERE id IN (SELECT id FROM push_jobs WHERE batch_id IS NULL AND status IN ('accepted','dead') AND updated_at < ? LIMIT 1000)")
      .run(now - 30 * 24 * 60 * 60_000);
    const expired = this.db.prepare(`SELECT b.id FROM push_batches b WHERE b.created_at < ?
      AND NOT EXISTS (SELECT 1 FROM push_jobs j WHERE j.batch_id = b.id AND (j.status NOT IN ('accepted','dead') OR j.updated_at >= ?)) LIMIT 10`)
      .all(now - 30 * 24 * 60 * 60_000, now - 30 * 24 * 60 * 60_000) as { id: string }[];
    for (const batch of expired) this.transaction(() => {
      this.db.prepare('DELETE FROM push_jobs WHERE batch_id = ?').run(batch.id);
      this.db.prepare('DELETE FROM push_batches WHERE id = ?').run(batch.id);
    });
  }
}

export function publicJob(job: Job) {
  return {
    id: job.id, deviceId: job.device_id, status: job.status, attempts: job.attempts,
    error: job.error, createdAt: new Date(job.created_at).toISOString(),
    updatedAt: new Date(job.updated_at).toISOString(),
    batchId: job.batch_id, deliveryMode: job.delivery_mode,
    priority: (['default', 'normal', 'high'] as const)[job.priority],
  };
}
