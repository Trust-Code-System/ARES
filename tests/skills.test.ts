/**
 * Expert skill library — loader + find_skill/use_skill tools. Fully offline:
 * a fixture skill tree is written to a temp dir, then exercised end to end.
 *
 * Covers: frontmatter parsing (plain / quoted / block scalar / missing),
 * index build (skip nameless, dedupe identical ids, script discovery),
 * search ranking, and both tools (find, load, unknown, ambiguous-name).
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadSkillIndex, parseFrontmatter } from '../src/skills/loader.js';
import { createSkillTools } from '../src/skills/index.js';
import type { Logger, ToolContext } from '../src/types.js';

const silentLogger: Logger = { log() {}, debug() {}, info() {}, warn() {}, error() {} };
const ctx: ToolContext = { logger: silentLogger, runId: 'test' };

/** Write a SKILL.md (and optional script) at <root>/<relDir>/skills/<slug>/. */
function writeSkill(root: string, relDir: string, slug: string, frontmatter: string, script?: string): void {
  const dir = path.join(root, relDir, 'skills', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), `${frontmatter}\n\n# ${slug}\n\nPlaybook body for ${slug}.\n`);
  if (script) {
    const sdir = path.join(dir, 'scripts');
    mkdirSync(sdir, { recursive: true });
    writeFileSync(path.join(sdir, script), 'print("hi")\n');
  }
}

describe('parseFrontmatter', () => {
  it('reads plain, quoted, and block-scalar values', () => {
    assert.deepEqual(parseFrontmatter('---\nname: alpha\ndescription: plain words\n---\nbody'), {
      name: 'alpha',
      description: 'plain words',
    });
    assert.deepEqual(parseFrontmatter('---\nname: "beta"\ndescription: \'quoted\'\n---'), {
      name: 'beta',
      description: 'quoted',
    });
    const block = parseFrontmatter('---\nname: gamma\ndescription: |\n  line one\n  line two\n---');
    assert.equal(block.name, 'gamma');
    assert.equal(block.description, 'line one\nline two');
    const folded = parseFrontmatter('---\nname: delta\ndescription: >\n  folded one\n  folded two\n---');
    assert.equal(folded.description, 'folded one folded two');
  });

  it('returns empty when there is no frontmatter or no name', () => {
    assert.deepEqual(parseFrontmatter('no frontmatter here'), {});
    assert.deepEqual(parseFrontmatter('---\nother: x\n---'), {});
  });
});

describe('skill library', () => {
  let root: string;

  before(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'ares-skills-'));
    // Canonical skill with a bundled script.
    writeSkill(
      root,
      'engineering/llm-cost',
      'llm-cost',
      '---\nname: llm-cost-optimizer\ndescription: "Use when LLM API costs are too high or you need to optimize token usage and model routing."\n---',
      'optimize.py',
    );
    // Byte-identical duplicate in the same category under the flat layout → same id, deduped.
    writeSkill(
      root,
      'engineering',
      'llm-cost',
      '---\nname: llm-cost-optimizer\ndescription: "Use when LLM API costs are too high or you need to optimize token usage and model routing."\n---',
    );
    // Distinct skill, block-scalar description.
    writeSkill(
      root,
      'product/roadmap',
      'roadmap',
      '---\nname: roadmap-planner\ndescription: >\n  Plan and sequence a product roadmap across quarters.\n---',
    );
    // Same bare name in two categories → ambiguous by name, distinct by id.
    writeSkill(root, 'cat-a/helper', 'helper', "---\nname: helper\ndescription: 'general helper a'\n---");
    writeSkill(root, 'cat-b/helper', 'helper', '---\nname: helper\ndescription: general helper b\n---');
    // No name → not a real skill, must be skipped.
    writeSkill(root, 'cat-x/sample', 'sample', '---\nother: value\n---');
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('loads, skips nameless, and dedupes identical ids', () => {
    const idx = loadSkillIndex(root, silentLogger);
    assert.equal(idx.size, 4); // llm-cost-optimizer (deduped), roadmap-planner, helper×2
    const ids = idx.all.map((s) => s.id).sort();
    assert.deepEqual(ids, [
      'cat-a/helper',
      'cat-b/helper',
      'engineering/llm-cost-optimizer',
      'product/roadmap-planner',
    ]);
  });

  it('discovers bundled scripts by absolute path', () => {
    const idx = loadSkillIndex(root, silentLogger);
    const skill = idx.get('engineering/llm-cost-optimizer');
    assert.ok(skill);
    assert.equal(skill.scripts.length, 1);
    assert.ok(path.isAbsolute(skill.scripts[0]));
    assert.ok(skill.scripts[0].endsWith('optimize.py'));
  });

  it('ranks relevant skills first', () => {
    const idx = loadSkillIndex(root, silentLogger);
    const hits = idx.search('reduce LLM token costs', 5);
    assert.ok(hits.length >= 1);
    assert.equal(hits[0].id, 'engineering/llm-cost-optimizer');
  });

  it('resolves bare names only when unambiguous', () => {
    const idx = loadSkillIndex(root, silentLogger);
    assert.equal(idx.get('roadmap-planner')?.id, 'product/roadmap-planner');
    assert.equal(idx.get('helper'), undefined); // ambiguous
    assert.equal(idx.byName('helper').length, 2);
  });

  it('find_skill returns ranked matches with ids', async () => {
    const [findSkill] = createSkillTools({ skillsDir: root });
    const res = await findSkill.execute({ query: 'LLM cost' }, ctx);
    assert.equal(res.ok, true);
    assert.match(res.content, /engineering\/llm-cost-optimizer/);
    assert.ok(Array.isArray((res.data as { ids: string[] }).ids));
  });

  it('use_skill loads the playbook and surfaces script paths', async () => {
    const tools = createSkillTools({ skillsDir: root });
    const useSkill = tools[1];
    const res = await useSkill.execute({ name: 'engineering/llm-cost-optimizer' }, ctx);
    assert.equal(res.ok, true);
    assert.match(res.content, /Playbook body for llm-cost/);
    assert.match(res.content, /optimize\.py/);
    assert.match(res.content, /run_python/);
  });

  it('use_skill rejects unknown and disambiguates colliding names', async () => {
    const useSkill = createSkillTools({ skillsDir: root })[1];
    const missing = await useSkill.execute({ name: 'nope/nothing' }, ctx);
    assert.equal(missing.ok, false);
    assert.match(missing.content, /find_skill/);

    const ambiguous = await useSkill.execute({ name: 'helper' }, ctx);
    assert.equal(ambiguous.ok, false);
    assert.match(ambiguous.content, /cat-a\/helper/);
    assert.match(ambiguous.content, /cat-b\/helper/);
  });

  it('reads metadata.json: risk, triggers, provenance, and enabled:false', () => {
    const mroot = mkdtempSync(path.join(os.tmpdir(), 'ares-skills-meta-'));
    try {
      // Skill with rich metadata.
      writeSkill(mroot, 'video/remotion', 'remotion', "---\nname: remotion-video\ndescription: 'render video'\n---");
      writeFileSync(
        path.join(mroot, 'video/remotion', 'skills', 'remotion', 'metadata.json'),
        JSON.stringify({
          source_repo: 'remotion-dev/remotion',
          trigger_keywords: ['promo', 'animation', 'mp4'],
          risk_level: 'medium',
          version: '1.0.0',
          enabled: true,
        }),
      );
      // Disabled skill — must be excluded entirely.
      writeSkill(mroot, 'misc/off', 'off', "---\nname: turned-off\ndescription: 'nope'\n---");
      writeFileSync(
        path.join(mroot, 'misc/off', 'skills', 'off', 'metadata.json'),
        JSON.stringify({ enabled: false }),
      );

      const idx = loadSkillIndex(mroot, silentLogger);
      const skill = idx.get('video/remotion-video');
      assert.ok(skill);
      assert.equal(skill.riskLevel, 'medium');
      assert.equal(skill.sourceRepo, 'remotion-dev/remotion');
      assert.equal(skill.version, '1.0.0');
      assert.deepEqual(skill.triggerKeywords, ['promo', 'animation', 'mp4']);

      // enabled:false skill is absent.
      assert.equal(idx.get('misc/turned-off'), undefined);

      // A trigger keyword routes to the skill even when absent from name/description.
      const hits = idx.search('make a promo', 5);
      assert.equal(hits[0]?.id, 'video/remotion-video');
    } finally {
      rmSync(mroot, { recursive: true, force: true });
    }
  });

  it('defaults risk to low and triggers to empty without a sidecar', () => {
    const idx = loadSkillIndex(root, silentLogger);
    const skill = idx.get('product/roadmap-planner');
    assert.ok(skill);
    assert.equal(skill.riskLevel, 'low');
    assert.deepEqual(skill.triggerKeywords, []);
  });

  it('is empty and harmless when the directory does not exist', async () => {
    const idx = loadSkillIndex(path.join(root, 'does-not-exist'), silentLogger);
    assert.equal(idx.size, 0);
    const [findSkill] = createSkillTools({ skillsDir: path.join(root, 'does-not-exist') });
    const res = await findSkill.execute({ query: 'anything' }, ctx);
    assert.equal(res.ok, true);
    assert.match(res.content, /empty or unavailable/);
  });
});
