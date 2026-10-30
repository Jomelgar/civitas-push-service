import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

type Request = { name: string; request?: { method?: string; body?: { raw?: string } } };

const collection = JSON.parse(
  readFileSync(new URL('../postman_collection.json', import.meta.url), 'utf8')
) as {
  info: { name: string };
  auth?: { type: string; apikey: Array<{ key: string; value: string }> };
  event: Array<{ listen: string; script: { exec: string[] } }>;
  variable: Array<{ key: string }>;
  item: Array<{ item?: Request[] } & Request>;
};

function flatten(items: Array<{ item?: Request[] } & Request>): Request[] {
  return items.flatMap((item) => (item.item ? [item, ...flatten(item.item)] : [item]));
}

test('the single Postman collection contains the visit notification flows', () => {
  assert.equal(collection.info.name, 'Civitas Access API');
  assert.equal(collection.auth?.type, 'apikey');
  const authEntries = collection.auth?.apikey ?? [];
  assert.equal(authEntries.find((entry) => entry.key === 'key')?.value, 'X-API-Key');
  assert.equal(authEntries.find((entry) => entry.key === 'value')?.value, '{{apiKey}}');
  assert.equal(authEntries.find((entry) => entry.key === 'in')?.value, 'header');
  assert.ok(collection.event.some((entry) => entry.script.exec.join('\n').includes('occurredAt')));
  const variableKeys = collection.variable.map((entry) => entry.key);
  for (const key of [
    'visitId', 'propertyId', 'residenceId', 'visitor', 'propertyLabel', 'occurredAt', 'jobId',
    'panicSound', 'panicChannel', 'interruptionLevel',
  ]) {
    assert.ok(variableKeys.includes(key), key);
  }

  const requests = flatten(collection.item);
  for (const name of [
    'Enviar notificación push',
    'Visita creada (sin guardar dispositivo)',
    'Entrada registrada (sin guardar dispositivo)',
    'Salida registrada (sin guardar dispositivo)',
    'Notificar y guardar dispositivo',
    'Entrada sin screen (prueba de pantalla automática)',
    'Formato legado AccessPass',
    'Aviso sin screen (Splash por defecto)',
    'Pánico (ejemplo)',
    'Crear lote de visita (entrada)',
    'Crear lote de pánico (guardias)',
    'Verificar que no se guardó el dispositivo',
    'Verificar que sí se guardó el dispositivo',
  ]) {
    assert.ok(requests.some((request) => request.name === name), name);
  }

  const generic = requests.find((request) => request.name === 'Enviar notificación push');
  assert.ok(generic?.request?.body?.raw?.includes('"screen": "VisitStatus"'));
  assert.ok(generic?.request?.body?.raw?.includes('"status": "inside"'));

  const saved = requests.find((request) => request.name === 'Notificar y guardar dispositivo');
  assert.ok(saved?.request?.body?.raw?.includes('"saveDevice": true'));

  const entry = requests.find((request) => request.name === 'Entrada registrada (sin guardar dispositivo)');
  assert.ok(entry?.request?.body?.raw?.includes('"status": "inside"'));
  assert.ok(entry?.request?.body?.raw?.includes('"visitId": "{{visitId}}"'));
  assert.equal(entry?.request?.body?.raw?.includes('saveDevice'), false);

  const noScreen = requests.find((request) => request.name === 'Entrada sin screen (prueba de pantalla automática)');
  assert.ok(noScreen?.request?.body?.raw?.includes('"type": "visit_entry"'));
  assert.equal(noScreen?.request?.body?.raw?.includes('"screen"'), false);

  const legacy = requests.find((request) => request.name === 'Formato legado AccessPass');
  assert.ok(legacy?.request?.body?.raw?.includes('"screen": "AccessPass"'));

  const batchVisit = requests.find((request) => request.name === 'Crear lote de visita (entrada)');
  assert.ok(batchVisit?.request?.body?.raw?.includes('"type": "visit_entry"'));
  assert.ok(batchVisit?.request?.body?.raw?.includes('"devices"'));

  const splash = requests.find((request) => request.name === 'Aviso sin screen (Splash por defecto)');
  assert.equal(splash?.request?.body?.raw?.includes('"screen"'), false);
  assert.equal(splash?.request?.body?.raw?.includes('"data"'), false);

  const panic = requests.find((request) => request.name === 'Pánico (ejemplo)');
  assert.ok(panic?.request?.body?.raw?.includes('"type": "panic"'));
  assert.ok(panic?.request?.body?.raw?.includes('"sound": "{{panicSound}}"'));
  assert.ok(panic?.request?.body?.raw?.includes('"channelId": "{{panicChannel}}"'));
  assert.ok(panic?.request?.body?.raw?.includes('"interruptionLevel": "{{interruptionLevel}}"'));
  assert.ok(panic?.request?.body?.raw?.includes('"residenceId": "{{residenceId}}"'));

  const panicBatch = requests.find((request) => request.name === 'Crear lote de pánico (guardias)');
  assert.ok(panicBatch?.request?.body?.raw?.includes('"type": "panic"'));
  assert.ok(panicBatch?.request?.body?.raw?.includes('"sound": "{{panicSound}}"'));
  assert.ok(panicBatch?.request?.body?.raw?.includes('"channelId": "{{panicChannel}}"'));
  assert.ok(panicBatch?.request?.body?.raw?.includes('"interruptionLevel": "{{interruptionLevel}}"'));
  assert.ok(panicBatch?.request?.body?.raw?.includes('"devices"'));
});
