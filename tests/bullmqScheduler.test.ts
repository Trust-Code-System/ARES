/**
 * BullMqScheduler — the Redis-free seams.
 *
 * A live Redis is out of scope for the unit suite, but the parts that don't touch
 * the network are exactly the parts that rot silently: redis(s):// URL parsing,
 * job registration/validation, and the name→handler dispatch the worker performs.
 * The constructor only parses the URL (Queue/Worker are created in start()), so a
 * scheduler can be built and these paths exercised without connecting.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BullMqScheduler, connectionFromUrl } from '../src/autonomy/bullmqScheduler.js';
import type { Logger } from '../src/types.js';

const silent: Logger = { log() {}, debug() {}, info() {}, warn() {}, error() {} };

describe('connectionFromUrl', () => {
  it('parses host, port, db, and credentials', () => {
    const c = connectionFromUrl('redis://user:p%40ss@redis.example:6380/2') as Record<string, unknown>;
    assert.equal(c.host, 'redis.example');
    assert.equal(c.port, 6380);
    assert.equal(c.db, 2);
    assert.equal(c.username, 'user');
    assert.equal(c.password, 'p@ss'); // URL-decoded
    assert.equal(c.maxRetriesPerRequest, null); // required by BullMQ
    assert.equal(c.tls, undefined);
  });

  it('defaults the port and enables TLS for rediss://', () => {
    const c = connectionFromUrl('rediss://secure.example') as Record<string, unknown>;
    assert.equal(c.host, 'secure.example');
    assert.equal(c.port, 6379);
    assert.deepEqual(c.tls, {});
  });
});

describe('BullMqScheduler (no Redis)', () => {
  const job = (name: string, handler = async () => {}) => ({ name, cron: '0 6 * * *', handler });

  it('registers jobs, rejects duplicates, and validates cron up front', () => {
    const s = new BullMqScheduler('redis://localhost:6379', silent);
    s.register(job('briefing'));
    assert.deepEqual(s.jobs().map((j) => j.name), ['briefing']);
    assert.throws(() => s.register(job('briefing')), /already registered/);
    assert.throws(() => s.register({ name: 'bad', cron: 'not a cron', handler: async () => {} }), /./);
  });

  it('dispatches a due job to its handler and ignores unknown jobs', async () => {
    const s = new BullMqScheduler('redis://localhost:6379', silent);
    let ran = 0;
    s.register(job('briefing', async () => { ran++; }));

    await s.process('briefing');
    assert.equal(ran, 1);
    await s.process('ghost'); // no handler → warn, must not throw
    assert.equal(ran, 1);
  });

  it('refuses a manual trigger before start()', async () => {
    const s = new BullMqScheduler('redis://localhost:6379', silent);
    s.register(job('briefing'));
    await assert.rejects(() => s.trigger('briefing'), /not started/);
    await assert.rejects(() => s.trigger('nope'), /No scheduled job/);
  });
});
