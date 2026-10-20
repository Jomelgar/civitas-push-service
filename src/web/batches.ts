export function batchesPanel(): string {
  return `<section class="tab-panel" id="panel-batches" role="tabpanel" aria-label="Lotes" hidden>
    <div class="card panel">
      <h2>Lotes de notificaciones</h2>
      <p id="batches-health" class="muted small" role="status"></p>
      <p class="muted small">Progreso del envío a Expo y resultados por dispositivo. Los recibos confirman aceptación por el proveedor.</p>
      <div id="batches-list" class="devices" aria-live="polite"></div>
      <div class="toolbar" style="margin-top:1rem;">
        <button type="button" class="ghost" id="batches-prev">Anteriores</button>
        <span id="batches-page" class="muted small"></span>
        <button type="button" class="ghost" id="batches-next">Siguientes</button>
      </div>
    </div>
    <div id="batch-detail" class="card panel" style="margin-top:1rem;" hidden>
      <h2 id="batch-title"></h2>
      <p id="batch-summary" role="status"></p>
      <progress id="batch-progress" max="100" value="0" style="width:100%;" aria-label="Progreso del envío"></progress>
      <p id="batch-counts" class="muted small"></p>
      <div style="overflow-x:auto;">
        <table style="width:100%;text-align:left;">
          <thead><tr><th>Dispositivo</th><th>Estado</th><th>Intentos</th><th>Prioridad</th><th>Resultado</th></tr></thead>
          <tbody id="batch-jobs"></tbody>
        </table>
      </div>
      <div class="toolbar" style="margin-top:1rem;">
        <button type="button" class="ghost" id="batch-jobs-prev">Anteriores</button>
        <span id="batch-jobs-page" class="muted small"></span>
        <button type="button" class="ghost" id="batch-jobs-next">Siguientes</button>
      </div>
    </div>
          <div class="card panel" style="margin-top:1rem;">
            <h2>Actividad reciente</h2>
            <p id="queue-health" class="muted small"></p>
            <p class="muted small">Últimas 50 solicitudes. Aceptada por el proveedor no confirma lectura ni entrega al teléfono.</p>
            <div id="queue-jobs" class="devices" aria-live="polite"></div>
          </div>
  </section>`;
}

export function batchesScript(): string {
  return `<script>
    (function () {
      var selected = null;
      var offset = 0;
      var jobsOffset = 0;
      var limit = 25;
      var generation = 0;
      var refreshing = false;
      var labels = {
        queued: 'En cola', processing: 'Procesando', sending: 'Enviando',
        awaiting_receipts: 'Esperando recibos', awaiting_receipt: 'Esperando recibo',
        completed: 'Completado', partial_failure: 'Completado con errores',
        failed: 'Fallido', dead: 'Fallida', accepted: 'Aceptada por proveedor'
      };
      function node(tag, value) {
        var element = document.createElement(tag);
        if (value !== undefined) element.textContent = value;
        return element;
      }
      function get(url) {
        return fetch(url).then(function (response) {
          if (response.status === 401) { window.location.href = '/login'; throw new Error('Sesión expirada'); }
          if (!response.ok) throw new Error('No se pudo consultar el estado de los lotes');
          return response.json();
        });
      }
      function detail() {
        if (!selected) return Promise.resolve();
        document.getElementById('batch-detail').hidden = false;
        var current = ++generation;
        var id = selected;
        var page = jobsOffset;
        return get('/api/batches/' + encodeURIComponent(id) + '?limit=' + limit + '&offset=' + page).then(function (data) {
          if (current !== generation || selected !== id || page !== jobsOffset) return;
          var batch = data.batch;
          document.getElementById('batch-detail').hidden = false;
          document.getElementById('batch-title').textContent = batch.name;
          document.getElementById('batch-summary').textContent = labels[batch.status] + ' · ' + batch.processed + '/' + batch.total + ' procesados (' + batch.progress + '%)';
          document.getElementById('batch-progress').value = batch.progress;
          document.getElementById('batch-counts').textContent = 'En cola: ' + batch.counts.queued + ' · Enviando: ' + batch.counts.sending + ' · Esperando recibo: ' + batch.counts.awaiting_receipt + ' · Aceptados: ' + batch.counts.accepted + ' · Fallidos: ' + batch.counts.dead;
          var body = document.getElementById('batch-jobs');
          body.textContent = '';
          data.jobs.forEach(function (job) {
            var row = node('tr');
            var priority = { high: 'Alta', normal: 'Normal', default: 'Predeterminada' };
            [job.deviceId, labels[job.status], job.attempts, priority[job.priority] || 'Predeterminada', job.error || '—'].forEach(function (value) { row.appendChild(node('td', value)); });
            body.appendChild(row);
          });
          document.getElementById('batch-jobs-prev').disabled = page === 0;
          document.getElementById('batch-jobs-next').disabled = page + data.jobs.length >= batch.total;
          document.getElementById('batch-jobs-page').textContent = (page + 1) + '–' + (page + data.jobs.length) + ' de ' + batch.total;
        }).catch(function (error) {
          if (current === generation) document.getElementById('batch-summary').textContent = error.message;
        });
      }
      function refresh() {
        if (refreshing) return;
        refreshing = true;
        var page = offset;
        get('/api/batches?limit=' + limit + '&offset=' + page).then(function (data) {
          if (page !== offset) return;
          document.getElementById('batches-health').textContent = data.workerHealthy ? 'Procesador activo' : 'Procesador sin actividad reciente';
          var list = document.getElementById('batches-list');
          list.textContent = '';
          data.batches.forEach(function (batch) {
            var item = node('button');
            item.type = 'button';
            item.className = 'ghost';
            item.style.textAlign = 'left';
            item.textContent = batch.name + ' · ' + labels[batch.status] + ' · ' + batch.progress + '% · ' + batch.total + ' dispositivos · ' + batch.id;
            item.setAttribute('aria-pressed', selected === batch.id ? 'true' : 'false');
            item.addEventListener('click', function () { selected = batch.id; jobsOffset = 0; detail(); });
            list.appendChild(item);
          });
          if (!data.batches.length) list.appendChild(node('p', 'No hay lotes en esta página.'));
          document.getElementById('batches-prev').disabled = page === 0;
          document.getElementById('batches-next').disabled = data.batches.length < limit;
          document.getElementById('batches-page').textContent = 'Página ' + (page / limit + 1);
          return detail();
        }).catch(function (error) {
          document.getElementById('batches-health').textContent = error.message;
        }).finally(function () { refreshing = false; });
      }
      document.getElementById('batches-prev').onclick = function () { offset = Math.max(0, offset - limit); refresh(); };
      document.getElementById('batches-next').onclick = function () { offset += limit; refresh(); };
      document.getElementById('batch-jobs-prev').onclick = function () { jobsOffset = Math.max(0, jobsOffset - limit); detail(); };
      document.getElementById('batch-jobs-next').onclick = function () { jobsOffset += limit; detail(); };
      document.addEventListener('routechange', function (event) { if (event.detail.route === '#/batches') refresh(); });
      setInterval(function () { if (!document.hidden && window.location.hash === '#/batches') refresh(); }, 5000);
    })();
  </script>`;
}
