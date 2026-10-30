import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildMessage,
  notifySchema,
  resolveScreen,
  PANIC_CHANNEL,
  PANIC_INTERRUPTION_LEVEL,
  PANIC_SOUND,
  type NotifyInput,
} from '../src/services/notifications';

const base = {
  deviceId: 'visit-device',
  token: 'ExponentPushToken[visit-test]',
  message: 'Tienes una visita',
};

test('visit events default to VisitStatus and preserve visit data', () => {
  const input: NotifyInput = {
    ...base,
    data: {
      type: 'visit_entry',
      visitId: 'VIS-0001',
      status: 'inside',
      visitor: 'Juan Pérez',
      propertyLabel: 'Casa 4',
      occurredAt: '2026-10-27T14:32:00-06:00',
      propertyId: 456,
      residenceId: '2',
    },
  };
  const message = buildMessage(input);
  assert.equal(message.data?.screen, 'VisitStatus');
  assert.equal(message.data?.visitId, 'VIS-0001');
  assert.equal(message.data?.status, 'inside');
  assert.equal(message.data?.visitor, 'Juan Pérez');
  assert.equal(message.data?.propertyLabel, 'Casa 4');
  assert.equal('saveDevice' in message, false);
});

test('resolveScreen keeps explicit screens and handles panic and legacy payloads', () => {
  assert.equal(resolveScreen({ type: 'visit_created' }), 'VisitStatus');
  assert.equal(resolveScreen({ type: 'visit_registered' }), 'VisitStatus');
  assert.equal(resolveScreen({ type: 'visit_exit' }), 'VisitStatus');
  assert.equal(resolveScreen({ type: 'panic' }), 'SecurityDashboard');
  assert.equal(resolveScreen({ type: 'other' }), 'Splash');
  assert.equal(resolveScreen({ type: 'visit_entry', screen: 'AccessPass' }), 'AccessPass');
  assert.equal(resolveScreen({ screen: 'Home' }), 'Home');
  assert.equal(resolveScreen(), 'Splash');
});

test('saveDevice is not included in the Expo message', () => {
  const message = buildMessage({ ...base, saveDevice: true, data: { type: 'visit_exit', status: 'outside' } });
  assert.equal(message.data?.screen, 'VisitStatus');
  assert.equal('saveDevice' in message, false);
});

test('panic notifications default to the emergency sound, channel and interruption level', () => {
  const message = buildMessage({ ...base, data: { type: 'panic', residenceId: '2' } });
  assert.equal(message.sound, PANIC_SOUND);
  assert.equal(message.channelId, PANIC_CHANNEL);
  assert.equal(message.interruptionLevel, PANIC_INTERRUPTION_LEVEL);
  assert.equal(message.priority, 'high');
  assert.equal(message.data?.screen, 'SecurityDashboard');
});

test('panic notifications respect explicit sound, channel and interruption level', () => {
  const message = buildMessage({
    ...base,
    sound: 'custom-alarm.caf',
    channelId: 'custom-channel',
    interruptionLevel: 'passive',
    data: { type: 'panic' },
  });
  assert.equal(message.sound, 'custom-alarm.caf');
  assert.equal(message.channelId, 'custom-channel');
  assert.equal(message.interruptionLevel, 'passive');
  assert.equal(message.data?.screen, 'SecurityDashboard');
});

test('regular notifications keep the default sound and do not inherit panic settings', () => {
  const message = buildMessage({ ...base, data: { type: 'visit_entry' } });
  assert.equal(message.sound, 'default');
  assert.equal('channelId' in message, false);
  assert.equal('interruptionLevel' in message, false);
  assert.equal('priority' in message, false);
});

test('custom sound names are validated', () => {
  assert.equal(notifySchema.safeParse({ ...base, sound: 'panic.wav' }).success, true);
  assert.equal(notifySchema.safeParse({ ...base, sound: 'panic.caf' }).success, true);
  assert.equal(notifySchema.safeParse({ ...base, sound: '../panic.wav' }).success, false);
  assert.equal(notifySchema.safeParse({ ...base, sound: 'panic.mp3' }).success, false);
  assert.equal(notifySchema.safeParse({ ...base, sound: 'panic.wav ' }).success, false);
});
