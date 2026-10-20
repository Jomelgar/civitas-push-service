import { randomUUID } from 'node:crypto';
import type { ExpoPushMessage } from 'expo-server-sdk';
import { ExpoRequestError, type PushTransport } from '../services/expo-push';
import { type Job, QueueStore } from './store';

export class PushWorker {
  private holder = randomUUID();
  private stopping = false;
  private running: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private store: QueueStore,
    private transport: PushTransport,
    private rate = 400,
    private maxAttempts = 8,
  ) {}

  private fail(job: Job, code: string, retryable: boolean, delay = 0) {
    const retry = retryable && job.delivery_mode === 'queued' && job.attempts < this.maxAttempts;
    const backoff = Math.min(3_600_000, 5000 * 2 ** (job.attempts - 1)) + Math.floor(Math.random() * 1000);
    this.store.update(job.id, retry ? 'queued' : 'dead', code, Date.now() + Math.max(delay, backoff));
    if (code === 'DeviceNotRegistered') this.store.invalidate(job.token);
  }

  async tick() {
    if (!this.store.acquire(this.holder)) return;
    const receipts = this.store.receipts();
    if (receipts.length) {
      let results: Awaited<ReturnType<PushTransport['receipts']>> = {};
      try {
        results = await this.transport.receipts(receipts.map(job => job.ticket_id!));
      } catch {
        results = {};
      }
      if (!this.store.owns(this.holder)) return;
      for (const job of receipts) {
        const receipt = results[job.ticket_id!];
        if (receipt?.status === 'ok') {
          this.store.update(job.id, 'accepted', null, Date.now());
        } else if (receipt?.status === 'error') {
          const code = receipt.details?.error ?? 'expo_receipt_error';
          this.fail(job, code, code === 'MessageRateExceeded');
        } else if (Date.now() - job.updated_at >= 23 * 60 * 60_000) {
          this.store.update(job.id, 'dead', 'receipt_unavailable', Date.now());
        } else {
          this.store.update(job.id, 'awaiting_receipt', 'receipt_pending', Date.now() + 60_000, null, job.updated_at);
        }
      }
    }
    if (!this.store.acquire(this.holder)) return;
    const jobs = this.store.claim(this.holder, this.maxAttempts);
    if (jobs.length) {
      let cooldown = 0;
      try {
        const tickets = await this.transport.send(jobs.map(job => JSON.parse(job.payload) as ExpoPushMessage));
        if (!this.store.owns(this.holder)) return;
        for (let index = 0; index < jobs.length; index++) {
          const job = jobs[index]!;
          const ticket = tickets[index];
          if (this.store.get(job.id)?.status === 'dead') continue;
          if (ticket?.status === 'ok') {
            this.store.update(job.id, 'awaiting_receipt', null, Date.now() + 15 * 60_000, ticket.id);
          } else {
            const code = ticket?.details?.error ?? 'expo_ticket_error';
            this.fail(job, code, code === 'MessageRateExceeded' || !ticket);
          }
        }
      } catch (error) {
        if (!this.store.owns(this.holder)) return;
        cooldown = error instanceof ExpoRequestError && error.retryable ? Math.max(5000, error.retryAfterMs) : 0;
        for (const job of jobs) {
          if (this.store.get(job.id)?.status !== 'sending') continue;
          this.fail(job, error instanceof ExpoRequestError ? error.code : 'send_failed',
            error instanceof ExpoRequestError ? error.retryable : true,
            error instanceof ExpoRequestError ? error.retryAfterMs : 0);
        }
      } finally {
        if (this.store.owns(this.holder)) this.store.pace(this.holder, jobs.length, this.rate, Date.now(), cooldown);
      }
    }
    this.store.prune();
  }

  start() {
    const loop = () => {
      if (this.stopping) return;
      this.running = this.tick().catch(error => {
        console.error('[push-worker]', error instanceof Error ? error.message : 'worker_failed');
        this.store.release(this.holder);
      }).finally(() => {
        if (!this.stopping) this.timer = setTimeout(loop, 250);
      });
    };
    loop();
  }

  async stop() {
    this.stopping = true;
    clearTimeout(this.timer);
    await this.running;
    this.store.release(this.holder);
  }
}
