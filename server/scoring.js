const MAX_POINTS = 70;
const BASE = 2;
const BOTH_BONUS = 1;
const COMEBACK_BONUS = 3;
const STREAK_AFTER = 3;

// vote: { own, majority, host } | null. actualMajority is null on a tie (nobody is right).
function scorePlayer(player, vote, actualMajority, hostChoice) {
  const out = { majorityRight: false, hostRight: false, points: 0, parts: [], streak: player.streak, wrongStreak: player.wrongStreak };
  if (!vote) {
    out.streak = 0;
    return out;
  }
  out.majorityRight = actualMajority !== null && vote.majority === actualMajority;
  out.hostRight = hostChoice !== null && vote.host === hostChoice;
  const right = (out.majorityRight ? 1 : 0) + (out.hostRight ? 1 : 0);

  if (out.majorityRight) out.parts.push({ label: 'Majority', pts: BASE });
  if (out.hostRight) out.parts.push({ label: 'Host', pts: BASE });
  if (right === 2) out.parts.push({ label: 'Both correct', pts: BOTH_BONUS });

  if (right === 0) {
    out.wrongStreak = player.wrongStreak + 1;
    out.streak = 0;
  } else {
    if (player.wrongStreak >= 3) out.parts.push({ label: 'Comeback', pts: COMEBACK_BONUS });
    out.wrongStreak = 0;
    if (right === 2) {
      out.streak = player.streak + 1;
      if (out.streak > STREAK_AFTER) out.parts.push({ label: `Streak x${out.streak}`, pts: 1 });
    } else {
      out.streak = 0;
    }
  }

  const raw = out.parts.reduce((s, p) => s + p.pts, 0);
  out.points = Math.min(raw, Math.max(0, MAX_POINTS - player.score));
  return out;
}

module.exports = { scorePlayer, MAX_POINTS };
