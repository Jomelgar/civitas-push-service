import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { batchSchema, pageSchema, runBatch } from '../services/batches';
import { queue } from '../queue/runtime';
import { publicJob, QueueError } from '../queue/store';
import { errorSchema, jobSchema, jsonContent } from './notify';

const batchResponse = z.object({
  id: z.string().uuid(), name: z.string(), total: z.number(), status: z.string(),
  counts: z.object({ queued: z.number(), sending: z.number(), awaiting_receipt: z.number(), accepted: z.number(), dead: z.number() }),
  processed: z.number(), finished: z.number(), progress: z.number(), createdAt: z.string(),
});
const successSchema = z.object({ ok: z.literal(true), batch: batchResponse });
const params = z.object({ id: z.string().uuid() });
const security = [{ ApiKeyAuth: [] }];

export const batchesRoutes = new OpenAPIHono<{ Variables: { apiKey: { id: string } } }>({
  defaultHook: (result, c) => {
    if (!result.success) return c.json({ ok: false, error: 'invalid_body', details: result.error.flatten() }, 400);
  },
});

batchesRoutes.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  await next();
});

batchesRoutes.openapi(createRoute({
  method: 'post', path: '/', tags: ['Batches'], summary: 'Encolar un lote de hasta 1000 dispositivos', security,
  request: { headers: z.object({ 'idempotency-key': z.string().min(1).max(128).optional() }), body: { ...jsonContent(batchSchema), required: true } },
  responses: {
    202: { ...jsonContent(successSchema), description: 'Lote persistido completamente' },
    400: { ...jsonContent(errorSchema), description: 'Lote inválido' },
    409: { ...jsonContent(errorSchema), description: 'Conflicto de idempotencia' },
    503: { ...jsonContent(errorSchema), description: 'Cola sin capacidad para el lote completo' },
  },
}), (c) => {
  try {
    const result = runBatch(c.req.valid('json'), c.get('apiKey').id, c.req.header('idempotency-key'));
    c.header('Location', '/v1/batches/' + result.batch.id);
    return c.json(result, 202);
  } catch (error) {
    if (error instanceof QueueError) {
      if (error.status === 503) c.header('Retry-After', '60');
      return c.json({ ok: false as const, error: error.code }, error.status as 400 | 409 | 503);
    }
    throw error;
  }
});

batchesRoutes.openapi(createRoute({
  method: 'get', path: '/', tags: ['Batches'], summary: 'Listar mis lotes', security,
  request: { query: pageSchema }, responses: {
    200: { ...jsonContent(z.object({ ok: z.literal(true), batches: z.array(batchResponse), limit: z.number(), offset: z.number() })), description: 'Lotes de la API key actual' },
  },
}), (c) => {
  const { limit, offset } = c.req.valid('query');
  return c.json({ ok: true as const, batches: queue.batches(c.get('apiKey').id, limit, offset), limit, offset }, 200);
});

batchesRoutes.openapi(createRoute({
  method: 'get', path: '/{id}', tags: ['Batches'], summary: 'Consultar progreso del lote', security,
  request: { params }, responses: {
    200: { ...jsonContent(successSchema), description: 'Progreso y resultados agregados' },
    404: { ...jsonContent(errorSchema), description: 'Lote no encontrado' },
  },
}), (c) => {
  const batch = queue.batch(c.req.valid('param').id, c.get('apiKey').id);
  return batch ? c.json({ ok: true as const, batch }, 200) : c.json({ ok: false as const, error: 'not_found' }, 404);
});

batchesRoutes.openapi(createRoute({
  method: 'get', path: '/{id}/jobs', tags: ['Batches'], summary: 'Consultar resultados por dispositivo', security,
  request: { params, query: pageSchema }, responses: {
    200: { ...jsonContent(z.object({ ok: z.literal(true), jobs: z.array(jobSchema), total: z.number(), limit: z.number(), offset: z.number() })), description: 'Página de dispositivos y estados' },
    404: { ...jsonContent(errorSchema), description: 'Lote no encontrado' },
  },
}), (c) => {
  const batch = queue.batch(c.req.valid('param').id, c.get('apiKey').id);
  if (!batch) return c.json({ ok: false as const, error: 'not_found' }, 404);
  const { limit, offset } = c.req.valid('query');
  return c.json({ ok: true as const, jobs: queue.batchJobs(batch.id, limit, offset).map(publicJob), total: batch.total, limit, offset }, 200);
});
