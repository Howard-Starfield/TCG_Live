import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchRoomRenameRest, privateDiscordClient, privateDiscordRest } from './sdk.js';

test('private Discord Gateway and registration REST disable ambiguous SDK retries', () => {
  const client = privateDiscordClient();
  const registration = privateDiscordRest('synthetic-token');
  assert.equal(client.rest.options.retries, 0);
  assert.equal(registration.options.retries, 0);
  client.destroy();
});

test('room renames use their own REST instance that rejects on a rate limit instead of waiting, and the client REST does not', () => {
  const rename = matchRoomRenameRest('synthetic-token');
  const rejectOnRateLimit = rename.options.rejectOnRateLimit as (data: unknown) => boolean;
  assert.equal(typeof rejectOnRateLimit, 'function');
  assert.equal(rejectOnRateLimit({ route: '/channels/:id' }), true);
  assert.equal(rename.options.retries, 0);
  const client = privateDiscordClient();
  assert.equal(client.rest.options.rejectOnRateLimit, null, 'the client REST waits out rate limits, so renames must never use it');
  assert.notEqual(client.rest, rename);
  client.destroy();
});
