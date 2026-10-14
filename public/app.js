(() => {
  const app = document.getElementById('app');
  const socket = io(window.BACKEND_URL || undefined, { transports: ['websocket', 'polling'] });
  const isAdminPage = location.hash === '#admin';

  let state = null;
  let joined = false;
  let adminOk = false;
  let draft = {};
  let draftQ = -1;
  let viewKey = '';
  let offset = 0;
  let error = '';

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = (sel) => app.querySelector(sel);

  function tryJoin(name) {
    socket.emit('join', { name, token: localStorage.getItem('shit_token') }, (res) => {
      if (res.error) {
        error = res.error;
        joined = false;
        viewKey = '';
        render();
        return;
      }
      localStorage.setItem('shit_token', res.token);
      if (name) localStorage.setItem('shit_name', name);
      joined = true;
      error = '';
      viewKey = '';
      render();
    });
  }

  socket.on('connect', () => {
    if (isAdminPage) {
      const pw = sessionStorage.getItem('shit_admin');
      if (pw) socket.emit('admin:auth', pw, (r) => { adminOk = !!r.ok; viewKey = ''; render(); });
      else socket.emit('spectate');
    } else if (localStorage.getItem('shit_token')) {
      tryJoin(localStorage.getItem('shit_name') || '');
    } else {
      socket.emit('spectate');
    }
  });

  socket.on('reset', () => {
    localStorage.removeItem('shit_token');
    joined = false;
    viewKey = '';
  });

  socket.on('state', (s) => {
    state = s;
    offset = s.serverNow - Date.now();
    if (s.qIndex !== draftQ) { draftQ = s.qIndex; draft = {}; }
    if (!isAdminPage && joined && !s.me) { joined = false; viewKey = ''; }
    render();
  });

  function header() {
    return '<h1>Would you rather…?</h1>';
  }

  function optHtml(q, side, cls, extra = '') {
    const txt = side === 'A' ? q.a : q.b;
    const em = side === 'A' ? q.emojiA : q.emojiB;
    return `<button class="opt ${side.toLowerCase()} ${cls || ''} ${extra}" data-side="${side}">
      <span class="emoji">${em || ''}</span><span class="tag">${side}</span><span>${esc(txt)}</span></button>`;
  }

  function leaderboardHtml(meId, limit) {
    const rows = state.leaderboard.slice(0, limit || 1000).map((p, i) => `
      <tr class="${p.id === meId ? 'me' : ''} ${p.connected ? '' : 'off'}">
        <td>${i + 1}</td><td>${esc(p.name)} ${p.score >= state.maxPoints ? '<span class="badge">🎁 70</span>' : ''}</td><td class="n">${p.score}</td></tr>`).join('');
    return `<table><thead><tr><th>#</th><th>Player</th><th class="n">Points</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  function resultHtml(q) {
    const r = state.result;
    const max = Math.max(r.own.A, r.own.B, 1);
    const bar = (s) => `<div class="res"><b style="width:18px">${s}</b><div class="fill ${s.toLowerCase()}" style="width:${(r['own'][s] / max) * 70}%"></div><span>${r.own[s]}</span></div>`;
    const maj = r.majority ? `Majority: <b>${r.majority}</b>` : 'Majority: <b>tie</b> (nobody scores)';
    return `<div class="panel"><div class="bars">${bar('A')}${bar('B')}</div>
      <div class="center">${maj} &nbsp;·&nbsp; Host: <b>${r.host || '—'}</b></div></div>`;
  }

  function render() {
    if (!state) { app.innerHTML = header() + '<p class="center muted">Connecting…</p>'; return; }
    if (isAdminPage) return renderAdmin();
    if (!joined) return renderJoin();
    renderPlayer();
  }

  function renderJoin() {
    if (viewKey === 'join') {
      const e = $('.err');
      if (e) e.textContent = error;
      return;
    }
    viewKey = 'join';
    app.innerHTML = `${header()}<div class="panel">
      <h2>Join the game</h2>
      <p class="muted">${state.playerCount} player(s) in the lobby.</p>
      <p class="err">${esc(error)}</p>
      <input id="name" maxlength="20" placeholder="Your name" autocomplete="off" value="${esc(localStorage.getItem('shit_name') || '')}">
      <button id="go" style="width:100%">Join</button></div>`;
    const go = () => { const n = $('#name').value.trim(); if (n) tryJoin(n); };
    $('#go').onclick = go;
    $('#name').onkeydown = (e) => { if (e.key === 'Enter') go(); };
  }

  function renderPlayer() {
    viewKey = 'player';
    const me = state.me;
    const q = state.question;
    let html = header();
    const head = `<p class="center muted small">${esc(me.name)} · ${me.score} / ${state.maxPoints} pts · rank ${me.rank}/${state.playerCount}</p>`;

    if (state.phase === 'lobby') {
      html += `${head}<div class="panel center"><h2>Waiting for the host…</h2>
        <p class="muted">${state.playerCount} player(s) joined.</p></div>`;
    } else if (state.phase === 'voting' || state.phase === 'closed') {
      const open = state.phase === 'voting';
      const voted = !!me.vote;
      const pick = voted && !draft.edited ? me.vote : draft;
      if (q.hint) html += `<p class="hint">${esc(q.hint)}</p>`;
      html += `${head}<div class="timer" id="timer"></div><div class="bar"><div id="bar"></div></div>`;
      const steps = [['own', '1 · Your own choice'], ['majority', '2 · The majority’s choice'], ['host', '3 · The host’s choice']];
      steps.forEach(([k, label], i) => {
        html += `<div class="step ${i ? 'compact' : ''}" data-k="${k}"><h3>${label}</h3><div class="opts">
          ${['A', 'B'].map((s) => optHtml(q, s, pick[k] === s ? 'sel' : '')).join('')}</div></div>`;
      });
      const ready = pick.own && pick.majority && pick.host;
      html += `<button id="send" style="width:100%" ${open && ready ? '' : 'disabled'}>${voted ? 'Update vote' : 'Submit vote'}</button>
        <p class="center muted small">${!open ? 'Voting closed.' : voted ? '✅ Vote saved – you can still change it.' : 'Pick all three, then submit.'}</p>`;
    } else if (state.phase === 'reveal') {
      const l = me.last;
      html += `${head}${resultHtml(q)}`;
      if (l && l.voted) {
        html += `<div class="panel"><div class="delta">+${l.points}</div>
          <div class="parts">${l.parts.length ? l.parts.map((p) => `${esc(p.label)} +${p.pts}`).join(' · ') : 'No points this round'}</div>
          <p class="center muted small">Streak: ${me.streak} · Misses in a row: ${me.wrongStreak}</p></div>`;
      } else {
        html += '<div class="panel center muted">You did not vote this round.</div>';
      }
      html += `<div class="panel"><h2>Leaderboard</h2>${leaderboardHtml(me.id, 10)}</div>`;
    } else {
      html += `${head}<div class="panel"><h2 class="center">🏆 Final ranking</h2>${leaderboardHtml(me.id)}</div>
        <p class="center">${me.score >= state.maxPoints ? '🎁 You reached 70 points – pick up your gift!' : 'Applause for the winner! 👏'}</p>`;
    }
    app.innerHTML = html;

    app.querySelectorAll('.step .opt').forEach((b) => {
      b.onclick = () => {
        if (state.phase !== 'voting') return;
        const k = b.closest('.step').dataset.k;
        if (!draft.edited) draft = { ...(state.me.vote || {}), edited: true };
        draft[k] = b.dataset.side;
        renderPlayer();
      };
    });
    const send = $('#send');
    if (send) send.onclick = () => {
      const pick = draft.edited ? draft : state.me.vote;
      socket.emit('vote', { own: pick.own, majority: pick.majority, host: pick.host }, (r) => {
        if (r && r.error) alert(r.error);
        draft = {};
      });
    };
    tick();
  }

  function renderAdminLogin() {
    if (viewKey === 'login') {
      const e = $('.err');
      if (e) e.textContent = error;
      return;
    }
    viewKey = 'login';
    app.innerHTML = `${header()}<div class="panel"><h2>Host login</h2><p class="err">${esc(error)}</p>
      <input id="pw" type="password" placeholder="Admin password"><button id="go" style="width:100%">Login</button></div>`;
    const go = () => {
      const pw = $('#pw').value;
      socket.emit('admin:auth', pw, (r) => {
        if (r.ok) { sessionStorage.setItem('shit_admin', pw); adminOk = true; error = ''; viewKey = ''; }
        else error = r.error;
        render();
      });
    };
    $('#go').onclick = go;
    $('#pw').onkeydown = (e) => { if (e.key === 'Enter') go(); };
  }

  function renderAdmin() {
    if (!adminOk || !state.admin) return renderAdminLogin();
    viewKey = 'admin';
    const q = state.question;
    const ph = state.phase;
    let html = `${header()}<p class="center muted">Host panel · ${state.playerCount} players · question ${Math.max(state.qIndex + 1, 0)}/${state.total}</p>`;

    if (q) {
      if (q.hint) html += `<p class="hint">${esc(q.hint)}</p>`;
      html += `<div class="opts" style="margin-bottom:16px">${optHtml(q, 'A', state.hostChoice === 'A' ? 'sel' : '')}${optHtml(q, 'B', state.hostChoice === 'B' ? 'sel' : '')}</div>`;
    }
    if (ph === 'voting') html += '<div class="timer" id="timer"></div><div class="bar"><div id="bar"></div></div>';
    if (ph === 'voting' || ph === 'closed') {
      html += `<p class="center">Your (host) choice: <b>${state.hostChoice || 'not chosen yet – click A or B above'}</b></p>
        <p class="center muted">${state.votedCount} / ${state.playerCount} voted${ph === 'closed' ? ' · time is up' : ''}</p>
        <button id="reveal" style="width:100%" ${state.hostChoice ? '' : 'disabled'}>Reveal result</button>`;
    } else if (ph === 'reveal') {
      html += resultHtml(q);
    }
    if (ph === 'lobby' || ph === 'reveal') {
      html += `<div class="row" style="margin:12px 0"><button id="next" ${state.nextAvailable ? '' : 'disabled'}>${ph === 'lobby' ? 'Start first question' : 'Next question'}</button>
        <button id="fin" class="secondary">Finish game</button></div>`;
    }
    html += `<div class="panel"><h2>Leaderboard</h2>${leaderboardHtml(null, 15)}</div>`;
    html += `<div class="panel"><h2>Players</h2><table>${state.players.map((p) => `<tr class="${p.connected ? '' : 'off'}"><td>${esc(p.name)}</td>
      <td>${ph === 'voting' || ph === 'closed' ? (p.voted ? '✅' : '…') : ''}</td><td class="n"><button class="secondary small" data-kick="${p.id}">Kick</button></td></tr>`).join('')}</table></div>
      <div class="center"><button id="reset" class="warn">Reset whole game</button></div>`;
    app.innerHTML = html;

    app.querySelectorAll('.opt').forEach((b) => { b.onclick = () => socket.emit('admin:host', b.dataset.side); });
    const on = (id, ev) => { const el = $(id); if (el) el.onclick = () => socket.emit(ev); };
    on('#reveal', 'admin:reveal'); on('#next', 'admin:next'); on('#fin', 'admin:finish');
    const rs = $('#reset');
    if (rs) rs.onclick = () => { if (confirm('Delete all players and scores?')) socket.emit('admin:reset'); };
    app.querySelectorAll('[data-kick]').forEach((b) => { b.onclick = () => socket.emit('admin:kick', b.dataset.kick); });
    tick();
  }

  function tick() {
    const t = $('#timer');
    if (!t || !state || !state.endsAt) return;
    const total = state.voteSeconds;
    const left = Math.max(0, (state.endsAt - (Date.now() + offset)) / 1000);
    t.textContent = Math.ceil(left) + 's';
    t.classList.toggle('low', left <= 10);
    const bar = $('#bar');
    if (bar) bar.style.width = Math.min(100, (left / total) * 100) + '%';
  }
  setInterval(tick, 250);
})();
