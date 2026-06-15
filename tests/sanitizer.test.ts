/**
 * Training-data sanitizer tests — secret/PII detection and redaction.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { scanSecrets, redact, sanitizeText, hasCredential } from '../src/ai-training/sanitizer.js';

describe('sanitizer: detection', () => {
  it('detects an Anthropic key', () => {
    const f = scanSecrets('my key is sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA end');
    assert.ok(f.some((x) => x.kind === 'anthropic_key'));
    assert.ok(hasCredential(f));
  });

  it('detects an OpenAI key, AWS key, JWT, and private key block', () => {
    const text =
      'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX AKIAIOSFODNN7EXAMPLE ' +
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dozjgNryP4J3jVmNHl0w5N ' +
      '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----';
    const kinds = new Set(scanSecrets(text).map((f) => f.kind));
    assert.ok(kinds.has('openai_key'));
    assert.ok(kinds.has('aws_access_key'));
    assert.ok(kinds.has('jwt'));
    assert.ok(kinds.has('private_key_block'));
  });

  it('detects an email as PII (not a hard credential)', () => {
    const f = scanSecrets('contact me at jane.doe@example.com please');
    assert.ok(f.some((x) => x.kind === 'email'));
    assert.equal(hasCredential(f), false);
  });

  it('detects key=value secret assignments', () => {
    const f = scanSecrets('API_KEY=supersecretvalue123');
    assert.ok(f.some((x) => x.kind === 'generic_secret_assignment'));
  });

  it('finds nothing in clean text', () => {
    const r = sanitizeText('Make my dashboard look more premium.');
    assert.equal(r.redacted, false);
    assert.equal(r.findings.length, 0);
    assert.equal(r.value, 'Make my dashboard look more premium.');
  });
});

describe('sanitizer: redaction', () => {
  it('replaces a key with a typed placeholder', () => {
    const out = redact('token sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA here');
    assert.ok(out.includes('‹REDACTED:ANTHROPIC_KEY›'));
    assert.ok(!out.includes('sk-ant-'));
  });

  it('redacts an email', () => {
    assert.equal(redact('write to a@b.com'), 'write to ‹REDACTED:EMAIL›');
  });
});
