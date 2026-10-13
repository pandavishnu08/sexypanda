'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, describe, it } = require('node:test');
const { io: createSocket } = require('socket.io-client');
const { createGameService, normalizeUsername } = require('../server');

describe('game server', () => {
  let directory;
  let databasePath;
  let service;
  let baseUrl;
  const clients = [];

  before(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sexypanda-test-'));
    databasePath = path.join(directory, 'scores.sqlite');
    service = createGameService({ databasePath });
    const address = await service.listen();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    for (const client of clients) client.disconnect();
    await service.close();
    service = createGameService({ databasePath });
    try {
      const address = await service.listen();
      const response = await fetch(`http://127.0.0.1:${address.port}/api/leaderboard`);
      const { scores } = await response.json();
      assert.ok(scores.some((score) => score.username === 'Remy' && score.level === 30));
    } finally {
      await service.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  async function connect() {
    const client = createSocket(baseUrl, { forceNew: true, reconnection: false });
    clients.push(client);
    await once(client, 'connect');
    return client;
  }

  it('validates and normalizes public player names', () => {
    assert.equal(normalizeUsername('  Zoë Panda  '), 'Zoë Panda');
    assert.equal(normalizeUsername('x'), null);
    assert.equal(normalizeUsername('<script>'), null);
    assert.equal(normalizeUsername('too-long-username-over-limit'), null);
  });

  it('serves the game and an empty leaderboard', async () => {
    const health = await fetch(`${baseUrl}/api/health`);
    assert.deepEqual(await health.json(), { status: 'ok' });
    const page = await fetch(baseUrl);
    assert.match(await page.text(), /Vangrid: Pass It On/);
    const response = await fetch(`${baseUrl}/api/leaderboard?limit=1000`);
    assert.deepEqual(await response.json(), { scores: [] });
  });

  it('pairs two players and stores a co-op result once for each player', async () => {
    const first = await connect();
    const second = await connect();
    const firstFound = once(first, 'match:found');
    const secondFound = once(second, 'match:found');

    const waiting = once(first, 'match:waiting');
    first.emit('match:find', { username: 'Mira' });
    await waiting;
    second.emit('match:find', { username: 'Tao' });

    const [matchA] = await firstFound;
    const [matchB] = await secondFound;
    assert.equal(matchA.roomId, matchB.roomId);
    assert.deepEqual(matchA.players, ['Mira', 'Tao']);

    const started = once(second, 'game:start');
    first.emit('game:start', { level: 4 });
    assert.deepEqual((await started)[0], { level: 4 });
    const passRequest = once(first, 'game:pass-request');
    second.emit('game:pass-request', 2);
    assert.equal((await passRequest)[0], 2);
    const synced = once(second, 'game:state');
    first.emit('game:state', { level: 4, people: [{ x: 2 }] });
    assert.deepEqual((await synced)[0], { level: 4, people: [{ x: 2 }] });
    const observer = await connect();
    const leaderboardChanged = once(observer, 'leaderboard:update');
    const finished = once(second, 'game:finished');
    first.emit('game:finish', { level: 4, passes: 9, outcome: 'loss' });
    await finished;
    await leaderboardChanged;

    const response = await fetch(`${baseUrl}/api/leaderboard`);
    const { scores } = await response.json();
    assert.deepEqual(scores.map((score) => score.username), ['Mira', 'Tao']);
    assert.ok(scores.every((score) => score.mode === 'coop' && score.level === 4));

    const solo = await connect();
    const identified = await new Promise((resolve) => {
      solo.emit('player:identify', { username: 'Remy' }, resolve);
    });
    assert.deepEqual(identified, { ok: true, username: 'Remy' });
    solo.emit('game:start', { level: 30 });
    solo.emit('game:finish', { level: 30, passes: 12, outcome: 'win' });
    const updated = await (await fetch(`${baseUrl}/api/leaderboard`)).json();
    assert.equal(updated.scores[0].username, 'Remy');
    assert.equal(updated.scores[0].outcome, 'win');
  });

  it('refuses match results from the non-host player', async () => {
    const first = await connect();
    const second = await connect();
    const found = once(second, 'match:found');
    const waiting = once(first, 'match:waiting');
    first.emit('match:find', { username: 'Ivy' });
    await waiting;
    second.emit('match:find', { username: 'Noah' });
    await found;
    first.emit('game:start', { level: 3 });
    const before = await (await fetch(`${baseUrl}/api/leaderboard`)).json();
    second.emit('game:finish', { level: 30, passes: 0, outcome: 'win' });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const afterScores = await (await fetch(`${baseUrl}/api/leaderboard`)).json();
    assert.deepEqual(afterScores.scores, before.scores);
  });
});
