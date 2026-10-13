'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');
const { Server } = require('socket.io');

const NAME_PATTERN = /^[\p{L}\p{N}_ -]+$/u;
function normalizeUsername(value) {
  if (typeof value !== 'string') return null;
  const username = value.normalize('NFC').trim();
  const length = Array.from(username).length;
  if (length < 2 || length > 18 || !NAME_PATTERN.test(username)) return null;
  return username;
}

function createGameService(options = {}) {
  const databasePath = options.databasePath || process.env.DATABASE_PATH || path.join(__dirname, 'data', 'leaderboard.sqlite');
  if (databasePath !== ':memory:') fs.mkdirSync(path.dirname(databasePath), { recursive: true });

  const db = new Database(databasePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS matches (
      id TEXT PRIMARY KEY,
      mode TEXT NOT NULL CHECK (mode IN ('solo', 'coop')),
      level INTEGER NOT NULL CHECK (level BETWEEN 1 AND 30),
      passes INTEGER NOT NULL CHECK (passes BETWEEN 0 AND 10000),
      duration_ms INTEGER NOT NULL CHECK (duration_ms BETWEEN 0 AND 10800000),
      outcome TEXT NOT NULL CHECK (outcome IN ('win', 'loss')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS participants (
      match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
      player_index INTEGER NOT NULL CHECK (player_index BETWEEN 0 AND 1),
      username TEXT NOT NULL COLLATE NOCASE,
      PRIMARY KEY (match_id, player_index)
    );
    CREATE INDEX IF NOT EXISTS idx_matches_score
      ON matches(level DESC, passes ASC, duration_ms ASC, created_at ASC);
  `);

  const insertMatch = db.prepare(`
    INSERT INTO matches (id, mode, level, passes, duration_ms, outcome)
    VALUES (@id, @mode, @level, @passes, @duration, @outcome)
  `);
  const insertParticipant = db.prepare(`
    INSERT INTO participants (match_id, player_index, username)
    VALUES (@matchId, @index, @username)
  `);
  const saveMatch = db.transaction((run) => {
    insertMatch.run(run);
    run.players.forEach((username, index) => {
      insertParticipant.run({ matchId: run.id, index, username });
    });
  });

  const queue = [];
  const rooms = new Map();
  const socketRooms = new Map();
  const completedRuns = new Set();
  const scores = db.prepare(`
    WITH ranked AS (
      SELECT p.username, m.level, m.passes, m.duration_ms AS duration,
             m.outcome, m.mode, m.created_at,
             ROW_NUMBER() OVER (
               PARTITION BY p.username COLLATE NOCASE
               ORDER BY m.level DESC, (m.outcome = 'win') DESC,
                        m.passes ASC, m.duration_ms ASC, m.created_at ASC
             ) AS rank
      FROM participants p
      JOIN matches m ON m.id = p.match_id
    )
    SELECT username, level, passes, duration, outcome, mode, created_at
    FROM ranked WHERE rank = 1
    ORDER BY level DESC, (outcome = 'win') DESC, passes ASC,
             duration ASC, username COLLATE NOCASE ASC
    LIMIT ?
  `);

  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(response, 200, { status: 'ok' });
    }
    if (request.method === 'GET' && url.pathname === '/api/leaderboard') {
      const requestedLimit = Number(url.searchParams.get('limit') || 10);
      const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(25, requestedLimit)) : 10;
      return sendJson(response, 200, { scores: scores.all(limit) });
    }
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return fs.readFile(path.join(__dirname, 'index.html'), (error, content) => {
        if (error) return sendJson(response, 500, { error: 'Unable to load the game.' });
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache'
        });
        response.end(content);
      });
    }
    sendJson(response, 404, { error: 'Not found.' });
  });

  const io = new Server(server, { serveClient: true, maxHttpBufferSize: 16_384 });

  function roomFor(socket) {
    const id = socketRooms.get(socket.id);
    return id ? rooms.get(id) : null;
  }

  function leaveQueue(socket) {
    const index = queue.findIndex((player) => player.socketId === socket.id);
    if (index >= 0) queue.splice(index, 1);
  }

  function leaveRoom(socket, notify = true) {
    const room = roomFor(socket);
    if (!room) return;
    socketRooms.delete(socket.id);
    socket.leave(room.id);
    room.players = room.players.filter((player) => player.socketId !== socket.id);
    if (notify) io.to(room.id).emit('match:opponent-left');
    if (room.players.length === 0 || room.completed) rooms.delete(room.id);
    else {
      const remaining = io.sockets.sockets.get(room.players[0].socketId);
      if (remaining) {
        remaining.data.matchId = null;
        remaining.data.mode = 'solo';
      }
      rooms.delete(room.id);
    }
  }

  io.on('connection', (socket) => {
    socket.on('player:identify', (payload, acknowledge) => {
      const username = normalizeUsername(payload && payload.username);
      if (!username) {
        if (typeof acknowledge === 'function') acknowledge({ ok: false, error: 'Use 2–18 letters, numbers, spaces, hyphens, or underscores.' });
        return;
      }
      if (socketRooms.has(socket.id)) leaveRoom(socket);
      socket.data.username = username;
      socket.data.mode = 'solo';
      socket.data.matchId = null;
      if (typeof acknowledge === 'function') acknowledge({ ok: true, username });
    });

    socket.on('match:find', (payload, acknowledge) => {
      if (roomFor(socket)) {
        if (typeof acknowledge === 'function') acknowledge({ ok: false, error: 'You are already in a match.' });
        return;
      }
      const username = normalizeUsername(payload && payload.username);
      if (!username) {
        if (typeof acknowledge === 'function') acknowledge({ ok: false, error: 'Choose a valid username before finding a player.' });
        return;
      }
      if (socket.data.username !== username) {
        socket.data.username = username;
        socket.data.mode = 'solo';
      }
      leaveQueue(socket);
      const opponentIndex = queue.findIndex((player) => player.username.toLocaleLowerCase() !== username.toLocaleLowerCase());
      if (opponentIndex < 0) {
        queue.push({ socketId: socket.id, username });
        socket.emit('match:waiting');
        if (typeof acknowledge === 'function') acknowledge({ ok: true, waiting: true });
        return;
      }

      const opponent = queue.splice(opponentIndex, 1)[0];
      if (!opponent) {
        queue.push({ socketId: socket.id, username });
        socket.emit('match:waiting');
        if (typeof acknowledge === 'function') acknowledge({ ok: true, waiting: true });
        return;
      }
      const matchId = randomUUID();
      const room = {
        id: matchId,
        hostId: opponent.socketId,
        players: [opponent, { socketId: socket.id, username }],
        startedAt: 0,
        runId: '',
        completed: false
      };
      rooms.set(matchId, room);
      for (const player of room.players) {
        const playerSocket = io.sockets.sockets.get(player.socketId);
        if (!playerSocket) continue;
        playerSocket.join(matchId);
        playerSocket.data.username = player.username;
        playerSocket.data.matchId = matchId;
        playerSocket.data.mode = 'coop';
        socketRooms.set(player.socketId, matchId);
      }
      const found = {
        roomId: matchId.slice(0, 8).toUpperCase(),
        hostId: room.hostId,
        players: room.players.map((player) => player.username)
      };
      io.to(matchId).emit('match:found', found);
      if (typeof acknowledge === 'function') acknowledge({ ok: true, waiting: false });
    });

    socket.on('match:cancel', (acknowledge) => {
      leaveQueue(socket);
      leaveRoom(socket);
      socket.data.matchId = null;
      socket.data.mode = 'solo';
      if (typeof acknowledge === 'function') acknowledge({ ok: true });
    });

    socket.on('game:start', (payload) => {
      const level = Number(payload && payload.level);
      if (!Number.isInteger(level) || level < 1 || level > 30) return;
      const room = roomFor(socket);
      if (room) {
        if (room.hostId !== socket.id) return;
        room.startedAt = Date.now();
        room.runId = randomUUID();
        room.completed = false;
        io.to(room.id).emit('game:start', { level });
      } else if (socket.data.username) {
        socket.data.mode = 'solo';
        socket.data.startedAt = Date.now();
      }
    });

    socket.on('game:state', (state) => {
      const room = roomFor(socket);
      if (!room || room.hostId !== socket.id || room.completed || !room.startedAt) return;
      if (!state || typeof state !== 'object' || JSON.stringify(state).length > 8000) return;
      const now = Date.now();
      if (now - (room.lastStateAt || 0) < 40) return;
      room.lastStateAt = now;
      socket.to(room.id).volatile.emit('game:state', state);
    });

    socket.on('game:pass-request', (index) => {
      const room = roomFor(socket);
      if (!room || room.hostId === socket.id || !Number.isInteger(index) || index < 0 || index >= 6 || !room.startedAt || room.completed) return;
      io.to(room.hostId).emit('game:pass-request', index);
    });

    socket.on('game:finish', (payload) => {
      const room = roomFor(socket);
      if (room && room.hostId !== socket.id) return;
      const isCoop = Boolean(room);
      const username = socket.data.username;
      const level = Number(payload && payload.level);
      const passes = Number(payload && payload.passes);
      const outcome = payload && payload.outcome;
      const startedAt = isCoop ? room.startedAt : socket.data.startedAt;
      if (!username || !startedAt || (room && room.completed) ||
          !Number.isInteger(level) || level < 1 || level > 30 ||
          !Number.isInteger(passes) || passes < 0 || passes > 10000 ||
          (outcome !== 'win' && outcome !== 'loss') ||
          (outcome === 'win' && level !== 30)) return;

      const players = isCoop ? room.players.map((player) => player.username) : [username];
      if (isCoop) room.completed = true;
      const duration = Math.max(0, Math.min(Date.now() - startedAt, 10_800_000));
      try {
        saveMatch({
          id: isCoop ? room.runId : randomUUID(),
          mode: isCoop ? 'coop' : 'solo',
          level,
          passes,
          duration,
          outcome,
          players
        });
        io.emit('leaderboard:update');
        if (room) io.to(room.id).emit('game:finished');
        else socket.emit('game:finished');
      } catch (error) {
        console.error('Failed to save game result:', error);
        socket.emit('game:save-error');
      }
    });

    socket.on('disconnect', () => {
      leaveQueue(socket);
      leaveRoom(socket);
    });
  });

  return {
    server,
    io,
    db,
    listen(port = 0, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve(server.address());
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        io.close(() => {
          db.close();
          resolve();
        });
      });
    }
  };
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(JSON.stringify(value));
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '0.0.0.0';
  const service = createGameService();
  service.server.listen(port, host, () => {
    console.log(`Pass It On is ready at http://${host}:${port}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => service.close().then(() => process.exit(0)));
  }
}

module.exports = { createGameService, normalizeUsername };
