// Inserts SEED_USERS users and SEED_TEAMS teams with consistent memberships.
// Idempotent: every seeded document carries `seed: true`; a re-run removes those and inserts again.
import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { ObjectId } from 'mongodb';
import { pino } from 'pino';
import { z } from 'zod';
import { loadConfig, loadEnvFile } from '../src/config.js';
import { connectDb } from '../src/db.js';
import { SKILLS, utcOffsetMinutes } from '../src/suggestions.js';
import { hashInviteCode } from '../src/teams.js';

loadEnvFile();
const config = loadConfig();
const seedConfig = z
  .object({
    SEED_USERS: z.coerce.number().int().min(1),
    SEED_TEAMS: z.coerce.number().int().min(0),
    SEED_RANDOM_SEED: z.coerce.number().int(),
    SEED_PASSWORD: z.string().min(8, 'set SEED_PASSWORD (min 8 characters) in .env'),
  })
  .parse(process.env);

// mulberry32: a small deterministic PRNG, so the same SEED_RANDOM_SEED always produces the same data set.
let state = seedConfig.SEED_RANDOM_SEED >>> 0;
function random() {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const int = (min, max) => min + Math.floor(random() * (max - min + 1));
const pick = (list) => list[int(0, list.length - 1)];
const sample = (list, count) => {
  const pool = [...list];
  return Array.from({ length: Math.min(count, pool.length) }, () => pool.splice(int(0, pool.length - 1), 1)[0]);
};

// Repeated entries weight the draw towards where hackathon participants cluster.
const ZONES = [
  'Asia/Kolkata', 'Asia/Kolkata', 'Asia/Kolkata', 'Asia/Kolkata', 'America/New_York', 'America/New_York',
  'America/Los_Angeles', 'America/Los_Angeles', 'Europe/London', 'Europe/London', 'Europe/Berlin', 'Europe/Berlin',
  'America/Chicago', 'America/Sao_Paulo', 'Africa/Lagos', 'Asia/Singapore', 'Asia/Tokyo', 'Asia/Dubai',
  'Australia/Sydney', 'America/Toronto', 'Europe/Warsaw', 'Asia/Jakarta', 'Africa/Nairobi', 'America/Mexico_City',
];
const FIRST = ['Aarav', 'Maya', 'Liam', 'Sofia', 'Noah', 'Zara', 'Kenji', 'Amara', 'Lucas', 'Priya', 'Omar', 'Elena', 'Kofi', 'Mei', 'Diego', 'Anika', 'Jonas', 'Leila', 'Tariq', 'Ines'];
const LAST = ['Sharma', 'Okafor', 'Nguyen', 'Garcia', 'Kim', 'Novak', 'Haddad', 'Silva', 'Tanaka', 'Mensah', 'Rossi', 'Patel', 'Schmidt', 'Costa', 'Ali', 'Larsen', 'Dubois', 'Mwangi', 'Reyes', 'Kaur'];
const ADJECTIVES = ['Quiet', 'Rapid', 'Lunar', 'Amber', 'Fuzzy', 'Brave', 'Cosmic', 'Nimble', 'Solar', 'Velvet', 'Zesty', 'Polar', 'Electric', 'Hidden', 'Golden'];
const NOUNS = ['Otters', 'Compilers', 'Pixels', 'Kernels', 'Falcons', 'Lambdas', 'Voyagers', 'Circuits', 'Pandas', 'Vectors', 'Sparks', 'Orbits', 'Foxes', 'Threads', 'Comets'];

const started = Date.now();
const ctx = await connectDb(config, pino({ level: config.LOG_LEVEL }));
const { hackathon } = ctx;
const offsets = new Map([...new Set(ZONES)].map((z) => [z, utcOffsetMinutes(z)]));
// One hash for all seeded users: hashing 10,000 passwords with argon2 would take minutes and prove nothing.
const passwordHash = await argon2.hash(seedConfig.SEED_PASSWORD);
const base = Date.now() - 14 * 24 * 3600_000;
const at = (i, total) => new Date(base + Math.floor((i / total) * 13 * 24 * 3600_000));

const users = Array.from({ length: seedConfig.SEED_USERS }, (_, i) => {
  const timezone = pick(ZONES);
  return {
    _id: new ObjectId(),
    email: `seed-${String(i + 1).padStart(5, '0')}@seed.invalid`,
    passwordHash,
    displayName: `${pick(FIRST)} ${pick(LAST)}`,
    skills: sample(SKILLS, int(1, 4)),
    timezone,
    utcOffsetMinutes: offsets.get(timezone),
    createdAt: at(i, seedConfig.SEED_USERS),
    seed: true,
  };
});

const teams = [];
const memberships = [];
let next = 0;
for (let i = 0; i < seedConfig.SEED_TEAMS; i++) {
  const size = int(1, hackathon.maxTeamSize);
  const members = users.slice(next, next + size);
  if (members.length < size) throw new Error(`SEED_USERS is too small to fill ${seedConfig.SEED_TEAMS} teams`);
  next += size;
  const createdAt = at(i, seedConfig.SEED_TEAMS);
  const team = {
    // An ObjectId is 4 bytes of time + 8 more; backdating the time keeps seeded teams ordered by createdAt on the board.
    _id: new ObjectId(Math.floor(createdAt.getTime() / 1000).toString(16).padStart(8, '0') + randomBytes(4).toString('hex') + i.toString(16).padStart(8, '0')),
    hackathonId: hackathon._id,
    name: `${pick(ADJECTIVES)} ${pick(NOUNS)} ${i + 1}`,
    description: `We are building for ${hackathon.name} and want people who ship.`,
    lookingFor: sample(SKILLS, int(0, 3)),
    leaderId: members[0]._id,
    memberCount: size,
    minSize: hackathon.minTeamSize,
    maxSize: hackathon.maxTeamSize,
    isOpen: size < hackathon.maxTeamSize,
    // Nobody holds the code for a seeded team; its leader can regenerate one.
    inviteCodeHash: hashInviteCode(randomBytes(16).toString('hex')),
    inviteExpiresAt: new Date(Date.now() + config.INVITE_TTL_HOURS * 3600_000),
    createdAt,
    updatedAt: createdAt,
    seed: true,
  };
  teams.push(team);
  members.forEach((u, j) =>
    memberships.push({ hackathonId: hackathon._id, teamId: team._id, userId: u._id, joinedAt: new Date(createdAt.getTime() + j * 60_000), seed: true }),
  );
}

const seeded = { seed: true };
const removed = await Promise.all([ctx.users, ctx.teams, ctx.memberships].map((c) => c.deleteMany(seeded)));
await ctx.users.insertMany(users, { ordered: false });
if (teams.length) {
  await ctx.teams.insertMany(teams, { ordered: false });
  await ctx.memberships.insertMany(memberships, { ordered: false });
}

console.log(
  JSON.stringify({
    database: config.MONGODB_DB,
    removedPreviousSeed: removed.reduce((n, r) => n + r.deletedCount, 0),
    users: users.length,
    teams: teams.length,
    openTeams: teams.filter((t) => t.isOpen).length,
    memberships: memberships.length,
    usersWithoutTeam: users.length - next,
    seconds: (Date.now() - started) / 1000,
  }),
);
await ctx.client.close();
