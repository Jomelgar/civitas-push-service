import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = fileURLToPath(new URL('..', import.meta.url));
const envPath = resolve(projectDir, '.env');

if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const databasePath = process.env.DATABASE_PATH
  ? resolve(projectDir, process.env.DATABASE_PATH)
  : resolve(projectDir, 'data/push.sqlite');

const dataDir = dirname(databasePath);
const runtimeEnvPath = resolve(dataDir, 'runtime.env');

function parseEnvFile(path: string): Record<string, string> {
  const values: Record<string, string> = {};
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    return values;
  }

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

const runtimeSecrets = parseEnvFile(runtimeEnvPath);
const generatedSecrets: string[] = [];

function ensureSecret(name: string): string {
  const fromEnv = process.env[name]?.trim();
  if (fromEnv) return fromEnv;

  const stored = runtimeSecrets[name]?.trim();
  if (stored) return stored;

  const generated = randomBytes(32).toString('hex');
  runtimeSecrets[name] = generated;
  generatedSecrets.push(name);
  return generated;
}

const sessionSecret = ensureSecret('SESSION_SECRET');
const apiKeyPepper = ensureSecret('API_KEY_PEPPER');

if (generatedSecrets.length > 0) {
  mkdirSync(dataDir, { recursive: true });
  const body = `${Object.entries(runtimeSecrets)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')}\n`;
  writeFileSync(runtimeEnvPath, body, { mode: 0o600 });
  try {
    chmodSync(runtimeEnvPath, 0o600);
  } catch {
    /* ignore */
  }
  console.warn(
    `[config] generados y persistidos (${generatedSecrets.join(', ')}) en ${runtimeEnvPath}; ` +
      'defínelos en .env para fijarlos explícitamente.',
  );
}

function positiveInteger(name: string, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`Invalid configuration: ${name}`);
  return value;
}

export const config = {
  port: positiveInteger('PORT', 8790, 65535),
  databasePath,
  expoAccessToken: process.env.EXPO_ACCESS_TOKEN || undefined,
  adminUser: process.env.ADMIN_USER ?? 'admin',
  adminPassword: process.env.ADMIN_PASSWORD ?? '',
  sessionSecret,
  apiKeyPepper,
  corsOrigin: process.env.CORS_ORIGIN?.trim() ?? '',
  trustProxy: /^(1|true|yes)$/i.test(process.env.TRUST_PROXY ?? ''),
  isProduction: process.env.NODE_ENV === 'production',
  queueCapacity: positiveInteger('QUEUE_CAPACITY', 100_000),
  pushRate: positiveInteger('PUSH_RATE_PER_SECOND', 400, 500),
  pushMaxAttempts: positiveInteger('PUSH_MAX_ATTEMPTS', 8, 20),
  pushJobTtlSeconds: positiveInteger('PUSH_JOB_TTL_SECONDS', 86400, 604800),
};

const WEAK_PASSWORDS = new Set([
  'admin',
  'admin123',
  'administrador',
  'cambia-esto',
  'password',
  'changeme',
  '123456',
  'qwerty',
]);

export function assertSecureConfig(): void {
  const password = config.adminPassword;
  if (password.length < 12 || WEAK_PASSWORDS.has(password.toLowerCase())) {
    console.error(
      '[config] ADMIN_PASSWORD es obligatoria: define una contraseña de al menos 12 caracteres ' +
        'que no sea un valor por defecto (en .env).',
    );
    process.exit(1);
  }

  if (config.isProduction && config.corsOrigin === '*') {
    console.warn(
      '[config] CORS_ORIGIN="*" en producción; restíngelo a los orígenes que consumen /v1/*.',
    );
  }
}
