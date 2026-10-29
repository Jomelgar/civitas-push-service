# Civitas Access · Push persistente

Servicio de notificaciones Expo con API autenticada, cola durable en SQLite, worker integrado y panel de operación. Requiere Node.js 24 o superior.

## Flujo

1. `POST /v1/notify` envía a un dispositivo durante la petición HTTP y responde `200 { ok: true, sent: 1, ticketId, job }` cuando Expo acepta el mensaje. Si el regulador está ocupado, persiste la notificación individual en la cola y responde `202 { ok: true, sent: 0, job }`. El worker la procesa con los mismos límites y reintentos que los trabajos de lote.
2. `POST /v1/batches` valida y persiste un lote de 1 a 1000 dispositivos en una transacción. Responde `202 Accepted` con `batch.id` sin contactar a Expo.
3. El worker procesa los trabajos del lote en grupos de hasta 100 mensajes, con reintentos y ritmo regulado. El envío individual reserva capacidad en el mismo regulador: si está ocupado, guarda un trabajo pendiente sin consumir un intento de envío.
4. Ambos flujos conservan tickets para consultar recibos a partir de los 15 minutos. Los recibos confirman la aceptación por FCM/APNs, no la recepción en el teléfono.
5. El panel incluye **Lotes** en `/#/batches`, con progreso, cantidades por estado, errores y paginación por dispositivo.

Una instalación debe enviar tokens de **un solo proyecto Expo**. No mezcles proyectos en esta cola: Expo exige que cada lote pertenezca al mismo proyecto. Todas las instancias que envían para ese proyecto deben compartir esta base de datos, o coordinar su presupuesto de envío externamente. El límite no incluye otros servicios que envíen directamente a Expo.

## Instalación

```bash
npm ci
cp .env.example .env
npm run typecheck
npm test
npm run dev
```

Configura una contraseña administrativa propia antes de arrancar. Para producción: `npm start`, detrás de HTTPS, con `NODE_ENV=production`.

| Variable | Predeterminado | Uso |
| --- | --- | --- |
| `PORT` | `8790` | Puerto HTTP |
| `DATABASE_PATH` | `./data/push.sqlite` | Base durable |
| `ADMIN_USER` | `admin` | Usuario del panel |
| `ADMIN_PASSWORD` | — | Obligatoria, al menos 12 caracteres |
| `SESSION_SECRET` | Autogenerado | Firma de sesiones |
| `API_KEY_PEPPER` | Autogenerado | HMAC de API keys; cambiarlo invalida las claves |
| `EXPO_ACCESS_TOKEN` | — | Enhanced Push Security de Expo |
| `QUEUE_CAPACITY` | `100000` | Máximo de trabajos pendientes, enviándose o esperando recibo |
| `PUSH_RATE_PER_SECOND` | `400` | Ritmo objetivo, configurable entre 1 y 500 |
| `PUSH_MAX_ATTEMPTS` | `8` | Intentos de envío, máximo configurable de 20 |
| `PUSH_JOB_TTL_SECONDS` | `86400` | Edad máxima para iniciar otro envío, máximo de 7 días |
| `TRUST_PROXY` | `false` | Habilita lectura de cabeceras de IP del proxy |
| `CORS_ORIGIN` | Vacío | Origen autorizado para clientes web |

Los secretos omitidos se generan en `runtime.env`, junto a la base de datos. Protege y respalda ese directorio. No uses los valores de ejemplo como secretos de producción.

`TRUST_PROXY=true` requiere que el proxy sobrescriba las cabeceras de IP y que el puerto de la aplicación no sea accesible directamente por clientes no confiables.

## API

Las rutas `/v1/*` requieren `X-API-Key` o `Authorization: Bearer`. Las claves se administran en el panel o mediante la CLI:

```bash
npm run api-key:create -- --name "Backend Civitas" --ips "10.0.0.0/8"
npm run api-key:list
npm run api-key:revoke -- <id>
```

Las claves son credenciales de servidor con acceso a los dispositivos. No deben distribuirse en una aplicación móvil pública.

### Notificación individual inmediata

```http
POST /v1/notify
Content-Type: application/json
X-API-Key: cva_...
Idempotency-Key: visita-123-aviso-1

{
  "deviceId": "device-123",
  "token": "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]",
  "title": "Entrada registrada",
  "message": "Juan Pérez ingresó a tu propiedad",
  "data": {
    "type": "visit_entry",
    "screen": "VisitStatus",
    "visitId": "VIS-0001",
    "status": "inside",
    "visitor": "Juan Pérez",
    "propertyLabel": "Casa 4",
    "occurredAt": "2026-10-27T14:32:00-06:00",
    "propertyId": 456,
    "residenceId": 2
  },
  "priority": "high",
  "saveDevice": false
}
```

La respuesta exitosa es `200` con `sent: 1`, `ticketId` y `job` en estado `awaiting_receipt`. Si no hay capacidad local, responde `202` con `sent: 0` y `job.id`. Un `429` de Expo o un ticket `MessageRateExceeded` también difiere el mismo trabajo y respeta el periodo de espera. Otros fallos de Expo devuelven `502`; un envío sin resultado confirmado queda fallido. `GET /v1/notify/{id}` permite consultar sus recibos.

También admite `url` y `channelId`. El campo `screen` toma `Splash` si se omite, salvo para eventos de visita: `visit_created`, `visit_registered`, `visit_entry` y `visit_exit` abren `VisitStatus`; `panic` abre `SecurityDashboard`. El cuerpo HTTP individual está limitado a 16 KiB y el mensaje serializado para Expo a 4096 bytes, incluyendo datos adicionales. Expo o el proveedor pueden rechazar un mensaje por sus propios límites de codificación.

| Campo de `data` | Uso |
| --- | --- |
| `type` | Evento: `visit_created`, `visit_entry`, `visit_exit`, `panic`, etc. |
| `screen` | Pantalla destino en la app. Si falta, se resuelve por `type`. |
| `visitId` | Código de la visita. |
| `status` | `pending`, `inside` o `outside`. |
| `visitor` | Nombre del visitante para mostrar en la pantalla. |
| `propertyLabel` | Etiqueta legible de la propiedad (p. ej. “Casa 4”). |
| `occurredAt` | Fecha/hora ISO del evento. |

`saveDevice` es opcional y por defecto `false`: el push se envía sin guardar ni actualizar el dispositivo. Con `true` se hace upsert en `devices` y se reactiva el token si estaba retirado, igual que `POST /v1/devices`. Los lotes conservan su comportamiento actual y guardan sus dispositivos.

`Idempotency-Key` es opcional, de 1 a 128 caracteres. Reutilizarla con el mismo contenido y la misma API key devuelve el resultado registrado sin reenviar; si el envío está en curso devuelve `409 notification_in_progress`; con otro contenido devuelve `409`. Usa el mismo valor al reintentar una solicitud cuyo resultado HTTP sea incierto. La deduplicación dura mientras se conserva el trabajo.

| Código | Significado |
| --- | --- |
| `200` | Expo aceptó la notificación individual |
| `202` | Lote persistido o notificación individual diferida por falta de capacidad |
| `400` | Datos, token o tamaño de mensaje inválidos; token retirado |
| `401` / `403` | Autenticación o restricción de IP |
| `409` | Conflicto de idempotencia |
| `413` | Cuerpo HTTP demasiado grande |
| `502` | Error en el envío inmediato a Expo |
| `503` | Cola llena; reintentar después del intervalo indicado |

### Lotes persistentes

`POST /v1/batches` recibe el contenido común y los destinatarios:

```json
{
  "name": "Aviso de mantenimiento",
  "title": "Civitas",
  "message": "El acceso estará cerrado de 9 a 10",
  "data": { "screen": "Home" },
  "devices": [
    { "deviceId": "device-1", "token": "ExponentPushToken[uno]" },
    { "deviceId": "device-2", "token": "ExponentPushToken[dos]", "data": { "propertyId": 456 } }
  ]
}
```

Requiere API key y admite `Idempotency-Key`. El cuerpo está limitado a 1 MiB y a 1000 dispositivos. Se rechazan identificadores o tokens repetidos. Cada mensaje debe cumplir el límite de 4096 bytes. `data` por dispositivo se combina con los datos comunes, dando prioridad al destinatario. El registro del lote es atómico: un token inválido, un token retirado o capacidad insuficiente rechazan el lote completo.

La respuesta es `202 { ok: true, batch }` y `Location: /v1/batches/{id}`. `batch` incluye `id`, `name`, `total`, `status`, `counts`, `processed`, `finished`, `progress` y `createdAt`.

- `GET /v1/batches?limit=50&offset=0`: listar lotes de la API key actual.
- `GET /v1/batches/{id}`: consultar progreso y cantidades por estado.
- `GET /v1/batches/{id}/jobs?limit=50&offset=0`: consultar resultados por dispositivo; máximo 100 registros por página.

Un lote ajeno devuelve `404`. El panel administrativo puede consultar todos los lotes mediante sesión. La idempotencia de lotes es independiente de la individual y se conserva hasta depurar el lote completo.

`progress` mide qué proporción salió de la etapa de envío, incluidos los fallos definitivos. Puede llegar al 100% mientras aún faltan recibos. `finished` cuenta aceptados por el proveedor más fallidos. Los estados del lote son `queued`, `processing`, `awaiting_receipts`, `completed`, `partial_failure` y `failed`.

### Seguimiento

`GET /v1/notify/{id}` devuelve el estado del trabajo. Solo la API key que lo creó puede consultarlo; los trabajos ajenos devuelven `404`. La respuesta no expone el token ni el contenido.

| Estado | Significado |
| --- | --- |
| `queued` | Pendiente o esperando el siguiente intento |
| `sending` | Intento en curso |
| `awaiting_receipt` | Expo aceptó el mensaje; falta consultar el recibo |
| `accepted` | El recibo confirma aceptación por FCM/APNs, no lectura ni recepción en el teléfono |
| `dead` | Error definitivo, intentos agotados, expiración o recibo no disponible |

### Dispositivos y operación

- `GET /v1/devices`: listar dispositivos.
- `POST /v1/devices`: registrar o actualizar `deviceId`, `token` y `platform` opcional.
- `POST /v1/devices/sync`: compatibilidad; ignora `items`.
- `DELETE /v1/devices/{id}`: eliminar el registro; no cancela trabajos ya encolados.
- `GET /health`: disponibilidad HTTP.
- `GET /ready`: comprueba acceso a SQLite y heartbeat reciente del worker; devuelve `503` si falta actividad.
- `/doc` y `/ui`: OpenAPI y Swagger, con sesión administrativa.

Un error `DeviceNotRegistered` retira el token, deshabilita sus dispositivos y termina trabajos pendientes para ese token. Un nuevo registro explícito del dispositivo permite volver a utilizarlo. Enviar una notificación no borra la plataforma ni simula una conexión del dispositivo.

## Panel

En `/login` se inicia la sesión administrativa. El panel permite enviar una notificación individual inmediata, gestionar claves y consultar lotes desde la sección **Lotes**. La lista y el detalle tienen paginación, cantidades por estado, porcentaje y resultados por dispositivo. Se actualizan cada cinco segundos mientras esa sección está visible. La actividad reciente conserva acceso a los últimos 50 trabajos y a reintentos manuales de trabajos en cola.

Las rutas `/api/batches` y `/api/batches/{id}` muestran los lotes con sesión administrativa. Las operaciones `/api/jobs`, `/api/jobs/{id}` y `POST /api/jobs/{id}/retry` requieren sesión; las mutaciones validan origen. Los individuales que se difieren por capacidad se procesan y se pueden reintentar como trabajos en cola. Los que se enviaron directamente conservan su seguimiento de recibos. Reintentar un trabajo de lote mantiene el identificador y reinicia el presupuesto de intentos. Los trabajos expirados requieren una nueva solicitud. Los tokens retirados requieren un nuevo registro antes de reintentar.

El formulario de notificación incluye plantillas **Visita creada**, **Entrada** y **Salida** que precargan `type`, `status`, `screen`, título, mensaje y `occurredAt`. También muestra una vista previa del payload antes de enviarlo. La casilla **Guardar dispositivo** está desmarcada por defecto; si se marca, el envío registra el dispositivo como lo haría `POST /v1/devices`.

## Colección Postman

`postman_collection.json` concentra toda la API. La carpeta **Notify → Visitas** incluye:

- `Visita creada`, `Entrada registrada` y `Salida registrada` sin guardar el dispositivo.
- `Notificar y guardar dispositivo` con `saveDevice: true`.
- Una prueba de `visit_entry` sin `screen` para validar la resolución automática a `VisitStatus`.
- Un aviso sin `data`/`screen` para validar el destino `Splash` por defecto.
- El formato legado que abre `AccessPass`.

La carpeta **Lotes** incluye un lote con datos de visita (`Crear lote de visita (entrada)`) además del aviso general.

La carpeta **Devices** incluye verificaciones para confirmar si el dispositivo se guardó o no. Las variables `visitId`, `propertyId`, `residenceId`, `visitor`, `propertyLabel`, `occurredAt` y `jobId` están preconfiguradas; `occurredAt` se actualiza automáticamente antes de cada request.

## Prioridad de procesamiento

El campo `priority` de las notificaciones individuales y de los lotes controla tanto la selección de trabajos en la cola como la prioridad enviada a Expo:

| Valor | Orden en la cola |
| --- | --- |
| `high` | Primero |
| `normal` | Después de `high` |
| `default` o sin valor | Después de `normal` |

El worker selecciona hasta 100 trabajos disponibles por prioridad y conserva el orden de llegada dentro del mismo nivel. Si varios trabajos tienen la misma fecha de creación, usa su orden de inserción. Los reintentos conservan su prioridad, pero no se seleccionan antes de que termine su periodo de espera. La selección es global: un aviso urgente puede adelantarse a trabajos normales de otros lotes o a notificaciones individuales diferidas.

La prioridad se aplica al seleccionar el siguiente grupo; no interrumpe envíos en curso. `/v1/notify` sigue intentando enviar inmediatamente cuando hay capacidad. Si debe encolarse, conserva la prioridad indicada. Las respuestas de seguimiento y el panel muestran la prioridad de cada trabajo.

Al actualizar, la migración recupera la prioridad de los mensajes ya almacenados sin modificar su contenido ni sus claves de idempotencia. Los mensajes antiguos sin prioridad se procesan como `default`.

## Garantías y recuperación

SQLite usa WAL, `synchronous=FULL`, transacciones de escritura y espera de bloqueo de cinco segundos. La aceptación HTTP ocurre después del commit. Las tablas de la cola se crean sin eliminar dispositivos ni claves existentes.

Un lease de 120 segundos coordina los workers sobre la misma base. Las peticiones a Expo tienen timeout de 20 segundos y se realizan secuencialmente. El ritmo y los tiempos de reintento se persisten, incluidos los periodos de espera por `429`. Los workers que pierden su lease descartan resultados tardíos. Los trabajos de cola interrumpidos se recuperan cuando otro worker adquiere el lease. Los individuales que ya estaban enviándose directamente y se interrumpen se marcan con resultado desconocido al vencer su reserva de 120 segundos y nunca se convierten en envíos pendientes.

La semántica de los trabajos en cola, incluidos individuales diferidos, es **al menos una vez**: si Expo acepta un mensaje y el proceso cae antes de guardar el ticket, puede enviarse otra vez. La idempotencia HTTP evita duplicar el trabajo, pero no elimina esa incertidumbre externa. Para eventos sensibles, incluye un identificador de evento en `data` y deduplica también en la app receptora.

Los recibos ausentes se vuelven a consultar cada minuto durante un máximo de 23 horas desde el ticket. Los trabajos individuales terminales se conservan 30 días desde su última actualización. Los lotes se depuran completos cuando todos sus trabajos son terminales y llevan al menos 30 días sin actualización; no se eliminan resultados parciales de un lote activo. Los tokens retirados se conservan hasta su registro explícito. Los datos pendientes incluyen tokens y contenido: protege el volumen, las copias y el acceso al host.

Este diseño funciona en un host con disco local durable. No montar SQLite WAL en NFS ni tratar copias independientes de la base como una cola compartida. No proporciona alta disponibilidad entre hosts. Para ese requisito haría falta migrar el almacenamiento y la coordinación a un servicio compartido apropiado.

## Docker y actualización

```bash
docker compose up --build -d
```

Ambos archivos Compose construyen el código local. El volumen `./data` conserva la base y los secretos. Ajusta `CIVITAS_UID` y `CIVITAS_GID` para dar escritura al usuario del contenedor. El cierre dispone de 60 segundos y espera las operaciones en curso. El healthcheck usa `/ready`.

Antes de actualizar, detén el servicio y copia el directorio `data` completo. Para restaurar, detén el servicio, recupera esa copia y arranca. Antes de volver a una versión sin cola, drena los pendientes: la versión anterior no procesa estas tablas. Restaurar una copia antigua puede repetir envíos cuyo estado no esté incluido en ella.

**Contrato actual:** `/v1/notify` intenta enviar inmediatamente con `200 { sent: 1 }` y difiere con `202 { sent: 0, job }` cuando no hay capacidad. Ambos resultados incluyen `Location` para consultar `/v1/notify/{id}`. Si la cola está llena responde `503 queue_full` y no acepta el trabajo. Las integraciones que necesitan procesamiento persistente deben usar `/v1/batches` y seguir `batch.id`. Los trabajos en cola de la versión anterior se conservan y siguen procesándose. La colección Postman y el panel reflejan ambos flujos.

## Verificación

```bash
npm run typecheck
npm test
```

Las pruebas utilizan bases temporales y transportes simulados: persistencia, transacciones, deduplicación, capacidad, exclusión entre conexiones, recuperación, ritmo, tickets, recibos, errores, aislamiento de acceso y validación. No realizan envíos reales a Expo.

Límites y recomendaciones de referencia: [documentación oficial de Expo](https://docs.expo.dev/push-notifications/sending-notifications/) y [FAQ de límites](https://docs.expo.dev/push-notifications/faq/).
