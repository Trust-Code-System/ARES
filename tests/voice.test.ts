/**
 * Phase 5 — voice mode. Two layers, both offline:
 *   - {@link OpenAiVoiceProvider} against an injected fake `fetch` (no network),
 *     asserting it shapes the Whisper/TTS requests correctly and parses replies.
 *   - the binary HTTP voice endpoints on a real {@link ApiServer} (bound to an
 *     ephemeral port) driven with a {@link FakeVoiceProvider}, plus the 501 path
 *     when no provider is configured.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  OpenAiVoiceProvider,
  CompositeVoiceProvider,
  ElevenLabsTextToSpeechProvider,
  GeminiTextToSpeechProvider,
  FakeVoiceProvider,
  GeminiSpeechToTextProvider,
  buildVoiceProvider,
} from '../src/server/voice.js';
import { ApiServer } from '../src/server/httpServer.js';
import type { ApiDeps } from '../src/server/api.js';
import { InMemoryActivityFeed, InMemoryKillSwitch } from '../src/autonomy/store.js';
import { InMemoryConfirmationQueue, InMemoryRulesStore } from '../src/safety/store.js';
import { InMemoryStructuredStore } from '../src/memory/stores.js';
import { InMemoryAuditLog } from '../src/logging/logger.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { AgentInput, AgentRunResult, Logger } from '../src/types.js';

const silentLogger: Logger = {
  log() {}, debug() {}, info() {}, warn() {}, error() {},
};

function deps(voice?: ApiDeps['voice']): ApiDeps {
  const audit = new InMemoryAuditLog();
  return {
    agent: {
      async run(input: AgentInput): Promise<AgentRunResult> {
        return { runId: 'r', finalText: `echo:${input.text}`, stopReason: 'completed', iterations: 1, toolCalls: [] };
      },
    },
    audit,
    activityFeed: new InMemoryActivityFeed(),
    killSwitch: new InMemoryKillSwitch(),
    rules: new InMemoryRulesStore(),
    queue: new InMemoryConfirmationQueue(),
    structured: new InMemoryStructuredStore(),
    registry: new ToolRegistry(),
    ...(voice ? { voice } : {}),
  };
}

describe('buildVoiceProvider', () => {
  it('returns undefined without OPENAI_API_KEY and a provider with it', () => {
    assert.equal(buildVoiceProvider({}), undefined);
    const provider = buildVoiceProvider({ OPENAI_API_KEY: 'sk-test' });
    assert.ok(provider instanceof CompositeVoiceProvider);
    assert.equal(provider.sttProvider, 'openai');
    assert.equal(provider.ttsProvider, 'openai');
  });

  it('auto-selects Gemini input and ElevenLabs output when both are configured', () => {
    const provider = buildVoiceProvider({
      GEMINI_API_KEY: 'gemini-test',
      ELEVENLABS_API_KEY: 'eleven-test',
      ELEVENLABS_VOICE_ID: 'voice-test',
    });
    assert.ok(provider instanceof CompositeVoiceProvider);
    assert.equal(provider.sttProvider, 'gemini');
    assert.equal(provider.ttsProvider, 'elevenlabs');
  });

  it('runs fully on a Gemini key alone (Gemini STT + Gemini TTS)', () => {
    const provider = buildVoiceProvider({ GEMINI_API_KEY: 'gemini-test' });
    assert.ok(provider instanceof CompositeVoiceProvider);
    assert.equal(provider.sttProvider, 'gemini');
    assert.equal(provider.ttsProvider, 'gemini');
  });

  it('honours ARES_VOICE_TTS_PROVIDER=gemini with an OpenAI key present', () => {
    const provider = buildVoiceProvider({
      OPENAI_API_KEY: 'sk-test',
      GEMINI_API_KEY: 'gemini-test',
      ARES_VOICE_TTS_PROVIDER: 'gemini',
      ARES_VOICE_STT_PROVIDER: 'openai',
    });
    assert.ok(provider instanceof CompositeVoiceProvider);
    assert.equal(provider.sttProvider, 'openai');
    assert.equal(provider.ttsProvider, 'gemini');
  });
});

describe('OpenAiVoiceProvider', () => {
  it('posts audio as multipart to the transcription endpoint and returns the text', async () => {
    let seen: { url: string; method: string; auth: string; body: unknown } | undefined;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen = {
        url: String(url),
        method: init?.method ?? 'GET',
        auth: (init?.headers as Record<string, string>).authorization,
        body: init?.body,
      };
      return new Response(JSON.stringify({ text: 'transcribed words' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const provider = new OpenAiVoiceProvider({ apiKey: 'sk-x', fetchImpl });
    const text = await provider.transcribe(Buffer.from('fake-audio-bytes'), 'audio/webm');

    assert.equal(text, 'transcribed words');
    assert.equal(seen?.method, 'POST');
    assert.match(seen!.url, /\/audio\/transcriptions$/);
    assert.equal(seen?.auth, 'Bearer sk-x');
    // Body is multipart (a FormData) carrying the model + the audio file.
    assert.ok(seen?.body instanceof FormData);
    const form = seen!.body as FormData;
    assert.equal(form.get('model'), 'whisper-1');
    assert.ok(form.get('file') instanceof Blob);
  });

  it('posts JSON to the speech endpoint and returns audio bytes + mime', async () => {
    let payload: Record<string, unknown> | undefined;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(Buffer.from('MP3DATA'), { status: 200 });
    }) as unknown as typeof fetch;

    const provider = new OpenAiVoiceProvider({ apiKey: 'sk-x', ttsVoice: 'nova', fetchImpl });
    const { audio, mimeType } = await provider.synthesize('hello there');

    assert.equal(mimeType, 'audio/mpeg');
    assert.equal(audio.toString(), 'MP3DATA');
    assert.equal(payload?.input, 'hello there');
    assert.equal(payload?.voice, 'nova');
    assert.equal(payload?.model, 'tts-1');
  });

  it('throws on a non-2xx response', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch;
    const provider = new OpenAiVoiceProvider({ apiKey: 'bad', fetchImpl });
    await assert.rejects(() => provider.transcribe(Buffer.from('x'), 'audio/webm'), /401/);
  });
});

describe('Gemini and ElevenLabs voice providers', () => {
  it('sends inline audio to Gemini and returns transcript text', async () => {
    let payload: Record<string, unknown> | undefined;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'heard by gemini' }] } }],
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const provider = new GeminiSpeechToTextProvider({ apiKey: 'g', fetchImpl });
    assert.equal(
      await provider.transcribe(Buffer.from('audio'), 'audio/wav'),
      'heard by gemini',
    );
    const parts = ((payload?.contents as Array<{ parts: unknown[] }>)[0]!.parts);
    assert.equal(parts.length, 2);
  });

  it('wraps Gemini PCM output in a WAV container', async () => {
    let payload: Record<string, unknown> | undefined;
    const pcm = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcm.toString('base64') } }] } }],
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const provider = new GeminiTextToSpeechProvider({ apiKey: 'g', voice: 'Puck', fetchImpl });
    const { audio, mimeType } = await provider.synthesize('hello');

    assert.equal(mimeType, 'audio/wav');
    assert.equal(audio.subarray(0, 4).toString(), 'RIFF');
    assert.equal(audio.subarray(8, 12).toString(), 'WAVE');
    assert.equal(audio.length, 44 + pcm.length); // header + payload
    assert.equal(audio.readUInt32LE(24), 24000); // sample rate parsed from mime
    const gen = payload?.generationConfig as Record<string, unknown>;
    assert.deepEqual(gen.responseModalities, ['AUDIO']);
  });

  it('throws when Gemini returns no audio', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'oops' }] } }] }), { status: 200 })) as unknown as typeof fetch;
    const provider = new GeminiTextToSpeechProvider({ apiKey: 'g', fetchImpl });
    await assert.rejects(() => provider.synthesize('x'), /no audio/i);
  });

  it('uses the ElevenLabs streaming endpoint and Flash model', async () => {
    let seenUrl = '';
    let payload: Record<string, unknown> | undefined;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(url);
      payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(Buffer.from('ELEVEN-MP3'), { status: 200 });
    }) as unknown as typeof fetch;
    const provider = new ElevenLabsTextToSpeechProvider({
      apiKey: 'e',
      voiceId: 'voice-1',
      fetchImpl,
    });
    const result = await provider.synthesize('hello');
    assert.match(seenUrl, /voice-1\/stream/);
    assert.equal(payload?.model_id, 'eleven_flash_v2_5');
    assert.equal(result.audio.toString(), 'ELEVEN-MP3');
    assert.equal(result.mimeType, 'audio/mpeg');
  });
});

describe('voice HTTP endpoints', () => {
  it('transcribes binary audio and synthesizes speech when a provider is configured', async () => {
    const server = new ApiServer({ deps: deps(new FakeVoiceProvider('heard you')), port: 0, logger: silentLogger });
    await server.start();
    const base = `http://localhost:${server.address()}`;
    try {
      const tr = await fetch(`${base}/api/voice/transcribe`, {
        method: 'POST',
        headers: { 'content-type': 'audio/webm' },
        body: Buffer.from('0123456789'),
      });
      assert.equal(tr.status, 200);
      const { text } = (await tr.json()) as { text: string };
      assert.match(text, /heard you \(10 bytes\)/);

      const sp = await fetch(`${base}/api/voice/speak`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'read this' }),
      });
      assert.equal(sp.status, 200);
      assert.equal(sp.headers.get('content-type'), 'audio/mpeg');
      assert.equal(Buffer.from(await sp.arrayBuffer()).toString(), 'spoken:read this');
    } finally {
      await server.stop();
    }
  });

  it('returns 501 from both endpoints when no provider is configured', async () => {
    const server = new ApiServer({ deps: deps(), port: 0, logger: silentLogger });
    await server.start();
    const base = `http://localhost:${server.address()}`;
    try {
      const tr = await fetch(`${base}/api/voice/transcribe`, {
        method: 'POST', headers: { 'content-type': 'audio/webm' }, body: Buffer.from('x'),
      });
      assert.equal(tr.status, 501);
      const sp = await fetch(`${base}/api/voice/speak`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hi' }),
      });
      assert.equal(sp.status, 501);
    } finally {
      await server.stop();
    }
  });

  it('returns 502 and stays online when an upstream voice provider fails', async () => {
    const voice: NonNullable<ApiDeps['voice']> = {
      sttProvider: 'broken',
      ttsProvider: 'broken',
      async transcribe() {
        throw new Error('upstream reset');
      },
      async synthesize() {
        throw new Error('upstream reset');
      },
    };
    const server = new ApiServer({ deps: deps(voice), port: 0, logger: silentLogger });
    await server.start();
    const base = `http://localhost:${server.address()}`;
    try {
      const speech = await fetch(`${base}/api/voice/speak`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hi' }),
      });
      assert.equal(speech.status, 502);
      assert.deepEqual(await speech.json(), { error: 'upstream provider failed' });

      const health = await fetch(`${base}/api/health`);
      assert.equal(health.status, 200);
    } finally {
      await server.stop();
    }
  });

  it('rejects browser origins outside the API allowlist', async () => {
    const server = new ApiServer({ deps: deps(), port: 0, logger: silentLogger });
    await server.start();
    const base = `http://localhost:${server.address()}`;
    try {
      const blocked = await fetch(`${base}/api/health`, {
        headers: { origin: 'https://attacker.example' },
      });
      assert.equal(blocked.status, 403);

      const allowed = await fetch(`${base}/api/health`, {
        headers: { origin: 'http://localhost:3000' },
      });
      assert.equal(allowed.status, 200);
      assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://localhost:3000');
    } finally {
      await server.stop();
    }
  });
});
