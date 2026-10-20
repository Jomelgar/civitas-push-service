import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';

import { deleteDevice, listDevices, upsertDevice } from '../db/repository';
import { Expo } from 'expo-server-sdk';
import { queue } from '../queue/runtime';

const deviceSchema = z
  .object({
    deviceId: z.string().min(1).max(128).openapi({ example: 'device-123' }),
    token: z
      .string()
      .min(1)
      .max(512)
      .refine(value => Expo.isExpoPushToken(value), 'Invalid Expo push token')
      .openapi({ example: 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]' }),
    platform: z.string().min(1).max(32).optional().openapi({ example: 'android' }),
  })
  .openapi('Device');

const syncSchema = deviceSchema
  .extend({
    items: z.array(z.unknown()).optional(),
  })
  .openapi('DeviceSync');

const deviceResponseSchema = z
  .object({
    deviceId: z.string(),
    token: z.string(),
    platform: z.string(),
    enabled: z.boolean(),
    createdAt: z.string(),
    lastSeenAt: z.string(),
  })
  .openapi('DeviceResponse');

const okResponseSchema = z.object({ ok: z.literal(true) }).openapi('OkResponse');

const errorResponseSchema = z
  .object({
    error: z.string(),
    details: z
      .object({
        formErrors: z.array(z.string()),
        fieldErrors: z.record(z.array(z.string())),
      })
      .optional(),
  })
  .openapi('ErrorResponse');

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  content: { 'application/json': { schema } },
});

const listRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Devices'],
  summary: 'Listar dispositivos',
  description: 'Devuelve todos los dispositivos registrados ordenados por última conexión.',
  security: [{ ApiKeyAuth: [] }],
  responses: {
    200: {
      ...jsonContent(
        z.object({
          ok: z.literal(true),
          count: z.number(),
          devices: z.array(deviceResponseSchema),
        }),
      ),
      description: 'Listado de dispositivos',
    },
    401: {
      ...jsonContent(errorResponseSchema),
      description: 'API key ausente, inválida o deshabilitada',
    },
  },
});

const upsertRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Devices'],
  summary: 'Registrar o actualizar un dispositivo',
  security: [{ ApiKeyAuth: [] }],
  request: {
    body: {
      ...jsonContent(deviceSchema),
      required: true,
    },
  },
  responses: {
    200: {
      ...jsonContent(okResponseSchema),
      description: 'Dispositivo registrado o actualizado',
    },
    400: {
      ...jsonContent(errorResponseSchema),
      description: 'Cuerpo de la petición inválido',
    },
    401: {
      ...jsonContent(errorResponseSchema),
      description: 'API key ausente, inválida o deshabilitada',
    },
  },
});

const syncRoute = createRoute({
  method: 'post',
  path: '/sync',
  tags: ['Devices'],
  summary: 'Sincronizar dispositivo',
  security: [{ ApiKeyAuth: [] }],
  request: {
    body: {
      ...jsonContent(syncSchema),
      required: true,
    },
  },
  responses: {
    200: {
      ...jsonContent(okResponseSchema),
      description: 'Dispositivo sincronizado',
    },
    400: {
      ...jsonContent(errorResponseSchema),
      description: 'Cuerpo de la petición inválido',
    },
    401: {
      ...jsonContent(errorResponseSchema),
      description: 'API key ausente, inválida o deshabilitada',
    },
  },
});

const deleteRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['Devices'],
  summary: 'Eliminar dispositivo',
  security: [{ ApiKeyAuth: [] }],
  request: {
    params: z.object({
      id: z.string().openapi({ example: 'device-123' }),
    }),
  },
  responses: {
    200: {
      ...jsonContent(okResponseSchema),
      description: 'Dispositivo eliminado',
    },
    401: {
      ...jsonContent(errorResponseSchema),
      description: 'API key ausente, inválida o deshabilitada',
    },
  },
});

export const devicesRoutes = new OpenAPIHono({
  defaultHook: (result, c) => {
    if (!result.success) {
      return c.json({ error: 'invalid_body', details: result.error.flatten() }, 400);
    }
  },
});

devicesRoutes.openapi(listRoute, (c) => {
  const devices = listDevices().map((device) => ({
    deviceId: device.id,
    token: device.expo_token,
    platform: device.platform,
    enabled: device.enabled === 1,
    createdAt: device.created_at,
    lastSeenAt: device.last_seen_at,
  }));
  return c.json({ ok: true as const, count: devices.length, devices }, 200);
});

devicesRoutes.openapi(upsertRoute, (c) => {
  const { deviceId, token, platform } = c.req.valid('json');
  upsertDevice({ id: deviceId, token, platform });
  queue.registerToken(token);
  return c.json({ ok: true as const }, 200);
});

devicesRoutes.openapi(syncRoute, (c) => {
  const { deviceId, token, platform } = c.req.valid('json');
  upsertDevice({ id: deviceId, token, platform });
  queue.registerToken(token);
  return c.json({ ok: true as const }, 200);
});

devicesRoutes.openapi(deleteRoute, (c) => {
  const { id } = c.req.valid('param');
  deleteDevice(id);
  return c.json({ ok: true as const }, 200);
});
