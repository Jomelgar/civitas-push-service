import { db } from './client';

export interface DeviceRow {
  id: string;
  expo_token: string;
  platform: string;
  enabled: number;
  created_at: string;
  updated_at: string;
  last_seen_at: string;
}

const now = () => new Date().toISOString();

export function upsertDevice(input: {
  id: string;
  token: string;
  platform?: string;
}): void {
  const timestamp = now();
  db.prepare(
    `INSERT INTO devices (id, expo_token, platform, enabled, created_at, updated_at, last_seen_at)
     VALUES (?, ?, ?, 1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       expo_token = excluded.expo_token,
       platform = COALESCE(?, devices.platform),
       enabled = 1,
       updated_at = excluded.updated_at,
       last_seen_at = excluded.last_seen_at`,
  ).run(
    input.id,
    input.token,
    input.platform ?? 'unknown',
    timestamp,
    timestamp,
    timestamp,
    input.platform ?? null,
  );
}

export function getDevice(id: string): DeviceRow | undefined {
  return db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as unknown as
    | DeviceRow
    | undefined;
}

export function listDevices(): DeviceRow[] {
  return db
    .prepare('SELECT * FROM devices ORDER BY last_seen_at DESC')
    .all() as unknown as DeviceRow[];
}

export function listEnabledDevices(): DeviceRow[] {
  return db
    .prepare('SELECT * FROM devices WHERE enabled = 1')
    .all() as unknown as DeviceRow[];
}

export function deleteDevice(id: string): void {
  db.prepare('DELETE FROM devices WHERE id = ?').run(id);
}

export function disableDevice(id: string): void {
  db.prepare('UPDATE devices SET enabled = 0, updated_at = ? WHERE id = ?').run(now(), id);
}
