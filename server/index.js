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

const optionKeys = (q) => 'ABCDEF'.slice(0, q && q.options ? q.options.length : 2).split('');

function createRoom(code, hostToken) {
  const room = {
    code: code || newCode(),
    hostToken: hostToken || crypto.randomBytes(16).toString('hex'),
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
    .map((p) => ({ id: p.id, name: p.name, score: p.score, connected: p.connected, isHost: !!p.isHost }))
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
    doubled: room.qIndex === questions.length - 1,
    playerCount: room.players.size,
    leaderboard: leaderboard(room),
    result: room.phase === 'reveal' ? room.result : null,
    votedCount: [...room.players.values()].filter((p) => p.vote).length,
    role: info ? info.role : null,
  };
  if (info && info.role === 'host') {
    s.hostChoice = room.hostChoice;
    s.nextAvailable = room.qIndex + 1 < questions.length;
    s.players = [...room.players.values()].map((p) => ({ id: p.id, name: p.name, connected: p.connected, voted: !!p.vote, score: p.score, isHost: !!p.isHost }));
  }
  const me = info ? room.players.get(info.token) : null;
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
  const own = {};
  optionKeys(questions[room.qIndex]).forEach((k) => (own[k] = 0));
  voters.forEach((p) => (own[p.vote.own] += 1));
  const top = Math.max(...Object.values(own));
  const leaders = Object.keys(own).filter((k) => own[k] === top);
  const majority = leaders.length === 1 ? leaders[0] : null;
  const multiplier = room.qIndex === questions.length - 1 ? 2 : 1;

  for (const p of room.players.values()) {
    // The host cannot guess their own choice, so they only score on the majority.
    const vote = p.vote && p.isHost ? { ...p.vote, host: null } : p.vote;
    const r = scorePlayer(p, vote, majority, room.hostChoice, multiplier);
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

// Anyone may host; limit game creation per IP to avoid abuse.
const created = new Map(); // ip -> timestamps
const CREATE_LIMIT = 5;
const CREATE_WINDOW_MS = 10 * 60 * 1000;
const clientIp = (socket) => String(socket.handshake.headers['x-forwarded-for'] || socket.handshake.address).split(',')[0].trim();
setInterval(() => {
  const now = Date.now();
  for (const [ip, ts] of created) if (!ts.some((x) => now - x < CREATE_WINDOW_MS)) created.delete(ip);
}, 10 * 60 * 1000).unref();

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

  socket.on('host:create', (data, ack) => {
    const name = data && data.name;
    const ip = clientIp(socket);
    const recent = (created.get(ip) || []).filter((x) => Date.now() - x < CREATE_WINDOW_MS);
    if (recent.length >= CREATE_LIMIT) return done(ack, { error: 'Too many games created. Try again in a few minutes.' });
    recent.push(Date.now());
    created.set(ip, recent);
    if (rooms.size >= MAX_ROOMS) return done(ack, { error: 'Too many games running.' });
    const r = createRoom();
    const token = crypto.randomBytes(16).toString('hex');
    r.players.set(token, {
      id: crypto.randomBytes(4).toString('hex'), token, name: cleanName(name) || 'Host', isHost: true,
      score: 0, streak: 0, wrongStreak: 0, vote: null, last: null, connected: true,
    });
    r.hostPlayerToken = token;
    attach(r, 'host', token);
    done(ack, { code: r.code, hostToken: r.hostToken });
    broadcast(r);
  });

  socket.on('host:resume', (data, ack) => {
    const code = String((data && data.code) || '').toUpperCase();
    let r = rooms.get(code);
    if (!r) {
      // The server lost the game (restart/sleep): let the host restore it under the same code.
      const tokenOk = /^[0-9a-f]{32}$/.test(String((data && data.hostToken) || ''));
      if (!tokenOk || !new RegExp(`^[${CODE_CHARS}]{4}$`).test(code) || rooms.size >= MAX_ROOMS) {
        return done(ack, { error: 'Game not found.' });
      }
      r = createRoom(code, data.hostToken);
      const token = crypto.randomBytes(16).toString('hex');
      r.players.set(token, {
        id: crypto.randomBytes(4).toString('hex'), token, name: cleanName(data.name) || 'Host', isHost: true,
        score: 0, streak: 0, wrongStreak: 0, vote: null, last: null, connected: true,
      });
      r.hostPlayerToken = token;
    }
    if (r.hostToken !== data.hostToken) return done(ack, { error: 'Game not found.' });
    attach(r, 'host', r.hostPlayerToken);
    r.players.get(r.hostPlayerToken).connected = true;
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
    const me = info && room.players.get(info.token);
    if (!me) return done(ack, { error: 'Not joined.' });
    // The host may still vote after time is up so the round can never get stuck.
    if (room.phase !== 'voting' && !(me.isHost && room.phase === 'closed')) return done(ack, { error: 'Voting is closed.' });
    const keys = optionKeys(questions[room.qIndex]);
    const ok = (x) => keys.includes(x);
    if (!v || !ok(v.own) || !ok(v.majority) || (!me.isHost && !ok(v.host))) return done(ack, { error: 'Pick all choices.' });
    // The host's own choice is the choice everybody else has to guess.
    me.vote = { own: v.own, majority: v.majority, host: me.isHost ? v.own : v.host };
    if (me.isHost) room.hostChoice = v.own;
    done(ack, { ok: true });
    broadcast(room);
  });

  socket.on('admin:next', host(() => {
    if (room.phase === 'voting' || room.phase === 'closed') return;
    if (room.qIndex + 1 >= questions.length) finish(room);
    else startQuestion(room);
    broadcast(room);
  }));

  socket.on('admin:reveal', host(() => {
    if (room.hostChoice === null) return;
    reveal(room);
    broadcast(room);
  }));

  socket.on('admin:kick', host((id) => {
    for (const [token, p] of room.players) {
      if (p.id === id && !p.isHost) {
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

  socket.on('disconnect', () => {
    if (!room) return;
    const info = room.sockets.get(socket.id);
    room.sockets.delete(socket.id);
    if (info) {
      const p = room.players.get(info.token);
      if (p && ![...room.sockets.values()].some((i) => i.token === info.token)) p.connected = false;
    }
    if (rooms.has(room.code)) broadcast(room);
  });
});

server.listen(PORT, () => console.log(`SHIT-Game server on :${PORT} `));
