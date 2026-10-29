import { z } from '@hono/zod-openapi';

import { Expo, type ExpoPushMessage } from 'expo-server-sdk';
import { QueueError } from '../queue/store';

const notifyDataSchema = z
  .object({
    type: z.string().max(64).optional().openapi({ example: 'visit_entry' }),
    screen: z.string().max(64).optional().openapi({ example: 'VisitStatus' }),
    visitId: z.string().max(128).optional().openapi({ example: 'VIS-0001' }),
    status: z
      .enum(['pending', 'inside', 'outside'])
      .optional()
      .openapi({ example: 'inside', description: 'Estado de la visita en el momento del aviso.' }),
    visitor: z.string().max(256).optional().openapi({ example: 'Juan Pérez' }),
    propertyLabel: z.string().max(256).optional().openapi({ example: 'Casa 4' }),
    occurredAt: z.string().max(64).optional().openapi({ example: '2026-10-27T14:32:00-06:00' }),
    propertyId: z.number().int().optional().openapi({ example: 456 }),
    residenceId: z.number().int().optional().openapi({ example: 2 }),
  })
  .passthrough()
  .openapi('NotifyData');

const VISIT_EVENT_TYPES = new Set(['visit_created', 'visit_registered', 'visit_entry', 'visit_exit']);

/**
 * Resuelve la pantalla destino en la app.
 * Los eventos de visita abren `VisitStatus` aunque el emisor no envíe `screen`.
 */
export function resolveScreen(data?: { type?: string; screen?: string }): string {
  if (data?.screen) return data.screen;
  if (data?.type && VISIT_EVENT_TYPES.has(data.type)) return 'VisitStatus';
  if (data?.type === 'panic') return 'SecurityDashboard';
  return 'Splash';
}

export const notifySchema = z
  .object({
    deviceId: z.string().min(1).max(128).openapi({ example: 'device-123' }),
    token: z
      .string()
      .min(1)
      .max(512)
      .openapi({ example: 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]' }),
    message: z.string().min(1).max(4000).openapi({ example: 'Tienes una visita en la puerta.' }),
    title: z.string().min(1).max(256).optional().openapi({ example: 'Civitas Access' }),
    saveDevice: z
      .boolean()
      .optional()
      .openapi({
        example: false,
        default: false,
        description: 'Guarda o actualiza el dispositivo y reactiva tokens retirados. Por defecto no se guarda.',
      }),
    url: z
      .string()
      .max(2048)
      .optional()
      .openapi({ example: 'app://visit/123', description: 'Deep link opcional. Si se omite, se usa `data.screen` (por defecto Splash).' }),
    data: notifyDataSchema.optional().openapi({
      description: 'Datos para el enrutamiento interno de la app. Si falta `screen`, se asume "Splash".',
    }),
    priority: z
      .enum(['default', 'normal', 'high'])
      .optional()
      .openapi({ example: 'high', description: 'Prioridad de procesamiento en cola y de envío a Expo: high, normal, default. Sin valor se usa default.' }),
    channelId: z.string().max(64).optional().openapi({ example: 'panic' }),
  })
  .openapi('NotifyRequest');

export type NotifyInput = z.infer<typeof notifySchema>;

export function validateIdempotency(key?: string) {
  if (key !== undefined && (!key.trim() || key.length > 128)) throw new QueueError('invalid_idempotency_key', 400);
}

export function buildMessage(input: NotifyInput): ExpoPushMessage {
  if (!Expo.isExpoPushToken(input.token)) throw new QueueError('invalid_expo_token', 400);
  const data = { ...input.data, screen: resolveScreen(input.data), ...(input.url ? { url: input.url } : {}) };
  const message: ExpoPushMessage = {
    to: input.token, title: input.title ?? 'Notificación', body: input.message, sound: 'default', data,
    ...(input.priority ? { priority: input.priority } : {}),
    ...(input.channelId ? { channelId: input.channelId } : {}),
  };
  if (Buffer.byteLength(JSON.stringify(message), 'utf8') > 4096) throw new QueueError('payload_too_large', 400);
  return message;
}
