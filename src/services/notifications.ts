import { z } from '@hono/zod-openapi';

import { Expo, type ExpoPushMessage } from 'expo-server-sdk';
import { QueueError } from '../queue/store';

const notifyDataSchema = z
  .object({
    type: z.string().max(64).optional().openapi({ example: 'visit_registered' }),
    screen: z.string().max(64).optional().openapi({ example: 'AccessPass' }),
    visitId: z.string().max(128).optional().openapi({ example: 'VIS-0001' }),
    propertyId: z.number().int().optional().openapi({ example: 456 }),
    residenceId: z.number().int().optional().openapi({ example: 2 }),
  })
  .passthrough()
  .openapi('NotifyData');

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
    url: z
      .string()
      .max(2048)
      .optional()
      .openapi({ example: 'app://visit/123', description: 'Deep link opcional. Si se omite, la app abre la pantalla de inicio (Home).' }),
    data: notifyDataSchema.optional().openapi({
      description: 'Datos para el enrutamiento interno de la app. Si falta `screen`, se asume "Home".',
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
  const data = { ...input.data, screen: input.data?.screen || 'Home', ...(input.url ? { url: input.url } : {}) };
  const message: ExpoPushMessage = {
    to: input.token, title: input.title ?? 'Notificación', body: input.message, sound: 'default', data,
    ...(input.priority ? { priority: input.priority } : {}),
    ...(input.channelId ? { channelId: input.channelId } : {}),
  };
  if (Buffer.byteLength(JSON.stringify(message), 'utf8') > 4096) throw new QueueError('payload_too_large', 400);
  return message;
}
