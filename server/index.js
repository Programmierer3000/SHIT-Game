const path = require('path');
const fs = require('fs');

// Minimal .env loader (local use); real env vars win.
try {
  const envFile = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
    }
  }
} catch (_) {}

const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const questions = require('./questions.json');
const { scorePlayer, MAX_POINTS } = require('./scoring');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'host';
const VOTE_SECONDS = Number(process.env.VOTE_SECONDS || 60);
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS || 100);
const MAX_ROOMS = 50;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.get('/health', (_req, res) => res.json({ ok: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const rooms = new Map(); // code -> room
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
}

function createRoom() {
  const room = {
    code: newCode(),
    hostToken: crypto.randomBytes(16).toString('hex'),
    players: new Map(), // token -> player
    sockets: new Map(), // socket.id -> { role, token }
    phase: 'lobby',
    qIndex: -1,
    endsAt: null,
    hostChoice: null,
    result: null,
    timer: null,
    lastActive: Date.now(),
  };
  rooms.set(room.code, room);
  return room;
}

// Drop rooms that were idle for 6 hours.
setInterval(() => {
  for (const [code, r] of rooms) {
    if (Date.now() - r.lastActive > 6 * 3600 * 1000) {
      clearTimeout(r.timer);
      rooms.delete(code);
    }
  }
}, 10 * 60 * 1000).unref();

function leaderboard(room) {
  return [...room.players.values()]
    .map((p) => ({ id: p.id, name: p.name, score: p.score, connected: p.connected }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

function stateFor(room, socket) {
  const info = room.sockets.get(socket.id);
  const s = {
    code: room.code,
    phase: room.phase,
    qIndex: room.qIndex,
    total: questions.length,
    question: room.qIndex >= 0 && room.phase !== 'lobby' && room.phase !== 'finished' ? questions[room.qIndex] : null,
    endsAt: room.phase === 'voting' ? room.endsAt : null,
    serverNow: Date.now(),
    voteSeconds: VOTE_SECONDS,
    maxPoints: MAX_POINTS,
    playerCount: room.players.size,
    leaderboard: leaderboard(room),
    result: room.phase === 'reveal' ? room.result : null,
    votedCount: [...room.players.values()].filter((p) => p.vote).length,
    role: info ? info.role : null,
  };
  if (info && info.role === 'host') {
    s.hostChoice = room.hostChoice;
    s.nextAvailable = room.qIndex + 1 < questions.length;
    s.players = [...room.players.values()].map((p) => ({ id: p.id, name: p.name, connected: p.connected, voted: !!p.vote, score: p.score }));
  }
  const me = info && info.role === 'player' ? room.players.get(info.token) : null;
  if (me) {
    s.me = {
      id: me.id,
      name: me.name,
      score: me.score,
      streak: me.streak,
      wrongStreak: me.wrongStreak,
      vote: me.vote,
      last: room.phase === 'reveal' ? me.last : null,
      rank: s.leaderboard.findIndex((p) => p.id === me.id) + 1,
    };
  }
  return s;
}

function broadcast(room) {
  room.lastActive = Date.now();
  for (const id of room.sockets.keys()) {
    const sock = io.sockets.sockets.get(id);
    if (sock) sock.emit('state', stateFor(room, sock));
  }
}

function clearTimer(room) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
}

function startQuestion(room) {
  if (room.qIndex + 1 >= questions.length) return;
  clearTimer(room);
  for (const p of room.players.values()) {
    p.vote = null;
    p.last = null;
  }
  room.qIndex += 1;
  room.phase = 'voting';
  room.hostChoice = null;
  room.result = null;
  room.endsAt = Date.now() + VOTE_SECONDS * 1000;
  room.timer = setTimeout(() => {
    if (room.phase === 'voting') {
      room.phase = 'closed';
      room.endsAt = null;
      broadcast(room);
    }
  }, VOTE_SECONDS * 1000);
}

function reveal(room) {
  if (room.phase !== 'voting' && room.phase !== 'closed') return;
  clearTimer(room);
  const voters = [...room.players.values()].filter((p) => p.vote);
  const own = { A: 0, B: 0 };
  voters.forEach((p) => (own[p.vote.own] += 1));
  const majority = own.A === own.B ? null : own.A > own.B ? 'A' : 'B';

  for (const p of room.players.values()) {
    const r = scorePlayer(p, p.vote, majority, room.hostChoice);
    p.score += r.points;
    p.streak = r.streak;
    p.wrongStreak = r.wrongStreak;
    p.last = { voted: !!p.vote, points: r.points, parts: r.parts, majorityRight: r.majorityRight, hostRight: r.hostRight };
  }
  room.phase = 'reveal';
  room.endsAt = null;
  room.result = { own, majority, host: room.hostChoice, voters: voters.length };
}

function finish(room) {
  clearTimer(room);
  room.phase = 'finished';
  room.endsAt = null;
}

const cleanName = (n) => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 20);

io.on('connection', (socket) => {
  let room = null;
  const isHost = () => room && room.sockets.get(socket.id)?.role === 'host';
  const host = (fn) => (...args) => { if (isHost()) fn(...args); };
  const done = (ack, v) => (typeof ack === 'function' ? ack(v) : undefined);

  const attach = (r, role, token) => {
    room = r;
    socket.join(r.code);
    r.sockets.set(socket.id, { role, token });
  };

  socket.on('host:create', (password, ack) => {
    const a = Buffer.from(String(password || ''));
    const b = Buffer.from(ADMIN_PASSWORD);
    if (!(a.length === b.length && crypto.timingSafeEqual(a, b))) return done(ack, { error: 'Wrong password.' });
    if (rooms.size >= MAX_ROOMS) return done(ack, { error: 'Too many games running.' });
    const r = createRoom();
    attach(r, 'host', null);
    done(ack, { code: r.code, hostToken: r.hostToken });
    broadcast(r);
  });

  socket.on('host:resume', (data, ack) => {
    const r = data && rooms.get(String(data.code || '').toUpperCase());
    if (!r || r.hostToken !== data.hostToken) return done(ack, { error: 'Game not found.' });
    attach(r, 'host', null);
    done(ack, { code: r.code });
    broadcast(r);
  });

  socket.on('join', (data, ack) => {
    const r = data && rooms.get(String(data.code || '').toUpperCase().trim());
    if (!r) return done(ack, { error: 'Game code not found.' });
    let player = data.token ? r.players.get(data.token) : null;
    if (!player) {
      const name = cleanName(data.name);
      if (!name) return done(ack, { error: 'Please enter a name.' });
      if (r.players.size >= MAX_PLAYERS) return done(ack, { error: 'Game is full.' });
      if ([...r.players.values()].some((p) => p.name.toLowerCase() === name.toLowerCase())) {
        return done(ack, { error: 'Name already taken.' });
      }
      const token = crypto.randomBytes(16).toString('hex');
      player = { id: crypto.randomBytes(4).toString('hex'), token, name, score: 0, streak: 0, wrongStreak: 0, vote: null, last: null, connected: true };
      r.players.set(token, player);
    }
    player.connected = true;
    attach(r, 'player', player.token);
    done(ack, { token: player.token, code: r.code });
    broadcast(r);
  });

  socket.on('vote', (v, ack) => {
    const info = room && room.sockets.get(socket.id);
    const me = info && info.role === 'player' && room.players.get(info.token);
    if (!me) return done(ack, { error: 'Not joined.' });
    if (room.phase !== 'voting') return done(ack, { error: 'Voting is closed.' });
    const ok = (x) => x === 'A' || x === 'B';
    if (!v || !ok(v.own) || !ok(v.majority) || !ok(v.host)) return done(ack, { error: 'Pick all three.' });
    me.vote = { own: v.own, majority: v.majority, host: v.host };
    done(ack, { ok: true });
    broadcast(room);
  });

  socket.on('admin:next', host(() => {
    if (room.phase === 'voting' || room.phase === 'closed') return;
    if (room.qIndex + 1 >= questions.length) finish(room);
    else startQuestion(room);
    broadcast(room);
  }));

  socket.on('admin:host', host((choice) => {
    if ((room.phase === 'voting' || room.phase === 'closed') && (choice === 'A' || choice === 'B')) {
      room.hostChoice = choice;
      broadcast(room);
    }
  }));

  socket.on('admin:reveal', host(() => {
    reveal(room);
    broadcast(room);
  }));

  socket.on('admin:finish', host(() => {
    finish(room);
    broadcast(room);
  }));

  socket.on('admin:kick', host((id) => {
    for (const [token, p] of room.players) {
      if (p.id === id) {
        room.players.delete(token);
        for (const [sid, info] of room.sockets) {
          if (info.token === token) {
            const s = io.sockets.sockets.get(sid);
            room.sockets.delete(sid);
            if (s) s.emit('kicked');
          }
        }
      }
    }
    broadcast(room);
  }));

  socket.on('admin:close', host(() => {
    clearTimer(room);
    io.to(room.code).emit('closed');
    rooms.delete(room.code);
  }));

  socket.on('disconnect', () => {
    if (!room) return;
    const info = room.sockets.get(socket.id);
    room.sockets.delete(socket.id);
    if (info && info.role === 'player') {
      const p = room.players.get(info.token);
      if (p && ![...room.sockets.values()].some((i) => i.token === info.token)) p.connected = false;
    }
    if (rooms.has(room.code)) broadcast(room);
  });
});

server.listen(PORT, () => console.log(`SHIT-Game server on :${PORT} (admin password ${process.env.ADMIN_PASSWORD ? 'set' : 'DEFAULT "host"'})`));
