import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../src/rate-limiter.js';

test('allows a burst up to the limit without waiting', async () => {
  const limiter = new RateLimiter(5, 1000);
  const start = Date.now();
  await Promise.all(Array.from({ length: 5 }, () => limiter.acquire()));
  assert.ok(Date.now() - start < 50);
});

test('makes the request past the limit wait for the window', async () => {
  const limiter = new RateLimiter(3, 200);
  const start = Date.now();
  await Promise.all(Array.from({ length: 4 }, () => limiter.acquire()));
  assert.ok(Date.now() - start >= 190, `waited ${Date.now() - start}ms`);
});
