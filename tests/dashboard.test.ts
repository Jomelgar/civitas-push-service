import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Script, createContext } from 'node:vm';
import { dashboardPage } from '../src/web/dashboard';
import { batchesPanel, batchesScript } from '../src/web/batches';

test('dashboard queue scripts parse and show asynchronous state', () => {
  const html = dashboardPage('admin');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length > 0);
  for (const script of scripts) assert.doesNotThrow(() => new Script(script[1]!));
  assert.ok(html.includes('/api/jobs'));
  assert.ok(html.includes('Enviar ahora'));
  assert.ok(html.includes('panel-batches'));
  assert.ok(html.includes('/api/batches'));
  assert.ok(html.includes('batch-jobs-next'));
  assert.ok(html.includes('Notificación en cola:'));
});

test('batch screen loads progress, opens recipient details, paginates and refreshes', async () => {
  class Element {
    children: Element[] = [];
    style: Record<string, string> = {};
    hidden = false;
    disabled = false;
    value = 0;
    type = '';
    className = '';
    onclick?: () => void;
    handlers: Record<string, () => void> = {};
    private content = '';
    set textContent(value: string) { this.content = value; this.children = []; }
    get textContent() { return this.content; }
    appendChild(child: Element) { this.children.push(child); }
    setAttribute() {}
    addEventListener(name: string, handler: () => void) { this.handlers[name] = handler; }
  }
  const elements = new Map([...batchesPanel().matchAll(/id="([^"]+)"/g)].map(match => [match[1]!, new Element()]));
  const listeners: Record<string, (event: unknown) => void> = {};
  let interval: (() => void) | undefined;
  let progress = 50;
  const requests: string[] = [];
  const batch = () => ({ id: 'batch', name: 'Mantenimiento', status: 'processing', total: 60, processed: progress * 60 / 100,
    progress, counts: { queued: 30, sending: 0, awaiting_receipt: 20, accepted: 5, dead: 5 } });
  const context = createContext({
    document: { hidden: false, getElementById: (id: string) => elements.get(id), createElement: () => new Element(),
      addEventListener: (name: string, handler: (event: unknown) => void) => { listeners[name] = handler; } },
    window: { location: { hash: '#/batches' } },
    setInterval: (callback: () => void) => { interval = callback; },
    fetch: async (url: string) => {
      requests.push(url);
      return { ok: true, status: 200, json: async () => url.startsWith('/api/batches?')
        ? { batches: [batch()], workerHealthy: true }
        : { batch: batch(), jobs: Array.from({ length: 25 }, (_, index) => ({ deviceId: `device-${index}`, status: 'dead', priority: 'high', attempts: 1, error: '<unsafe>' })) } };
    },
  });
  const script = batchesScript().replace(/^<script>/, '').replace(/<\/script>$/, '');
  new Script(script).runInContext(context);
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  listeners.routechange!({ detail: { route: '#/batches' } });
  await flush();
  assert.equal(elements.get('batches-health')?.textContent, 'Procesador activo');
  elements.get('batches-list')!.children[0]!.handlers.click!();
  await flush();
  assert.equal(elements.get('batch-progress')?.value, 50);
  assert.equal(elements.get('batch-title')?.textContent, 'Mantenimiento');
  assert.equal(elements.get('batch-jobs')!.children.length, 25);
  assert.equal(elements.get('batch-jobs')!.children[0]!.children[3]!.textContent, 'Alta');
  assert.equal(elements.get('batch-jobs')!.children[0]!.children[4]!.textContent, '<unsafe>');
  elements.get('batch-jobs-next')!.onclick!();
  await flush();
  assert.ok(requests.some(url => url.includes('/batch?limit=25&offset=25')));
  progress = 100;
  interval!();
  await flush();
  assert.equal(elements.get('batch-progress')?.value, 100);
});
