import request from 'supertest';
import express from 'express';
import asyncHandler from 'express-async-handler';
import { errorHandler } from '../middleware/errorHandler';

const testApp = express();
testApp.use(express.json());

// (a) controller sets 400 then throws
testApp.get('/bad-input', asyncHandler(async (_req, res) => {
  res.status(400);
  throw new Error('bad input');
}));

// (b) throws without setting a status — should default to 500
testApp.get('/no-status', asyncHandler(async () => {
  throw new Error('unexpected failure');
}));

// (c) controller sets 201 then throws — 2xx must NOT leak as error response
testApp.get('/success-status-throws', asyncHandler(async (_req, res) => {
  res.status(201);
  throw new Error('boom');
}));

testApp.use(errorHandler);

describe('errorHandler middleware', () => {
  it('(a) preserves 400 error status and returns message', async () => {
    const res = await request(testApp).get('/bad-input');
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('bad input');
  });

  it('(b) defaults to 500 when no status is set', async () => {
    const res = await request(testApp).get('/no-status');
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('unexpected failure');
  });

  it('(c) returns 500 when controller set a 2xx status before throwing (FIX 1)', async () => {
    const res = await request(testApp).get('/success-status-throws');
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('boom');
  });
});
