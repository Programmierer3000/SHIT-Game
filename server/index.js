const path = require('path');
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

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.get('/health', (_req, res) => res.json({ ok: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const players = new Map(); // token -> player
let game;

function freshGame() {
  return { phase: 'lobby', qIndex: -1, endsAt: null, hostChoice: null, result: null, timer: null };
}
game = freshGame();

const adminSockets = new Set();
const socketPlayer = new Map(); // socket.id -> token

function leaderboard() {
  return [...players.values()]
    .map((p) => ({ id: p.id, name: p.name, score: p.score, connected: p.connected }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

function question() {
  return game.qIndex >= 0 ? questions[game.qIndex] : null;
}

function baseState() {
  const inRound = game.phase === 'voting' || game.phase === 'closed';
  return {
    phase: game.phase,
    qIndex: game.qIndex,
    total: questions.length,
    question: game.phase === 'lobby' || game.phase === 'finished' ? null : question(),
    endsAt: game.phase === 'voting' ? game.endsAt : null,
    serverNow: Date.now(),
    maxPoints: MAX_POINTS,
    voteSeconds: VOTE_SECONDS,
    playerCount: players.size,
    leaderboard: leaderboard(),
    result: game.phase === 'reveal' ? game.result.public : null,
    votedCount: inRound || game.phase === 'reveal' ? [...players.values()].filter((p) => p.vote).length : 0,
  };
}

function stateFor(socket) {
  const s = baseState();
  if (adminSockets.has(socket.id)) {
    s.admin = true;
    s.hostChoice = game.hostChoice;
    s.nextAvailable = game.qIndex + 1 < questions.length;
    s.players = [...players.values()].map((p) => ({ id: p.id, name: p.name, connected: p.connected, voted: !!p.vote, score: p.score }));
  }
  const token = socketPlayer.get(socket.id);
  const me = token && players.get(token);
  if (me) {
    s.me = {
      id: me.id,
      name: me.name,
      score: me.score,
      streak: me.streak,
      wrongStreak: me.wrongStreak,
      vote: me.vote,
      last: game.phase === 'reveal' ? me.last : null,
      rank: leaderboard().findIndex((p) => p.id === me.id) + 1,
    };
  }
  return s;
}

function broadcast() {
  for (const socket of io.sockets.sockets.values()) socket.emit('state', stateFor(socket));
}

function clearTimer() {
  if (game.timer) clearTimeout(game.timer);
  game.timer = null;
}

function startQuestion() {
  if (game.qIndex + 1 >= questions.length) return;
  clearTimer();
  for (const p of players.values()) {
    p.vote = null;
    p.last = null;
  }
  game.qIndex += 1;
  game.phase = 'voting';
  game.hostChoice = null;
  game.result = null;
  game.endsAt = Date.now() + VOTE_SECONDS * 1000;
  game.timer = setTimeout(() => {
    if (game.phase === 'voting') {
      game.phase = 'closed';
      game.endsAt = null;
      broadcast();
    }
  }, VOTE_SECONDS * 1000);
}

function reveal() {
  if (game.phase !== 'voting' && game.phase !== 'closed') return;
  clearTimer();
  const voters = [...players.values()].filter((p) => p.vote);
  const own = { A: 0, B: 0 };
  voters.forEach((p) => (own[p.vote.own] += 1));
  const majority = own.A === own.B ? null : own.A > own.B ? 'A' : 'B';

  for (const p of players.values()) {
    const r = scorePlayer(p, p.vote, majority, game.hostChoice);
    p.score += r.points;
    p.streak = r.streak;
    p.wrongStreak = r.wrongStreak;
    p.last = { voted: !!p.vote, points: r.points, parts: r.parts, majorityRight: r.majorityRight, hostRight: r.hostRight };
  }

  game.phase = 'reveal';
  game.endsAt = null;
  game.result = { public: { own, majority, host: game.hostChoice, voters: voters.length } };
}

function finish() {
  clearTimer();
  game.phase = 'finished';
  game.endsAt = null;
}

function cleanName(n) {
  return String(n || '').replace(/\s+/g, ' ').trim().slice(0, 20);
}

io.on('connection', (socket) => {
  const requireAdmin = (fn) => (...args) => {
    if (adminSockets.has(socket.id)) fn(...args);
  };

  socket.on('join', (data, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    const name = cleanName(data && data.name);
    let player = data && data.token ? players.get(data.token) : null;
    if (!player) {
      if (!name) return ack({ error: 'Please enter a name.' });
      if (players.size >= MAX_PLAYERS) return ack({ error: 'Game is full.' });
      if ([...players.values()].some((p) => p.name.toLowerCase() === name.toLowerCase())) {
        return ack({ error: 'Name already taken.' });
      }
      const token = crypto.randomBytes(16).toString('hex');
      player = { id: crypto.randomBytes(4).toString('hex'), token, name, score: 0, streak: 0, wrongStreak: 0, vote: null, last: null, connected: true };
      players.set(token, player);
    }
    player.connected = true;
    socketPlayer.set(socket.id, player.token);
    ack({ token: player.token });
    broadcast();
  });

  socket.on('spectate', () => {
    socket.emit('state', stateFor(socket));
  });

  socket.on('vote', (v, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    const me = players.get(socketPlayer.get(socket.id));
    if (!me) return ack({ error: 'Not joined.' });
    if (game.phase !== 'voting') return ack({ error: 'Voting is closed.' });
    const ok = (x) => x === 'A' || x === 'B';
    if (!v || !ok(v.own) || !ok(v.majority) || !ok(v.host)) return ack({ error: 'Pick all three.' });
    me.vote = { own: v.own, majority: v.majority, host: v.host };
    ack({ ok: true });
    broadcast();
  });

  socket.on('admin:auth', (password, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    const a = Buffer.from(String(password));
    const b = Buffer.from(ADMIN_PASSWORD);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      adminSockets.add(socket.id);
      ack({ ok: true });
      socket.emit('state', stateFor(socket));
    } else {
      ack({ error: 'Wrong password.' });
    }
  });

  socket.on('admin:next', requireAdmin(() => {
    if (game.phase === 'voting' || game.phase === 'closed') return;
    if (game.qIndex + 1 >= questions.length) finish();
    else startQuestion();
    broadcast();
  }));

  socket.on('admin:host', requireAdmin((choice) => {
    if ((game.phase === 'voting' || game.phase === 'closed') && (choice === 'A' || choice === 'B')) {
      game.hostChoice = choice;
      broadcast();
    }
  }));

  socket.on('admin:reveal', requireAdmin(() => {
    reveal();
    broadcast();
  }));

  socket.on('admin:finish', requireAdmin(() => {
    finish();
    broadcast();
  }));

  socket.on('admin:kick', requireAdmin((id) => {
    for (const [token, p] of players) {
      if (p.id === id) players.delete(token);
    }
    broadcast();
  }));

  socket.on('admin:reset', requireAdmin(() => {
    clearTimer();
    players.clear();
    socketPlayer.clear();
    game = freshGame();
    io.emit('reset');
    broadcast();
  }));

  socket.on('disconnect', () => {
    adminSockets.delete(socket.id);
    const token = socketPlayer.get(socket.id);
    socketPlayer.delete(socket.id);
    const p = token && players.get(token);
    if (p && ![...socketPlayer.values()].includes(token)) p.connected = false;
    broadcast();
  });
});

server.listen(PORT, () => console.log(`SHIT-Game server on :${PORT} (admin password ${process.env.ADMIN_PASSWORD ? 'set' : 'DEFAULT "host"'})`));
