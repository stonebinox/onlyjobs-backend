process.env.JWT_SECRET = 'test-jwt-secret';
jest.mock('openai', () => ({ __esModule: true, default: jest.fn().mockReturnValue({}) }));
import mongoose from 'mongoose';
import request from 'supertest';
import express from 'express';
import MatchRecord from '../models/MatchRecord';
import JobListing from '../models/JobListing';
import User from '../models/User';
import jwt from 'jsonwebtoken';
import { generateToken } from '../utils/generateToken';
import matchRoutes from '../routes/matchRoutes';

const app = express();
app.use(express.json());
app.use('/api/matches', matchRoutes);
app.use((err: any, _req: any, res: any, _next: any) => {
  res.status(res.statusCode !== 200 ? res.statusCode : 500).json({ error: err.message });
});

const oid = (x: any) => new mongoose.Types.ObjectId(String(x));
const DAY = 24 * 60 * 60 * 1000;

let seq = 0;
async function mkUser(label: string) {
  seq += 1;
  const user = await User.create({
    email: `${label}-${seq}-${Date.now()}@example.com`,
    password: 'Password123!',
    name: `User ${label}`,
    isVerified: true,
  });
  return { user, id: String(user._id), token: generateToken(String(user._id)) };
}

async function mkJob(title: string, company: string) {
  seq += 1;
  return JobListing.create({
    title,
    company,
    location: ['Remote'],
    source: 'test',
    description: `desc ${title}`,
    url: `https://example.com/jobs/${seq}-${Date.now()}`,
  });
}

interface RowOpts {
  clicked?: boolean;
  skipped?: boolean;
  applied?: boolean | null;
  matchScore?: number;
  createdAt?: Date;
  updatedAt?: Date;
}

// MatchRecord is unique on (userId, jobId): if this user already has a row for
// the job, transparently use a fresh JobListing so fixtures can be repeated.
const usedPairs = new Set<string>();
async function mkMatch(userId: string, jobIdIn: any, o: RowOpts = {}): Promise<string> {
  const now = new Date();
  let jobId = jobIdIn;
  const pair = `${userId}:${jobId}`;
  if (usedPairs.has(pair)) jobId = (await mkJob('filler', 'FillerCo'))._id;
  usedPairs.add(`${userId}:${jobId}`);
  const doc = {
    _id: new mongoose.Types.ObjectId(),
    userId: oid(userId),
    jobId: oid(jobId),
    matchScore: o.matchScore ?? 80,
    verdict: 'good',
    reasoning: 'because',
    clicked: o.clicked ?? false,
    skipped: o.skipped ?? false,
    applied: o.applied === undefined ? null : o.applied,
    createdAt: o.createdAt ?? now,
    updatedAt: o.updatedAt ?? now,
  };
  await MatchRecord.collection.insertOne(doc as any);
  return String(doc._id);
}

const get = (token?: string) => {
  const r = request(app).get('/api/matches/visited');
  return token ? r.set('Authorization', `Bearer ${token}`) : r;
};

const ids = (body: any[]) => body.map((m) => String(m._id));

describe('GET /api/matches/visited (adversarial)', () => {
  describe('auth', () => {
    it('401 without auth', async () => {
      const res = await get();
      expect(res.status).toBe(401);
    });

    it('401 with garbage token', async () => {
      const res = await get('garbage.token.value');
      expect(res.status).toBe(401);
    });

    it('401 with token signed by a different secret', async () => {
      const u = await mkUser('a');
      const bad = jwt.sign({ id: u.id, userId: u.id, _id: u.id }, 'wrong-secret');
      const res = await get(bad);
      expect(res.status).toBe(401);
    });

    it('401 does not leak data for malformed Authorization scheme', async () => {
      const u = await mkUser('a');
      const job = await mkJob('J', 'C');
      await mkMatch(u.id, job._id, { clicked: true });
      const res = await request(app).get('/api/matches/visited').set('Authorization', u.token);
      expect(res.status).toBe(401);
    });
  });

  describe('truth table clicked x skipped x applied', () => {
    it('includes exactly the rows matching the spec predicate', async () => {
      const u = await mkUser('tt');
      const job = await mkJob('TT', 'TTCo');
      const expected = new Set<string>();
      const all: Record<string, string> = {};
      for (const clicked of [true, false]) {
        for (const skipped of [true, false]) {
          for (const applied of [null, false, true] as const) {
            const id = await mkMatch(u.id, job._id, { clicked, skipped, applied });
            const key = `clicked=${clicked} skipped=${skipped} applied=${applied}`;
            all[id] = key;
            const include = !skipped && applied !== true && (clicked || applied === false);
            if (include) expected.add(id);
          }
        }
      }
      expect(expected.size).toBe(3); // sanity: (T,F,null) (T,F,false) (F,F,false)
      const res = await get(u.token);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      const got = new Set(ids(res.body));
      const missing = [...expected].filter((i) => !got.has(i)).map((i) => all[i]);
      const extra = [...got].filter((i) => !expected.has(i)).map((i) => all[i]);
      expect({ missing, extra }).toEqual({ missing: [], extra: [] });
      expect(res.body).toHaveLength(expected.size);
    });

    it('applied:false + clicked:false is INCLUDED', async () => {
      const u = await mkUser('x');
      const job = await mkJob('J', 'C');
      const id = await mkMatch(u.id, job._id, { clicked: false, applied: false });
      const res = await get(u.token);
      expect(ids(res.body)).toEqual([id]);
    });

    it('applied:true + clicked:true is EXCLUDED', async () => {
      const u = await mkUser('x');
      const job = await mkJob('J', 'C');
      await mkMatch(u.id, job._id, { clicked: true, applied: true });
      const res = await get(u.token);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('skipped:true + clicked:true is EXCLUDED, even with applied:false', async () => {
      const u = await mkUser('x');
      const job = await mkJob('J', 'C');
      await mkMatch(u.id, job._id, { clicked: true, skipped: true });
      await mkMatch(u.id, job._id, { clicked: true, skipped: true, applied: false });
      const res = await get(u.token);
      expect(res.body).toEqual([]);
    });

    it('clicked:false + applied:null is EXCLUDED', async () => {
      const u = await mkUser('x');
      const job = await mkJob('J', 'C');
      await mkMatch(u.id, job._id, { clicked: false, applied: null });
      const res = await get(u.token);
      expect(res.body).toEqual([]);
    });

    it('row inserted without an applied field at all (legacy/missing) with clicked:true is included', async () => {
      const u = await mkUser('x');
      const job = await mkJob('J', 'C');
      const _id = new mongoose.Types.ObjectId();
      await MatchRecord.collection.insertOne({
        _id,
        userId: oid(u.id),
        jobId: oid(job._id),
        matchScore: 70,
        verdict: 'v',
        reasoning: 'r',
        clicked: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);
      const res = await get(u.token);
      expect(ids(res.body)).toEqual([String(_id)]);
    });

    it('row with missing skipped field and clicked:true is included (skipped !== true)', async () => {
      const u = await mkUser('x');
      const job = await mkJob('J', 'C');
      const _id = new mongoose.Types.ObjectId();
      await MatchRecord.collection.insertOne({
        _id,
        userId: oid(u.id),
        jobId: oid(job._id),
        matchScore: 70,
        verdict: 'v',
        reasoning: 'r',
        clicked: true,
        applied: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);
      const res = await get(u.token);
      expect(ids(res.body)).toEqual([String(_id)]);
    });
  });

  describe('no threshold / window / limit', () => {
    it('includes matchScore 10 and 0', async () => {
      const u = await mkUser('x');
      const job = await mkJob('J', 'C');
      const a = await mkMatch(u.id, job._id, { clicked: true, matchScore: 10 });
      const b = await mkMatch(u.id, job._id, { clicked: true, matchScore: 0 });
      const res = await get(u.token);
      expect(new Set(ids(res.body))).toEqual(new Set([a, b]));
    });

    it('includes a row created and updated 400 days ago', async () => {
      const u = await mkUser('x');
      const job = await mkJob('J', 'C');
      const old = new Date(Date.now() - 400 * DAY);
      const id = await mkMatch(u.id, job._id, { clicked: true, createdAt: old, updatedAt: old });
      const res = await get(u.token);
      expect(ids(res.body)).toEqual([id]);
    });

    it('is not capped: returns 250 qualifying rows', async () => {
      const u = await mkUser('x');
      const docs = Array.from({ length: 250 }, (_, i) => ({
        _id: new mongoose.Types.ObjectId(),
        userId: oid(u.id),
        jobId: new mongoose.Types.ObjectId(),
        matchScore: 50,
        verdict: 'v',
        reasoning: 'r',
        clicked: true,
        skipped: false,
        applied: null,
        createdAt: new Date(Date.now() - i * 1000),
        updatedAt: new Date(Date.now() - i * 1000),
      }));
      await MatchRecord.collection.insertMany(docs as any);
      const res = await get(u.token);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(250);
      expect(new Set(ids(res.body)).size).toBe(250);
    });
  });

  describe('sorting', () => {
    it('sorts by updatedAt DESC even when createdAt order disagrees', async () => {
      const u = await mkUser('x');
      const job = await mkJob('J', 'C');
      const t = (d: number) => new Date(Date.UTC(2026, 0, 1) + d * DAY);
      // createdAt ascending: A < B < C ; updatedAt: B newest, then A, then C oldest
      const A = await mkMatch(u.id, job._id, { clicked: true, createdAt: t(1), updatedAt: t(20) });
      const B = await mkMatch(u.id, job._id, { clicked: true, createdAt: t(2), updatedAt: t(30) });
      const C = await mkMatch(u.id, job._id, { clicked: true, createdAt: t(3), updatedAt: t(10) });
      const res = await get(u.token);
      expect(ids(res.body)).toEqual([B, A, C]);
    });

    it('sort order holds across mixed inclusion reasons (clicked vs applied:false)', async () => {
      const u = await mkUser('x');
      const job = await mkJob('J', 'C');
      const t = (d: number) => new Date(Date.UTC(2026, 0, 1) + d * DAY);
      const A = await mkMatch(u.id, job._id, { clicked: false, applied: false, createdAt: t(5), updatedAt: t(40) });
      const B = await mkMatch(u.id, job._id, { clicked: true, applied: null, createdAt: t(1), updatedAt: t(50) });
      const C = await mkMatch(u.id, job._id, { clicked: true, applied: false, createdAt: t(9), updatedAt: t(30) });
      const res = await get(u.token);
      expect(ids(res.body)).toEqual([B, A, C]);
    });
  });

  describe('job join', () => {
    it('deleted JobListing -> row still returned, 200, job === null', async () => {
      const u = await mkUser('x');
      const job = await mkJob('Gone', 'GoneCo');
      const live = await mkJob('Live', 'LiveCo');
      const goneRow = await mkMatch(u.id, job._id, { clicked: true });
      const liveRow = await mkMatch(u.id, live._id, { clicked: true });
      await JobListing.deleteOne({ _id: job._id });
      const res = await get(u.token);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      const gone = res.body.find((m: any) => String(m._id) === goneRow);
      const alive = res.body.find((m: any) => String(m._id) === liveRow);
      expect(gone).toBeDefined();
      expect(gone.job).toBeNull();
      expect(alive.job).not.toBeNull();
      expect(alive.job.title).toBe('Live');
    });

    it('job is a full document object (not a bare id) with title/company, matched to the right row', async () => {
      const u = await mkUser('x');
      const j1 = await mkJob('Alpha Engineer', 'AlphaCo');
      const j2 = await mkJob('Beta Designer', 'BetaCo');
      const j3 = await mkJob('Gamma Analyst', 'GammaCo');
      const t = (d: number) => new Date(Date.UTC(2026, 0, 1) + d * DAY);
      const r1 = await mkMatch(u.id, j1._id, { clicked: true, updatedAt: t(3) });
      const r2 = await mkMatch(u.id, j2._id, { clicked: true, updatedAt: t(2) });
      const r3 = await mkMatch(u.id, j3._id, { applied: false, updatedAt: t(1) });
      const res = await get(u.token);
      expect(ids(res.body)).toEqual([r1, r2, r3]);
      const map: Record<string, [string, string, any]> = {
        [r1]: ['Alpha Engineer', 'AlphaCo', j1._id],
        [r2]: ['Beta Designer', 'BetaCo', j2._id],
        [r3]: ['Gamma Analyst', 'GammaCo', j3._id],
      };
      for (const m of res.body) {
        const [title, company, jid] = map[String(m._id)];
        expect(typeof m.job).toBe('object');
        expect(m.job.title).toBe(title);
        expect(m.job.company).toBe(company);
        expect(String(m.job._id)).toBe(String(jid));
      }
    });

    it('same job shared by two users resolves for each user', async () => {
      const a = await mkUser('a');
      const b = await mkUser('b');
      const j = await mkJob('Shared', 'SharedCo');
      await mkMatch(a.id, j._id, { clicked: true });
      await mkMatch(b.id, j._id, { applied: false });
      for (const u of [a, b]) {
        const res = await get(u.token);
        expect(res.body).toHaveLength(1);
        expect(res.body[0].job.title).toBe('Shared');
      }
    });

    it('exposes MatchRecord fields alongside job', async () => {
      const u = await mkUser('x');
      const j = await mkJob('F', 'FC');
      const id = await mkMatch(u.id, j._id, { clicked: true, matchScore: 42 });
      const res = await get(u.token);
      const m = res.body[0];
      expect(String(m._id)).toBe(id);
      expect(m.matchScore).toBe(42);
      expect(m.clicked).toBe(true);
      expect(m.verdict).toBe('good');
      expect(m.reasoning).toBe('because');
      expect(String(m.userId)).toBe(u.id);
      expect(String(m.jobId?._id ?? m.jobId)).toBe(String(j._id));
    });
  });

  describe('isolation', () => {
    it('never returns another user\'s rows', async () => {
      const a = await mkUser('a');
      const b = await mkUser('b');
      const job = await mkJob('J', 'C');
      const aRow = await mkMatch(a.id, job._id, { clicked: true });
      const bRow = await mkMatch(b.id, job._id, { clicked: true });
      const bRow2 = await mkMatch(b.id, job._id, { applied: false });

      const ra = await get(a.token);
      expect(ids(ra.body)).toEqual([aRow]);
      const rb = await get(b.token);
      expect(new Set(ids(rb.body))).toEqual(new Set([bRow, bRow2]));
    });

    it('?userId=<other> is ignored', async () => {
      const a = await mkUser('a');
      const b = await mkUser('b');
      const job = await mkJob('J', 'C');
      const aRow = await mkMatch(a.id, job._id, { clicked: true });
      await mkMatch(b.id, job._id, { clicked: true });
      const res = await request(app)
        .get(`/api/matches/visited?userId=${b.id}`)
        .set('Authorization', `Bearer ${a.token}`);
      expect(res.status).toBe(200);
      expect(ids(res.body)).toEqual([aRow]);
    });

    it('?userId[$ne]= operator injection does not widen results', async () => {
      const a = await mkUser('a');
      const b = await mkUser('b');
      const job = await mkJob('J', 'C');
      const aRow = await mkMatch(a.id, job._id, { clicked: true });
      await mkMatch(b.id, job._id, { clicked: true });
      const res = await request(app)
        .get(`/api/matches/visited?userId[$ne]=${a.id}`)
        .set('Authorization', `Bearer ${a.token}`);
      expect(res.status).toBe(200);
      expect(ids(res.body)).toEqual([aRow]);
    });

    it('body userId is ignored', async () => {
      const a = await mkUser('a');
      const b = await mkUser('b');
      const job = await mkJob('J', 'C');
      const aRow = await mkMatch(a.id, job._id, { clicked: true });
      await mkMatch(b.id, job._id, { clicked: true });
      const res = await request(app)
        .get('/api/matches/visited')
        .set('Authorization', `Bearer ${a.token}`)
        .send({ userId: b.id });
      expect(res.status).toBe(200);
      expect(ids(res.body)).toEqual([aRow]);
    });

    it('user with no qualifying rows gets [] even when others have many', async () => {
      const a = await mkUser('a');
      const b = await mkUser('b');
      const job = await mkJob('J', 'C');
      for (let i = 0; i < 5; i++) await mkMatch(b.id, job._id, { clicked: true });
      const res = await get(a.token);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('does not leak other user\'s deleted-job rows either', async () => {
      const a = await mkUser('a');
      const b = await mkUser('b');
      const job = await mkJob('J', 'C');
      await mkMatch(b.id, job._id, { clicked: true });
      await JobListing.deleteOne({ _id: job._id });
      const res = await get(a.token);
      expect(res.body).toEqual([]);
    });
  });

  describe('route shadowing', () => {
    it('/visited is not captured by a parametrized route (returns an array, not an error/object)', async () => {
      const u = await mkUser('x');
      const res = await get(u.token);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe('read-only', () => {
    it('does not mutate rows (updatedAt unchanged after GET)', async () => {
      const u = await mkUser('x');
      const job = await mkJob('J', 'C');
      const stamp = new Date(Date.UTC(2026, 0, 5));
      const id = await mkMatch(u.id, job._id, { clicked: true, createdAt: stamp, updatedAt: stamp });
      await get(u.token);
      const raw = await MatchRecord.collection.findOne({ _id: oid(id) });
      expect(new Date(raw!.updatedAt).getTime()).toBe(stamp.getTime());
    });
  });
});
