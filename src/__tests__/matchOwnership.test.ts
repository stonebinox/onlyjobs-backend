jest.mock('../middleware/authMiddleware', () => ({
  protect: (_req: any, _res: any, next: any) => next(),
}));

import mongoose from 'mongoose';
import request from 'supertest';
import express from 'express';
import MatchRecord from '../models/MatchRecord';
import { Freshness } from '../models/MatchRecord';
import matchRoutes from '../routes/matchRoutes';

let ownerUserId: mongoose.Types.ObjectId;
let otherUserId: mongoose.Types.ObjectId;

const testApp = express();
testApp.use(express.json());
testApp.use((req: any, _res: any, next: any) => {
  req.user = { _id: ownerUserId };
  next();
});
testApp.use('/api/matches', matchRoutes);
testApp.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = res.statusCode !== 200 ? res.statusCode : 500;
  res.status(status).json({ error: err.message });
});

async function createMatchForUser(userId: mongoose.Types.ObjectId) {
  return MatchRecord.create({
    userId,
    jobId: new mongoose.Types.ObjectId(),
    matchScore: 80,
    verdict: 'Good match',
    reasoning: 'Test',
    freshness: Freshness.FRESH,
    clicked: false,
    skipped: false,
    applied: null,
  });
}

beforeEach(() => {
  ownerUserId = new mongoose.Types.ObjectId();
  otherUserId = new mongoose.Types.ObjectId();
});

// ---------------------------------------------------------------------------
// POST /api/matches/click
// ---------------------------------------------------------------------------

describe('POST /api/matches/click — ownership', () => {
  it('returns 200 when user clicks their own match', async () => {
    const match = await createMatchForUser(ownerUserId);

    const res = await request(testApp)
      .post('/api/matches/click')
      .send({ matchId: (match._id as mongoose.Types.ObjectId).toString() });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Match marked as clicked');
  });

  it('returns 403 when user tries to click another user\'s match', async () => {
    const match = await createMatchForUser(otherUserId);

    const res = await request(testApp)
      .post('/api/matches/click')
      .send({ matchId: (match._id as mongoose.Types.ObjectId).toString() });

    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// POST /api/matches/skip
// ---------------------------------------------------------------------------

describe('POST /api/matches/skip — ownership', () => {
  it('returns 200 when user skips their own match', async () => {
    const match = await createMatchForUser(ownerUserId);

    const res = await request(testApp)
      .post('/api/matches/skip')
      .send({ matchId: (match._id as mongoose.Types.ObjectId).toString() });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Match marked as skipped');
  });

  it('returns 403 when user tries to skip another user\'s match', async () => {
    const match = await createMatchForUser(otherUserId);

    const res = await request(testApp)
      .post('/api/matches/skip')
      .send({ matchId: (match._id as mongoose.Types.ObjectId).toString() });

    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// POST /api/matches/applied
// ---------------------------------------------------------------------------

describe('POST /api/matches/applied — ownership', () => {
  it('returns 200 when user marks their own match as applied', async () => {
    const match = await createMatchForUser(ownerUserId);

    const res = await request(testApp)
      .post('/api/matches/applied')
      .send({ matchId: (match._id as mongoose.Types.ObjectId).toString(), applied: true });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Match applied status updated');
  });

  it('returns 403 when user tries to mark another user\'s match as applied', async () => {
    const match = await createMatchForUser(otherUserId);

    const res = await request(testApp)
      .post('/api/matches/applied')
      .send({ matchId: (match._id as mongoose.Types.ObjectId).toString(), applied: true });

    expect(res.status).toBe(403);
  });
});
