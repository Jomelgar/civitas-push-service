import { config } from '../config';
import { queue } from '../queue/runtime';
import { publicJob, QueueError } from '../queue/store';
import { buildMessage, validateIdempotency, type NotifyInput } from './notifications';
import { createExpoTransport, ExpoRequestError } from './expo-push';

const transport = createExpoTransport(config.expoAccessToken);

export async function runNotify(input: NotifyInput, owner = 'admin', key?: string) {
  validateIdempotency(key);
  const message = buildMessage(input);
  const { job, replayed } = queue.beginImmediate(owner, input.deviceId, message, key);
  if (job.delivery_mode === 'queued' && (job.status === 'queued' || job.status === 'sending')) {
    return { ok: true as const, sent: 0 as const, job: publicJob(job) };
  }
  if (replayed) {
    if (job.status === 'sending') throw new QueueError('notification_in_progress', 409);
    if (!job.ticket_id) throw new QueueError(job.error || 'push_failed', 502);
    return { ok: true as const, sent: 1 as const, ticketId: job.ticket_id, job: publicJob(job) };
  }
  let cooldown = 0;
  try {
    const [ticket] = await transport.send([message]);
    if (!queue.ownsImmediate(job.id)) throw new QueueError('send_outcome_unknown', 502);
    if (!ticket || ticket.status !== 'ok') {
      const code = ticket?.details?.error || 'push_failed';
      if (code === 'MessageRateExceeded') {
        cooldown = 5000;
        return { ok: true as const, sent: 0 as const, job: publicJob(queue.deferImmediate(job.id, code, cooldown)) };
      }
      queue.update(job.id, 'dead', code, Date.now());
      if (code === 'DeviceNotRegistered') queue.invalidate(job.token);
      throw new QueueError(code, 502);
    }
    queue.update(job.id, 'awaiting_receipt', null, Date.now() + 15 * 60_000, ticket.id);
    return { ok: true as const, sent: 1 as const, ticketId: ticket.id, job: publicJob(queue.get(job.id)!) };
  } catch (error) {
    if (error instanceof QueueError) throw error;
    const code = error instanceof ExpoRequestError ? error.code : 'send_outcome_unknown';
    cooldown = error instanceof ExpoRequestError && error.retryable ? Math.max(5000, error.retryAfterMs) : 0;
    if (error instanceof ExpoRequestError && error.code === 'expo_http_429') {
      return { ok: true as const, sent: 0 as const, job: publicJob(queue.deferImmediate(job.id, code, cooldown)) };
    }
    queue.update(job.id, 'dead', code, Date.now());
    throw new QueueError(code, 502, cooldown);
  } finally {
    queue.completeImmediate(job.id, config.pushRate, cooldown);
  }
}
