import assert from 'node:assert/strict';
import { test } from 'node:test';
import { privateDiscordClient, privateDiscordRest } from './sdk.js';

test('private Discord Gateway and registration REST disable ambiguous SDK retries', () => {
  const client = privateDiscordClient();
  const registration = privateDiscordRest('synthetic-token');
  assert.equal(client.rest.options.retries, 0);
  assert.equal(registration.options.retries, 0);
  client.destroy();
});
