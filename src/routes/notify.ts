import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { queue } from '../queue/runtime';
import { publicJob, QueueError } from '../queue/store';
import { notifySchema } from '../services/notifications';
import { runNotify } from '../services/dispatch';

export const jobSchema = z.object({
  id: z.string(), deviceId: z.string(), status: z.enum(['queued', 'sending', 'awaiting_receipt', 'accepted', 'dead']),
  attempts: z.number(), error: z.string().nullable(), createdAt: z.string(), updatedAt: z.string(),
  batchId: z.string().nullable(), deliveryMode: z.enum(['queued', 'immediate']),
  priority: z.enum(['default', 'normal', 'high']),
});
const successSchema = z.object({ ok: z.literal(true), job: jobSchema });
export const errorSchema = z.object({ ok: z.literal(false), error: z.string() });
export const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({ content: { 'application/json': { schema } } });

export const notifyRoutes = new OpenAPIHono<{ Variables: { apiKey: { id: string } } }>({
  defaultHook: (result, c) => {
    if (!result.success) return c.json({ ok: false, error: 'invalid_body', details: result.error.flatten() }, 400);
  },
});

notifyRoutes.openapi(createRoute({
  method: 'post', path: '/', tags: ['Notify'], summary: 'Enviar una notificación individual o encolarla si no hay capacidad',
  security: [{ ApiKeyAuth: [] }],
  request: {
    headers: z.object({ 'idempotency-key': z.string().min(1).max(128).optional() }),
    body: { ...jsonContent(notifySchema), required: true },
  },
  responses: {
    200: { ...jsonContent(z.object({ ok: z.literal(true), sent: z.literal(1), ticketId: z.string(), job: jobSchema })), description: 'Expo aceptó el mensaje durante esta petición' },
    202: { ...jsonContent(z.object({ ok: z.literal(true), sent: z.literal(0), job: jobSchema })), description: 'Sin capacidad inmediata; notificación persistida en la cola' },
    502: { ...jsonContent(errorSchema), description: 'Expo rechazó el envío o su resultado es incierto' },
    400: { ...jsonContent(errorSchema), description: 'Solicitud inválida' },
    409: { ...jsonContent(errorSchema), description: 'Clave de idempotencia reutilizada con otro contenido' },
    503: { ...jsonContent(errorSchema), description: 'Cola llena' },
  },
}), async (c) => {
  try {
    const result = await runNotify(c.req.valid('json'), (c.get('apiKey') as { id: string }).id, c.req.header('idempotency-key'));
    c.header('Location', '/v1/notify/' + result.job.id);
    if (result.sent === 0) return c.json(result, 202);
    return c.json(result, 200);
  } catch (error) {
    if (error instanceof QueueError) {
      if (error.status === 503) c.header('Retry-After', String(Math.max(1, Math.ceil((error.retryAfterMs || 60_000) / 1000))));
      return c.json({ ok: false as const, error: error.code }, error.status);
    }
    throw error;
  }
});

notifyRoutes.openapi(createRoute({
  method: 'get', path: '/{id}', tags: ['Notify'], summary: 'Consultar estado de notificación',
  security: [{ ApiKeyAuth: [] }], request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: { ...jsonContent(successSchema), description: 'Estado actual' },
    404: { ...jsonContent(errorSchema), description: 'No encontrada' },
  },
}), (c) => {
  const job = queue.get(c.req.valid('param').id);
  if (!job || job.owner !== (c.get('apiKey') as { id: string }).id) return c.json({ ok: false as const, error: 'not_found' }, 404);
  c.header('Cache-Control', 'no-store');
  return c.json({ ok: true as const, job: publicJob(job) }, 200);
});
