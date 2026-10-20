import type { ExpoPushMessage, ExpoPushTicket, ExpoPushReceipt } from 'expo-server-sdk';

export class ExpoRequestError extends Error {
  constructor(public code: string, public retryable: boolean, public retryAfterMs = 0) {
    super(code);
  }
}

async function request(path: string, body: unknown, accessToken?: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`https://exp.host/--/api/v2/push/${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new ExpoRequestError('expo_network_error', true);
  }
  if (!response.ok) {
    const retry = response.headers.get('retry-after');
    const seconds = retry ? Number(retry) : 0;
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Math.max(0, Date.parse(retry!) - Date.now());
    await response.body?.cancel();
    throw new ExpoRequestError(`expo_http_${response.status}`, response.status === 429 || response.status >= 500, delay || 0);
  }
  const parsed = await response.json().catch(() => null) as { data?: unknown; errors?: unknown } | null;
  if (!parsed || parsed.errors || !parsed.data) throw new ExpoRequestError('expo_invalid_response', true);
  return parsed.data;
}

export interface PushTransport {
  send(messages: ExpoPushMessage[]): Promise<ExpoPushTicket[]>;
  receipts(ids: string[]): Promise<Record<string, ExpoPushReceipt>>;
}

export const createExpoTransport = (accessToken?: string): PushTransport => ({
  async send(messages) {
    const data = await request('send', messages, accessToken);
    if (!Array.isArray(data) || data.length !== messages.length ||
      data.some(ticket => !ticket || !['ok', 'error'].includes(ticket.status) ||
        (ticket.status === 'ok' && typeof ticket.id !== 'string'))) {
      throw new ExpoRequestError('expo_invalid_tickets', true);
    }
    return data as ExpoPushTicket[];
  },
  async receipts(ids) {
    const data = await request('getReceipts', { ids }, accessToken);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new ExpoRequestError('expo_invalid_receipts', true);
    }
    return data as Record<string, ExpoPushReceipt>;
  },
});
