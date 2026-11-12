import { createHash, randomBytes } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { isDuplicateKey, withTxn } from './db.js';
import { AppError } from './http.js';

// ---------- invite codes ----------

export const normalizeInviteCode = (raw) => raw.replace(/[\s-]/g, '').toUpperCase();

// Codes are high-entropy random values, so a plain SHA-256 is enough: there is nothing to brute-force offline.
export const hashInviteCode = (code) => createHash('sha256').update(code).digest('hex');

export function newInviteCode(config) {
  const raw = randomBytes(config.INVITE_CODE_BYTES).toString('hex').toUpperCase();
  return {
    code: raw.match(/.{1,4}/g).join('-'),
    hash: hashInviteCode(raw),
    expiresAt: new Date(Date.now() + config.INVITE_TTL_HOURS * 3600_000),
  };
}

// ---------- shapes ----------

export function publicTeam(t) {
  return {
    id: String(t._id),
    hackathonId: String(t.hackathonId),
    name: t.name,
    description: t.description,
    lookingFor: t.lookingFor,
    leaderId: String(t.leaderId),
    memberCount: t.memberCount,
    minSize: t.minSize,
    maxSize: t.maxSize,
    openSeats: t.maxSize - t.memberCount,
    status: t.memberCount >= t.minSize ? 'formed' : 'forming',
    createdAt: t.createdAt,
  };
}

const publicRequest = (r) => ({
  id: String(r._id),
  teamId: String(r.teamId),
  userId: String(r.userId),
  message: r.message,
  status: r.status,
  createdAt: r.createdAt,
});

const teamNotFound = () => new AppError(404, 'team_not_found', 'This team does not exist (it may have been deleted).');
const notLeader = () => new AppError(403, 'forbidden', 'Only the team leader can do this.');
const teamFull = (teamId) => new AppError(409, 'team_full', 'This team is already full.', { details: { teamId: String(teamId) } });

// ---------- building blocks (always called inside a transaction) ----------

// Adjusts memberCount and recomputes isOpen from the new value in one atomic update.
const seatDelta = (delta) => [
  { $set: { memberCount: { $add: ['$memberCount', delta] } } },
  { $set: { isOpen: { $lt: ['$memberCount', '$maxSize'] }, updatedAt: '$$NOW' } },
];

/**
 * The seat claim. The filter and the increment are one atomic document update, so two claims can
 * never both pass `memberCount < maxSize` for the last seat. Returns the updated team, or null if
 * no team matched (missing, full, or failing `guard`).
 */
function claimSeat(ctx, session, guard) {
  return ctx.teams.findOneAndUpdate(
    { ...guard, $expr: { $lt: ['$memberCount', '$maxSize'] } },
    seatDelta(1),
    { session, returnDocument: 'after' },
  );
}

function audit(ctx, session, actor, entry) {
  return ctx.auditLog.insertOne({ ...entry, actorId: actor.userId, requestId: actor.requestId, at: new Date() }, { session });
}

/** Membership insert + cleanup of the user's other pending requests + audit entry. `team` already has the seat. */
async function addMember(ctx, session, actor, team, userId, action) {
  try {
    await ctx.memberships.insertOne({ hackathonId: team.hackathonId, teamId: team._id, userId, joinedAt: new Date() }, { session });
  } catch (err) {
    // The unique index (hackathonId, userId) is the final word on "one team per person".
    if (isDuplicateKey(err)) throw new AppError(409, 'already_on_team', 'This person is already on a team in this hackathon.');
    throw err;
  }
  const stale = await ctx.joinRequests
    .find({ hackathonId: team.hackathonId, userId, status: 'pending' }, { session, projection: { teamId: 1 } })
    .toArray();
  if (stale.length) {
    await ctx.joinRequests.updateMany(
      { _id: { $in: stale.map((r) => r._id) } },
      { $set: { status: 'cancelled', decidedAt: new Date() } },
      { session },
    );
  }
  await audit(ctx, session, actor, {
    action,
    hackathonId: team.hackathonId,
    teamId: team._id,
    targetId: userId,
    before: { memberCount: team.memberCount - 1 },
    after: { memberCount: team.memberCount },
  });
  return [
    { type: 'member.joined', teamId: team._id, userId, team: publicTeam(team) },
    ...stale.map((r) => ({ type: 'request.cancelled', teamId: r.teamId, requestId: r._id })),
  ];
}

// ---------- mutations: each returns { result, events }; events are published only after commit ----------

export function createTeam(ctx, actor, { name, description, lookingFor }) {
  const h = ctx.hackathon;
  const invite = newInviteCode(ctx.config);
  const now = new Date();
  const team = {
    _id: new ObjectId(),
    hackathonId: h._id,
    name,
    description,
    lookingFor,
    leaderId: actor.userId,
    memberCount: 0,
    minSize: h.minTeamSize,
    maxSize: h.maxTeamSize,
    isOpen: true,
    inviteCodeHash: invite.hash,
    inviteExpiresAt: invite.expiresAt,
    createdAt: now,
    updatedAt: now,
  };
  return withTxn(ctx, async (session) => {
    await ctx.teams.insertOne(team, { session });
    // The creator takes the first seat through the same path as everyone else.
    const seated = await claimSeat(ctx, session, { _id: team._id });
    const [joined] = await addMember(ctx, session, actor, seated, actor.userId, 'team.created');
    return {
      result: { team: publicTeam(seated), invite: { code: invite.code, expiresAt: invite.expiresAt } },
      events: [{ ...joined, type: 'team.created' }],
    };
  });
}

export function redeemInvite(ctx, actor, rawCode) {
  const hash = hashInviteCode(normalizeInviteCode(rawCode));
  return withTxn(ctx, async (session) => {
    const valid = { inviteCodeHash: hash, inviteExpiresAt: { $gt: new Date() } };
    const team = await claimSeat(ctx, session, valid);
    if (!team) {
      const existing = await ctx.teams.findOne(valid, { session, projection: { _id: 1 } });
      // Unknown and expired codes get the same answer, so the endpoint is not an oracle.
      throw existing ? teamFull(existing._id) : new AppError(404, 'invite_invalid', 'This invite code is invalid or has expired.');
    }
    const events = await addMember(ctx, session, actor, team, actor.userId, 'member.joined_by_invite');
    return { result: { team: publicTeam(team) }, events };
  });
}

export function regenerateInvite(ctx, actor, teamId) {
  const invite = newInviteCode(ctx.config);
  return withTxn(ctx, async (session) => {
    const team = await ctx.teams.findOneAndUpdate(
      { _id: teamId, leaderId: actor.userId },
      { $set: { inviteCodeHash: invite.hash, inviteExpiresAt: invite.expiresAt, updatedAt: new Date() } },
      { session, projection: { hackathonId: 1 } },
    );
    if (!team) throw (await ctx.teams.findOne({ _id: teamId }, { session, projection: { _id: 1 } })) ? notLeader() : teamNotFound();
    await audit(ctx, session, actor, {
      action: 'invite.regenerated',
      hackathonId: team.hackathonId,
      teamId,
      targetId: null,
      before: null,
      after: { expiresAt: invite.expiresAt },
    });
    return { result: { invite: { code: invite.code, expiresAt: invite.expiresAt } }, events: [] };
  });
}

/** Leave (targetId is the actor) or remove (leader removes someone else). */
export function removeMember(ctx, actor, teamId, targetId) {
  const isSelf = targetId.equals(actor.userId);
  return withTxn(ctx, async (session) => {
    const before = await ctx.teams.findOne({ _id: teamId }, { session });
    if (!before) throw teamNotFound();
    if (!isSelf && !before.leaderId.equals(actor.userId)) throw notLeader();

    const { deletedCount } = await ctx.memberships.deleteOne({ teamId, userId: targetId }, { session });
    if (!deletedCount) throw new AppError(404, 'not_a_member', 'That person is not a member of this team.');
    const base = { hackathonId: before.hackathonId, teamId, targetId };

    if (before.memberCount === 1) {
      // Last member out: the team, its invite code (stored on the team) and its pending requests go together.
      await ctx.teams.deleteOne({ _id: teamId }, { session });
      const { modifiedCount } = await ctx.joinRequests.updateMany(
        { teamId, status: 'pending' },
        { $set: { status: 'cancelled', decidedAt: new Date() } },
        { session },
      );
      await audit(ctx, session, actor, {
        ...base,
        action: 'team.deleted',
        before: { memberCount: 1, name: before.name },
        after: { cancelledRequests: modifiedCount },
      });
      return { result: { team: null }, events: [{ type: 'team.deleted', teamId, userId: targetId }] };
    }

    // Writing the team document is what serialises this against concurrent joins: whichever
    // transaction writes second gets a WriteConflict and is retried against the committed state.
    let team = await ctx.teams.findOneAndUpdate({ _id: teamId }, seatDelta(-1), { session, returnDocument: 'after' });
    const events = [];
    if (before.leaderId.equals(targetId)) {
      const [next] = await ctx.memberships.find({ teamId }, { session }).sort({ joinedAt: 1, _id: 1 }).limit(1).toArray();
      team = await ctx.teams.findOneAndUpdate({ _id: teamId }, { $set: { leaderId: next.userId } }, { session, returnDocument: 'after' });
      await audit(ctx, session, actor, {
        ...base,
        action: 'leader.changed',
        targetId: next.userId,
        before: { leaderId: targetId },
        after: { leaderId: next.userId },
      });
      events.push({ type: 'leader.changed', teamId, userId: next.userId, team: publicTeam(team) });
    }
    await audit(ctx, session, actor, {
      ...base,
      action: isSelf ? 'member.left' : 'member.removed',
      before: { memberCount: before.memberCount },
      after: { memberCount: team.memberCount },
    });
    events.unshift({ type: isSelf ? 'member.left' : 'member.removed', teamId, userId: targetId, team: publicTeam(team) });
    return { result: { team: publicTeam(team) }, events };
  });
}

export function createRequest(ctx, actor, teamId, message) {
  const request = { _id: new ObjectId(), teamId, userId: actor.userId, message, status: 'pending', createdAt: new Date() };
  return withTxn(ctx, async (session) => {
    const team = await ctx.teams.findOne({ _id: teamId }, { session });
    if (!team) throw teamNotFound();
    if (!team.isOpen) throw teamFull(teamId);
    const membership = await ctx.memberships.findOne({ hackathonId: team.hackathonId, userId: actor.userId }, { session });
    if (membership) {
      throw new AppError(409, 'already_on_team', membership.teamId.equals(teamId) ? 'You are already on this team.' : 'You are already on a team; leave it first.');
    }
    try {
      await ctx.joinRequests.insertOne({ ...request, hackathonId: team.hackathonId }, { session });
    } catch (err) {
      if (isDuplicateKey(err)) throw new AppError(409, 'request_exists', 'You already have a pending request for this team.');
      throw err;
    }
    await audit(ctx, session, actor, {
      action: 'request.created',
      hackathonId: team.hackathonId,
      teamId,
      targetId: actor.userId,
      before: null,
      after: { requestId: request._id },
    });
    return { result: { request: publicRequest(request) }, events: [{ type: 'request.created', teamId, requestId: request._id }] };
  });
}

export async function acceptRequest(ctx, actor, requestId) {
  const request = await ctx.joinRequests.findOne({ _id: requestId });
  if (!request) throw new AppError(404, 'request_not_found', 'This request does not exist.');
  const leaderGuard = { _id: request.teamId, leaderId: actor.userId };
  try {
    return await withTxn(ctx, async (session) => {
      // Authorization first, so a non-leader learns nothing about the request's state.
      const current = await ctx.teams.findOne({ _id: request.teamId }, { session, projection: { leaderId: 1 } });
      if (!current) throw teamNotFound();
      if (!current.leaderId.equals(actor.userId)) throw notLeader();

      const accepted = await ctx.joinRequests.findOneAndUpdate(
        { _id: requestId, status: 'pending' },
        { $set: { status: 'accepted', decidedAt: new Date(), decidedBy: actor.userId } },
        { session },
      );
      if (!accepted) throw new AppError(409, 'request_not_pending', 'This request was already handled.');

      // leaderId is part of the claim filter, so a leadership change that commits first makes this fail.
      const team = await claimSeat(ctx, session, leaderGuard);
      if (!team) throw teamFull(request.teamId);

      const events = await addMember(ctx, session, actor, team, request.userId, 'request.accepted');
      events.push({ type: 'request.accepted', teamId: team._id, requestId });
      return { result: { team: publicTeam(team) }, events };
    });
  } catch (err) {
    if (err instanceof AppError && err.code === 'already_on_team') {
      // The requester joined another team after asking. The aborted transaction left the request pending; retire it.
      await ctx.joinRequests.updateOne({ _id: requestId, status: 'pending' }, { $set: { status: 'cancelled', decidedAt: new Date() } });
    }
    throw err;
  }
}

/** decline (by the leader) or cancel (by the requester). */
export async function closeRequest(ctx, actor, requestId, status) {
  const request = await ctx.joinRequests.findOne({ _id: requestId });
  if (!request) throw new AppError(404, 'request_not_found', 'This request does not exist.');
  return withTxn(ctx, async (session) => {
    if (status === 'cancelled') {
      if (!request.userId.equals(actor.userId)) throw new AppError(403, 'forbidden', 'You can only cancel your own request.');
    } else {
      const team = await ctx.teams.findOne({ _id: request.teamId }, { session, projection: { leaderId: 1 } });
      if (!team) throw teamNotFound();
      if (!team.leaderId.equals(actor.userId)) throw notLeader();
    }
    const closed = await ctx.joinRequests.findOneAndUpdate(
      { _id: requestId, status: 'pending' },
      { $set: { status, decidedAt: new Date(), decidedBy: actor.userId } },
      { session, returnDocument: 'after' },
    );
    if (!closed) throw new AppError(409, 'request_not_pending', 'This request was already handled.');
    await audit(ctx, session, actor, {
      action: `request.${status}`,
      hackathonId: request.hackathonId,
      teamId: request.teamId,
      targetId: request.userId,
      before: { status: 'pending' },
      after: { status },
    });
    return { result: { request: publicRequest(closed) }, events: [{ type: `request.${status}`, teamId: request.teamId, requestId }] };
  });
}

// ---------- queries ----------

export async function listBoard(ctx, hackathonId, { cursor, limit, skill }) {
  const filter = { hackathonId, isOpen: true };
  if (skill) filter.lookingFor = skill;
  if (cursor) filter._id = { $lt: cursor };
  // Fetch one extra row to learn whether another page exists, without a count query.
  const rows = await ctx.teams.find(filter).sort({ _id: -1 }).limit(limit + 1).toArray();
  const items = rows.slice(0, limit);
  return { items: items.map(publicTeam), nextCursor: rows.length > limit ? String(items.at(-1)._id) : null };
}

const publicUser = (u) => ({ id: String(u._id), displayName: u.displayName, skills: u.skills, timezone: u.timezone });

export async function getTeam(ctx, teamId) {
  const team = await ctx.teams.findOne({ _id: teamId });
  if (!team) throw teamNotFound();
  const memberships = await ctx.memberships.find({ teamId }).sort({ joinedAt: 1, _id: 1 }).toArray();
  const users = await ctx.users.find({ _id: { $in: memberships.map((m) => m.userId) } }).toArray();
  const byId = new Map(users.map((u) => [String(u._id), u]));
  return {
    team: publicTeam(team),
    inviteExpiresAt: team.inviteExpiresAt,
    members: memberships.map((m) => ({
      ...publicUser(byId.get(String(m.userId))),
      joinedAt: m.joinedAt,
      isLeader: m.userId.equals(team.leaderId),
    })),
  };
}

async function requireLeader(ctx, actor, teamId) {
  const team = await ctx.teams.findOne({ _id: teamId }, { projection: { leaderId: 1 } });
  if (!team) throw teamNotFound();
  if (!team.leaderId.equals(actor.userId)) throw notLeader();
}

export async function listRequests(ctx, actor, teamId) {
  await requireLeader(ctx, actor, teamId);
  const requests = await ctx.joinRequests.find({ teamId, status: 'pending' }).sort({ _id: 1 }).toArray();
  const users = await ctx.users.find({ _id: { $in: requests.map((r) => r.userId) } }).toArray();
  const byId = new Map(users.map((u) => [String(u._id), u]));
  return { requests: requests.map((r) => ({ ...publicRequest(r), user: publicUser(byId.get(String(r.userId))) })) };
}

export async function listAudit(ctx, actor, teamId, { cursor, limit }) {
  await requireLeader(ctx, actor, teamId);
  const filter = { teamId, ...(cursor && { _id: { $lt: cursor } }) };
  const rows = await ctx.auditLog.find(filter).sort({ _id: -1 }).limit(limit + 1).toArray();
  const items = rows.slice(0, limit);
  return {
    items: items.map((e) => ({
      id: String(e._id),
      action: e.action,
      actorId: String(e.actorId),
      targetId: e.targetId && String(e.targetId),
      before: e.before,
      after: e.after,
      requestId: e.requestId,
      at: e.at,
    })),
    nextCursor: rows.length > limit ? String(items.at(-1)._id) : null,
  };
}

/** The caller's own state in a hackathon: which team they are on and which requests they have pending. */
export async function getMyState(ctx, actor, hackathonId) {
  const [membership, requests] = await Promise.all([
    ctx.memberships.findOne({ hackathonId, userId: actor.userId }),
    ctx.joinRequests.find({ hackathonId, userId: actor.userId, status: 'pending' }).toArray(),
  ]);
  return { teamId: membership ? String(membership.teamId) : null, pendingRequests: requests.map(publicRequest) };
}
