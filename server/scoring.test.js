const assert = require('assert');
const { scorePlayer } = require('./scoring');

const p = (o = {}) => ({ score: 0, streak: 0, wrongStreak: 0, ...o });
const v = (majority, host) => ({ own: 'A', majority, host });

let r = scorePlayer(p(), v('A', 'A'), 'A', 'A');
assert.strictEqual(r.points, 5);
assert.strictEqual(r.streak, 1);

r = scorePlayer(p(), v('A', 'B'), 'A', 'A');
assert.strictEqual(r.points, 2);

r = scorePlayer(p({ wrongStreak: 3 }), v('A', 'B'), 'A', 'A');
assert.strictEqual(r.points, 5);
assert.strictEqual(r.wrongStreak, 0);

r = scorePlayer(p({ streak: 3 }), v('A', 'A'), 'A', 'A');
assert.strictEqual(r.points, 6);

r = scorePlayer(p({ streak: 2 }), v('A', 'A'), 'A', 'A');
assert.strictEqual(r.points, 5);

r = scorePlayer(p({ score: 78 }), v('A', 'A'), 'A', 'A');
assert.strictEqual(r.points, 2);

r = scorePlayer(p(), v('A', 'A'), 'A', 'A', 2);
assert.strictEqual(r.points, 10);

r = scorePlayer(p(), v('B', 'B'), 'A', 'A');
assert.strictEqual(r.points, 0);
assert.strictEqual(r.wrongStreak, 1);

r = scorePlayer(p({ streak: 5 }), null, 'A', 'A');
assert.strictEqual(r.streak, 0);

r = scorePlayer(p(), v('A', 'A'), null, 'A');
assert.strictEqual(r.points, 2);

console.log('scoring ok');
