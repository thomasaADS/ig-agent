import { route, resetMock, callsTo } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const { getSetting, setSetting } = await import('../src/db.js');
const ig = await import('../src/instagram.js');

function mockTokenEndpoints() {
  route('api.instagram.com/oauth/access_token', () => ({ access_token: 'short', user_id: 1 }));
  route('graph.instagram.com/access_token', () => ({ access_token: 'long-token', expires_in: 5184000 }));
  route('/me?', () => ({ id: 'app-scoped', user_id: 'ig-id', username: 'ben' }));
}
const stateOf = (url) => new URL(url).searchParams.get('state');

test('OAuth state: empty, missing, wrong, reused and expired states are all rejected', async () => {
  resetMock();
  mockTokenEndpoints();

  // The original bug: after a login the stored state was '' so state= passed.
  setSetting('oauth_state', '');
  await assert.rejects(ig.handleCallback('code', ''), /state/);
  await assert.rejects(ig.handleCallback('code', undefined), /state/);

  const s1 = stateOf(ig.loginUrl());
  assert.ok(s1.length >= 32);
  await assert.rejects(ig.handleCallback('code', 'x'.repeat(s1.length)), /state/);
  await assert.rejects(ig.handleCallback('code', s1), /state/, 'a failed attempt burns the state');

  const s2 = stateOf(ig.loginUrl());
  setSetting('oauth_state_at', Date.now() - 11 * 60_000);
  await assert.rejects(ig.handleCallback('code', s2), /state/, 'expired after 10 minutes');
  assert.equal(callsTo('oauth/access_token').length, 0, 'no token exchange without a valid state');
  assert.equal(ig.isConnected(), false);
});

test('OAuth happy path stores a long-lived token; the state cannot be replayed', async () => {
  resetMock();
  mockTokenEndpoints();
  const state = stateOf(ig.loginUrl());
  const profile = await ig.handleCallback('the-code#_', state);
  assert.equal(profile.username, 'ben');
  assert.equal(getSetting('access_token'), 'long-token');
  assert.equal(getSetting('oauth_state'), null);
  assert.ok(ig.tokenDaysLeft() >= 59);
  assert.equal(String(callsTo('oauth/access_token')[0].body).includes('code=the-code&') || String(callsTo('oauth/access_token')[0].body).endsWith('code=the-code'), true);

  // Replay with the same state must not swap the connected account.
  route('graph.instagram.com/access_token', () => ({ access_token: 'attacker-token', expires_in: 1 }));
  await assert.rejects(ig.handleCallback('other-code', state), /state/);
  assert.equal(getSetting('access_token'), 'long-token');
});

test('api(): retries 429 and 5xx with backoff, reports a dead token once', async () => {
  resetMock();
  let hits = 0;
  route('/me/media', () => (++hits < 3 ? new Response('{"error":{"message":"slow down","code":4}}', { status: 429 }) : { data: [{ id: 'm1' }] }));
  assert.deepEqual(await ig.recentMedia(5), [{ id: 'm1' }]);
  assert.equal(hits, 3);

  // POSTs are not retried on 5xx: the message may already have been sent.
  let posts = 0;
  route('/me/messages', () => (posts++, new Response('{"error":{"message":"oops"}}', { status: 500 })));
  await assert.rejects(ig.sendMessage('u', 'hi'));
  assert.equal(posts, 1);

  let alerts = 0;
  ig.onTokenInvalid(() => alerts++);
  route('/me/media', () => new Response('{"error":{"message":"Invalid OAuth access token","code":190}}', { status: 400 }));
  await assert.rejects(ig.recentMedia(5), (e) => e.code === 190);
  assert.equal(alerts, 1);
  assert.equal(JSON.stringify(callsTo('/me/media').map((c) => c.url)).includes('long-token'), false, 'token never appears in URLs');
});

test('token refresh happens only when the token is old enough and close to expiry', async () => {
  resetMock();
  let refreshed = 0;
  route('refresh_access_token', () => (refreshed++, { access_token: 'fresh', expires_in: 5184000 }));
  assert.equal(await ig.refreshTokenIfNeeded(), false, 'fresh token: nothing to do');
  setSetting('token_expires_at', Date.now() + 10 * 86_400_000);
  setSetting('token_refreshed_at', Date.now() - 50 * 86_400_000);
  assert.equal(await ig.refreshTokenIfNeeded(), true);
  assert.deepEqual([refreshed, getSetting('access_token')], [1, 'fresh']);
});
