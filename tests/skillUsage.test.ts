/** Skill-usage memory — offline. Counts, ordering, recency, and the log cap. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InMemorySkillUsageStore } from '../src/skills/usage.js';

describe('InMemorySkillUsageStore', () => {
  it('records uses, counts, and orders by frequency', () => {
    const s = new InMemorySkillUsageStore();
    s.record('ui-ux/premium-product-design', 'run1');
    s.record('writing/stop-slop', 'run2');
    s.record('ui-ux/premium-product-design', 'run3');

    const top = s.topUsed();
    assert.equal(top[0]?.skillId, 'ui-ux/premium-product-design');
    assert.equal(top[0]?.count, 2);
    assert.equal(top[1]?.skillId, 'writing/stop-slop');
  });

  it('returns recent uses newest-first with runId', () => {
    const s = new InMemorySkillUsageStore();
    s.record('a/one', 'r1');
    s.record('b/two', 'r2');
    const recent = s.recent(2);
    assert.equal(recent[0]?.skillId, 'b/two');
    assert.equal(recent[0]?.runId, 'r2');
  });

  it('caps the log to avoid unbounded growth', () => {
    const s = new InMemorySkillUsageStore(3);
    for (let i = 0; i < 10; i++) s.record(`s/${i}`);
    assert.equal(s.recent(100).length, 3);
    // counts persist even after log entries are evicted.
    assert.equal(s.topUsed(100).length, 10);
  });
});
