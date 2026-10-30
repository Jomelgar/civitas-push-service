import { apiKeysPanel, apiKeysScript } from './api-keys';
import { batchesPanel, batchesScript } from './batches';
import {
  appShell,
  baseCss,
  shellCss,
  shellScript,
  themeInitScript,
  themeToggleScript,
} from './layout';

function notifyPanel(): string {
  return `        <section class="tab-panel" id="panel-notify" role="tabpanel" aria-label="Notificación">
          <div class="card panel">
            <h2>Enviar notificación</h2>
            <form id="notify-form">
              <fieldset class="fieldset">
                <legend>Plantillas de visita</legend>
                <div class="template-actions">
                  <button type="button" class="ghost" data-template="created">Visita creada</button>
                  <button type="button" class="ghost" data-template="entry">Entrada</button>
                  <button type="button" class="ghost" data-template="exit">Salida</button>
                </div>
                <p class="muted small">Precargan el tipo, estado, pantalla, título, mensaje y la fecha actual.</p>
              </fieldset>

              <fieldset class="fieldset">
                <legend>Destino</legend>
                <label>Device ID
                  <input id="deviceId" required placeholder="device-123" />
                </label>
                <label>Expo Token
                  <input id="token" required placeholder="ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]" />
                </label>
                <label class="checkbox">
                  <input id="saveDevice" type="checkbox" />
                  <span>Guardar dispositivo <span class="muted small">(opcional · por defecto no se guarda)</span></span>
                </label>
                <p class="muted small">Si está desmarcado, el push se envía igual pero el dispositivo no aparece en la lista.</p>
              </fieldset>

              <fieldset class="fieldset">
                <legend>Contenido</legend>
                <div class="row">
                  <label>Título <span class="muted small">(opcional)</span>
                    <input id="title" placeholder="Notificación" />
                  </label>
                  <label>URL <span class="muted small">(opcional · deep link, no cambia la pantalla)</span>
                    <input id="url" placeholder="/visitas/..." />
                  </label>
                </div>
                <label>Mensaje
                  <textarea id="message" required placeholder="Escribe el cuerpo de la notificación..."></textarea>
                </label>
              </fieldset>

              <fieldset class="fieldset">
                <legend>Enrutamiento en la app</legend>
                <div class="row">
                  <label>Tipo <span class="muted small">(opcional)</span>
                    <input id="type" list="notify-type-options" placeholder="visit_entry" />
                  </label>
                  <label>Pantalla <span class="muted small">(opcional · vacío = automática: VisitStatus o Splash)</span>
                    <input id="screen" list="notify-screen-options" placeholder="VisitStatus" />
                  </label>
                </div>
                <div class="row">
                  <label>Estado de visita <span class="muted small">(opcional)</span>
                    <select id="status">
                      <option value="">Sin estado</option>
                      <option value="pending">pending · aún no ingresa</option>
                      <option value="inside">inside · dentro</option>
                      <option value="outside">outside · fuera</option>
                    </select>
                  </label>
                  <label>Fecha del evento <span class="muted small">(opcional)</span>
                    <input id="occurredAt" type="datetime-local" />
                  </label>
                </div>
                <div class="row">
                  <label>Visitante <span class="muted small">(opcional)</span>
                    <input id="visitor" placeholder="Juan Pérez" />
                  </label>
                  <label>Propiedad <span class="muted small">(opcional)</span>
                    <input id="propertyLabel" placeholder="Casa 4" />
                  </label>
                </div>
                <div class="row">
                  <label>Visit ID <span class="muted small">(opcional)</span>
                    <input id="visitId" placeholder="VIS-0001" />
                  </label>
                  <label>Property ID <span class="muted small">(opcional)</span>
                    <input id="propertyId" type="number" placeholder="456" />
                  </label>
                </div>
                <div class="row">
                  <label>Residence ID <span class="muted small">(opcional)</span>
                    <input id="residenceId" placeholder="2" />
                  </label>
                  <label>Prioridad <span class="muted small">(opcional)</span>
                    <select id="priority">
                      <option value="">Por defecto</option>
                      <option value="default">default</option>
                      <option value="normal">normal</option>
                      <option value="high">high</option>
                    </select>
                  </label>
                </div>
                <label>Canal <span class="muted small">(opcional · p. ej. panic_alarm)</span>
                  <input id="channelId" placeholder="default" />
                </label>
                <datalist id="notify-type-options">
                  <option value="visit_created"></option>
                  <option value="visit_entry"></option>
                  <option value="visit_exit"></option>
                  <option value="panic"></option>
                </datalist>
                <datalist id="notify-screen-options">
                  <option value="VisitStatus"></option>
                  <option value="Splash"></option>
                  <option value="Home"></option>
                  <option value="AccessPass"></option>
                  <option value="SecurityDashboard"></option>
                </datalist>
              </fieldset>

              <div class="payload-preview">
                <div class="muted small">Payload que se enviará</div>
                <pre id="payload-preview">{}</pre>
              </div>

              <button type="submit">Enviar ahora</button>
              <div id="result" class="toast"></div>
            </form>
          </div>
        </section>`;
}

function devicesPanel(): string {
  return `        <section class="tab-panel" id="panel-devices" role="tabpanel" aria-label="Dispositivos" hidden>
          <div class="card panel">
            <h2>Dispositivos registrados</h2>
            <div class="toolbar">
              <input id="device-search" type="search" placeholder="Buscar por Device ID..." />
              <button type="button" class="ghost" id="devices-refresh" style="width:auto; white-space:nowrap;">Actualizar</button>
            </div>
            <p class="muted small" style="margin-bottom:0.9rem;">Haz clic en un dispositivo para autocompletar el formulario de notificación.</p>
            <div id="devices" class="devices">
              <p class="muted small empty">Cargando...</p>
            </div>
          </div>
        </section>`;
}

function dashboardScript(): string {
  return `<script>
    (function () {
      var form = document.getElementById('notify-form');
      var result = document.getElementById('result');
      var devicesEl = document.getElementById('devices');
      var searchEl = document.getElementById('device-search');
      var refreshEl = document.getElementById('devices-refresh');
      var previewEl = document.getElementById('payload-preview');
      var allDevices = [];
      var requestKey = null;
      var requestBody = null;
      var submitButton = form.querySelector('button[type="submit"]');
      var templates = {
        created: {
          type: 'visit_created', status: 'pending', title: 'Visita registrada',
          message: 'Se registró una visita en tu propiedad.'
        },
        entry: {
          type: 'visit_entry', status: 'inside', title: 'Entrada registrada',
          message: 'El visitante ingresó a tu propiedad.'
        },
        exit: {
          type: 'visit_exit', status: 'outside', title: 'Salida registrada',
          message: 'El visitante salió de tu propiedad.'
        }
      };

      function value(id) {
        var node = document.getElementById(id);
        return node ? String(node.value || '').trim() : '';
      }

      function setValue(id, text) {
        var node = document.getElementById(id);
        if (node) node.value = text;
      }

      function localDateTimeValue() {
        var now = new Date();
        var pad = function (n) { return String(n).padStart(2, '0'); };
        return now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) +
          'T' + pad(now.getHours()) + ':' + pad(now.getMinutes());
      }

      function toIso(text) {
        if (!text) return '';
        var date = new Date(text);
        return isNaN(date.getTime()) ? text : date.toISOString();
      }

      function collectPayload() {
        var payload = {
          deviceId: value('deviceId'),
          token: value('token'),
          message: value('message')
        };
        var title = value('title');
        var url = value('url');
        if (title) payload.title = title;
        if (url) payload.url = url;

        var data = {};
        var type = value('type');
        var screen = value('screen');
        var visitId = value('visitId');
        var status = value('status');
        var visitor = value('visitor');
        var propertyLabel = value('propertyLabel');
        var occurredAt = toIso(value('occurredAt'));
        var propertyId = value('propertyId');
        var residenceId = value('residenceId');
        if (type) data.type = type;
        if (screen) data.screen = screen;
        if (visitId) data.visitId = visitId;
        if (status) data.status = status;
        if (visitor) data.visitor = visitor;
        if (propertyLabel) data.propertyLabel = propertyLabel;
        if (occurredAt) data.occurredAt = occurredAt;
        if (propertyId) data.propertyId = Number(propertyId);
        if (residenceId) data.residenceId = residenceId;
        if (Object.keys(data).length) payload.data = data;

        var priority = value('priority');
        var channelId = value('channelId');
        if (priority) payload.priority = priority;
        if (channelId) payload.channelId = channelId;

        var saveDevice = document.getElementById('saveDevice');
        if (saveDevice && saveDevice.checked) payload.saveDevice = true;
        return payload;
      }

      function updatePreview() {
        if (!previewEl) return;
        previewEl.textContent = JSON.stringify(collectPayload(), null, 2);
      }

      function applyTemplate(name) {
        var template = templates[name];
        if (!template) return;
        setValue('type', template.type);
        setValue('status', template.status);
        setValue('screen', 'VisitStatus');
        setValue('title', template.title);
        setValue('message', template.message);
        setValue('occurredAt', localDateTimeValue());
        updatePreview();
      }

      function loadJobs() {
        fetch('/api/jobs').then(function (res) {
          if (res.status === 401) { window.location.href = '/login'; return null; }
          if (!res.ok) throw new Error('queue_unavailable');
          return res.json();
        }).then(function (data) {
          if (!data) return;
          document.getElementById('queue-health').textContent = data.workerHealthy ? 'Procesador activo' : 'Procesador sin actividad reciente';
          var container = document.getElementById('queue-jobs');
          container.textContent = '';
          var labels = { queued: 'En cola', sending: 'Enviando', awaiting_receipt: 'Esperando recibo', accepted: 'Aceptada por proveedor', dead: 'Fallida' };
          data.jobs.forEach(function (job) {
            var row = el('div', 'device');
            row.appendChild(el('div', 'device-id', job.deviceId + ' · ' + labels[job.status]));
            row.appendChild(el('div', 'muted small', job.id + ' · Prioridad: ' + job.priority + ' · Intentos: ' + job.attempts + (job.error ? ' · ' + job.error : '')));
            if (job.status === 'dead' && job.deliveryMode !== 'immediate') {
              var retry = el('button', 'ghost', 'Reintentar');
              retry.type = 'button';
              retry.addEventListener('click', function () {
                if (!confirm('Reintentar esta solicitud puede duplicar un aviso si el resultado anterior fue incierto. ¿Continuar?')) return;
                retry.disabled = true;
                fetch('/api/jobs/' + job.id + '/retry', { method: 'POST' })
                  .then(function (res) { return res.json(); })
                  .then(function (result) {
                    if (!result.ok) show('err', result.error);
                    loadJobs();
                  }).catch(function () { show('err', 'No se pudo reintentar'); })
                  .finally(function () { retry.disabled = false; });
              });
              row.appendChild(retry);
            }
            container.appendChild(row);
          });
          if (!data.jobs.length) container.appendChild(el('p', 'muted small', 'Sin solicitudes.'));
        }).catch(function () {
          document.getElementById('queue-health').textContent = 'No se pudo consultar la cola';
        });
      }

      function show(kind, text) {
        result.className = 'toast show ' + kind;
        result.textContent = text;
      }

      function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
      }

      function fill(device) {
        document.getElementById('deviceId').value = device.deviceId;
        document.getElementById('token').value = device.token || '';
        window.location.hash = '#/notify';
        updatePreview();
        document.getElementById('message').focus();
      }

      function renderDevices() {
        var query = (searchEl && searchEl.value || '').trim().toLowerCase();
        var list = query
          ? allDevices.filter(function (d) { return (d.deviceId || '').toLowerCase().indexOf(query) !== -1; })
          : allDevices;
        devicesEl.innerHTML = '';
        if (!list || list.length === 0) {
          devicesEl.appendChild(el('p', 'muted small empty',
            allDevices.length === 0 ? 'Aún no hay dispositivos registrados.' : 'Sin resultados para la búsqueda.'));
          return;
        }
        list.forEach(function (device) {
          var row = el('div', 'device');
          row.appendChild(el('div', 'device-id', device.deviceId));
          var when = device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleString() : '';
          row.appendChild(el('div', 'muted small', (device.platform || 'unknown') + (when ? ' · ' + when : '')));
          row.addEventListener('click', function () { fill(device); });
          devicesEl.appendChild(row);
        });
      }

      function loadDevices() {
        fetch('/api/devices')
          .then(function (res) {
            if (res.status === 401) { window.location.href = '/login'; return null; }
            return res.json();
          })
          .then(function (data) {
            if (!data) return;
            allDevices = data.devices || [];
            renderDevices();
            if (window.__setBadge) window.__setBadge('badge-devices', allDevices.length);
          })
          .catch(function () {
            devicesEl.innerHTML = '';
            devicesEl.appendChild(el('p', 'muted small empty', 'No se pudieron cargar los dispositivos.'));
          });
      }

      if (searchEl) searchEl.addEventListener('input', renderDevices);
      if (refreshEl) refreshEl.addEventListener('click', loadDevices);
      form.addEventListener('input', updatePreview);
      form.addEventListener('change', updatePreview);
      Array.prototype.forEach.call(document.querySelectorAll('[data-template]'), function (button) {
        button.addEventListener('click', function () { applyTemplate(button.getAttribute('data-template')); });
      });

      form.addEventListener('submit', function (event) {
        event.preventDefault();
        var payload = collectPayload();
        var serialized = JSON.stringify(payload);
        if (requestBody !== serialized || !requestKey) {
          requestBody = serialized;
          requestKey = crypto.randomUUID();
        }
        submitButton.disabled = true;
        show('ok', 'Enviando a Expo...');
        fetch('/api/notify', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': requestKey },
          body: serialized
        })
          .then(function (res) {
            return res.json().then(function (data) { return { ok: res.ok, data: data }; });
          })
          .then(function (out) {
            if (out.ok && out.data.ok) {
              show('ok', out.data.sent === 0
                ? 'Sin capacidad inmediata. Notificación en cola: ' + out.data.job.id
                : 'Expo aceptó la notificación. Ticket: ' + out.data.ticketId);
              requestKey = null;
              loadJobs();
              loadDevices();
            } else {
              show('err', 'Error: ' + (out.data.error || 'desconocido'));
            }
          })
          .catch(function () {
            show('err', 'No se pudo contactar al servidor.');
          }).finally(function () { submitButton.disabled = false; });
      });

      updatePreview();
      loadDevices();
      loadJobs();
      setInterval(function () { if (!document.hidden) loadJobs(); }, 5000);
    })();
  </script>`;
}

export function dashboardPage(user: string): string {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Panel · Civitas Access</title>
  <link rel="icon" href="/assets/icon.png" />
  ${themeInitScript()}
  <style>
    ${baseCss}
    ${shellCss}
  </style>
</head>
<body>
  ${appShell({
    user,
    content: [notifyPanel(), batchesPanel(), devicesPanel(), apiKeysPanel()].join('\n'),
  })}
  ${dashboardScript()}
  ${batchesScript()}
  ${apiKeysScript()}
  ${shellScript()}
  ${themeToggleScript()}
</body>
</html>`;
}
