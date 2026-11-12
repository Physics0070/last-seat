export const SKILLS = [
  'frontend', 'backend', 'mobile', 'design', 'ml', 'data', 'devops', 'security',
  'product', 'pitching', 'hardware', 'game-dev', 'blockchain', 'cloud', 'testing', 'writing',
];

export const isTimezone = (tz) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/** Current UTC offset of an IANA zone in minutes, e.g. Asia/Kolkata -> 330. */
export function utcOffsetMinutes(timezone, at = new Date()) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'longOffset' })
    .formatToParts(at)
    .find((p) => p.type === 'timeZoneName').value;
  const m = /GMT(?:([+-])(\d{2}):(\d{2}))?/.exec(name);
  return m[1] ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
}

const round = (n) => Math.round(n * 1000) / 1000;

/**
 * Scores how well `person` complements `group` (a team, or a single user looking for teammates).
 *
 *   skill    = min(1, points / SKILL_TARGET)
 *              points = skills the person has that nobody in the group has,
 *                       counted twice when the group explicitly listed them in lookingFor
 *   timezone = average over group members of  max(0, WORKDAY - hoursApart) / WORKDAY
 *              hoursApart is the circular distance between UTC offsets (0..12)
 *   score    = (wSkill * skill + wTz * timezone) / (wSkill + wTz)
 *
 * Pure function: everything it needs is passed in, and the breakdown explains the number.
 */
export function scoreMatch(person, group, cfg) {
  const newSkills = person.skills.filter((s) => !group.skills.has(s));
  const wantedSkills = newSkills.filter((s) => group.lookingFor.has(s));
  const skill = Math.min(1, (newSkills.length + wantedSkills.length) / cfg.SUGGEST_SKILL_TARGET);

  const overlaps = group.offsets.map((offset) => {
    const apart = Math.abs(person.utcOffsetMinutes - offset) / 60;
    return Math.max(0, cfg.SUGGEST_WORKDAY_HOURS - Math.min(apart, 24 - apart));
  });
  const overlapHours = overlaps.reduce((a, b) => a + b, 0) / overlaps.length;
  const timezone = overlapHours / cfg.SUGGEST_WORKDAY_HOURS;

  const wSkill = cfg.SUGGEST_SKILL_WEIGHT;
  const wTz = cfg.SUGGEST_TZ_WEIGHT;
  return {
    score: round((wSkill * skill + wTz * timezone) / (wSkill + wTz)),
    breakdown: { skill: round(skill), timezone: round(timezone), newSkills, wantedSkills, overlapHours: round(overlapHours) },
  };
}

const groupOf = (users, lookingFor = []) => ({
  skills: new Set(users.flatMap((u) => u.skills)),
  lookingFor: new Set(lookingFor),
  offsets: users.map((u) => u.utcOffsetMinutes),
});

const top = (scored, limit) => scored.sort((a, b) => b.score - a.score).slice(0, limit);
const profile = { displayName: 1, skills: 1, timezone: 1, utcOffsetMinutes: 1 };

/** People without a team, ranked for the caller's team (or for the caller alone if they have none). */
export async function suggestPeople(ctx, hackathonId, userId) {
  const memberships = await ctx.memberships.find({ hackathonId }, { projection: { _id: 0, userId: 1, teamId: 1 } }).toArray();
  const taken = new Set(memberships.map((m) => String(m.userId)));
  const mine = memberships.find((m) => m.userId.equals(userId));

  let group;
  let teamId = null;
  if (mine) {
    teamId = String(mine.teamId);
    const mateIds = memberships.filter((m) => m.teamId.equals(mine.teamId)).map((m) => m.userId);
    const [team, mates] = await Promise.all([
      ctx.teams.findOne({ _id: mine.teamId }, { projection: { lookingFor: 1 } }),
      ctx.users.find({ _id: { $in: mateIds } }, { projection: profile }).toArray(),
    ]);
    group = groupOf(mates, team.lookingFor);
  } else {
    group = groupOf([await ctx.users.findOne({ _id: userId }, { projection: profile })]);
  }

  // ponytail: scores every user in memory (10k users is a few ms of CPU). Past ~100k users,
  // pre-filter with an index on skills ($in: skills the group lacks) or precompute per team.
  const candidates = await ctx.users.find({}, { projection: profile }).toArray();
  const scored = candidates
    .filter((u) => !taken.has(String(u._id)) && !u._id.equals(userId))
    .map((u) => ({ user: { id: String(u._id), displayName: u.displayName, skills: u.skills, timezone: u.timezone }, ...scoreMatch(u, group, ctx.config) }));
  return { for: teamId ? { teamId } : { userId: String(userId) }, suggestions: top(scored, ctx.config.SUGGEST_LIMIT) };
}

/** Open teams ranked for a user: the same formula, with the user as the candidate. Used after losing a race. */
export async function suggestTeams(ctx, hackathonId, userId, publicTeam) {
  const [user, teams] = await Promise.all([
    ctx.users.findOne({ _id: userId }, { projection: profile }),
    // Bounded pool: the newest open teams, straight off the board index.
    ctx.teams.find({ hackathonId, isOpen: true }).sort({ _id: -1 }).limit(ctx.config.SUGGEST_TEAM_POOL).toArray(),
  ]);
  const memberships = await ctx.memberships
    .find({ teamId: { $in: teams.map((t) => t._id) } }, { projection: { _id: 0, userId: 1, teamId: 1 } })
    .toArray();
  const users = await ctx.users.find({ _id: { $in: memberships.map((m) => m.userId) } }, { projection: profile }).toArray();
  const userById = new Map(users.map((u) => [String(u._id), u]));
  const membersByTeam = Map.groupBy(memberships, (m) => String(m.teamId));

  const scored = teams.map((t) => {
    const members = membersByTeam.get(String(t._id)).map((m) => userById.get(String(m.userId)));
    return { team: publicTeam(t), ...scoreMatch(user, groupOf(members, t.lookingFor), ctx.config) };
  });
  return { for: { userId: String(userId) }, suggestions: top(scored, ctx.config.SUGGEST_LIMIT) };
}
