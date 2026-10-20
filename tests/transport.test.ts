import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExpoTransport, ExpoRequestError } from '../src/services/expo-push';

test('transport respects Retry-After and classifies permanent failures', async (context) => {
  const mocked = context.mock.method(globalThis, 'fetch', async () => new Response('', { status: 429, headers: { 'Retry-After': '60' } }));
  const transport = createExpoTransport();
  await assert.rejects(transport.send([{ to: 'ExponentPushToken[test]' }]), (error: unknown) =>
    error instanceof ExpoRequestError && error.retryable && error.retryAfterMs === 60_000);
  mocked.mock.mockImplementation(async () => new Response('', { status: 400 }));
  await assert.rejects(transport.send([{ to: 'ExponentPushToken[test]' }]), (error: unknown) =>
    error instanceof ExpoRequestError && !error.retryable);
});

test('transport rejects inconsistent tickets instead of losing queued jobs', async (context) => {
  context.mock.method(globalThis, 'fetch', async () => Response.json({ data: [] }));
  await assert.rejects(createExpoTransport().send([{ to: 'ExponentPushToken[test]' }]), /expo_invalid_tickets/);
});
