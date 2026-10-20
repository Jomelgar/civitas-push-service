import { createApiKey, deleteApiKey, getApiKey, listApiKeys } from '../db/api-keys';
import { generateApiKey, validIpEntry } from '../services/api-keys';

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token?.startsWith('--')) continue;
    const key = token.slice(2);
    const value = args[i + 1] && !args[i + 1]?.startsWith('--') ? args[i + 1] : '';
    if (value) i += 1;
    flags[key] = value ?? '';
  }
  return flags;
}

function usage(): void {
  console.log(`Uso:
  npm run api-key:create -- --name "App móvil" [--ips "1.2.3.4,10.0.0.0/8"]
  npm run api-key:list
  npm run api-key:revoke -- <id>`);
}

function commandCreate(args: string[]): void {
  const flags = parseFlags(args);
  const name = (flags.name ?? '').trim();
  if (!name) {
    console.error('Falta --name (nombre descriptivo de la clave).');
    usage();
    process.exitCode = 1;
    return;
  }

  const allowedIps = (flags.ips ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .join(',');

  const { key, prefix, keyHash } = generateApiKey();
  if (allowedIps && !allowedIps.split(',').every(validIpEntry)) {
    console.error('IPs o CIDR inválidos.');
    process.exitCode = 1;
    return;
  }
  const row = createApiKey({ name, prefix, keyHash, allowedIps });

  console.log('API key creada. Guárdala ahora: no se volverá a mostrar.\n');
  console.log(`  id:       ${row.id}`);
  console.log(`  nombre:   ${row.name}`);
  console.log(`  prefijo:  ${row.prefix}`);
  console.log(`  IPs:      ${row.allowed_ips || '(cualquiera)'}`);
  console.log(`  API key:  ${key}`);
}

function commandList(): void {
  const keys = listApiKeys();
  if (keys.length === 0) {
    console.log('No hay API keys registradas.');
    return;
  }
  for (const row of keys) {
    console.log(
      `${row.id}  ${row.prefix}…  ${row.enabled === 1 ? 'activa' : 'revocada'}  ` +
        `ips=${row.allowed_ips || '*'}  creada=${row.created_at}  usada=${row.last_used_at ?? 'nunca'}  ${row.name}`,
    );
  }
}

function commandRevoke(args: string[]): void {
  const id = args.find((arg) => !arg.startsWith('--'))?.trim();
  if (!id) {
    console.error('Falta el id de la clave a eliminar.');
    usage();
    process.exitCode = 1;
    return;
  }
  if (!getApiKey(id)) {
    console.error(`No existe una API key con id ${id}.`);
    process.exitCode = 1;
    return;
  }
  deleteApiKey(id);
  console.log(`API key ${id} eliminada.`);
}

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case 'create':
    commandCreate(rest);
    break;
  case 'list':
    commandList();
    break;
  case 'revoke':
    commandRevoke(rest);
    break;
  default:
    usage();
    if (command) process.exitCode = 1;
}
