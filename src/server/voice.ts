/**
 * Voice mode (optional): speech-to-text in, text-to-speech out.
 *
 * The pipeline is just the existing agent with audio on the ends — STT turns the
 * mic into a chat message, the agent answers, TTS reads it back. ARES depends only
 * on the {@link VoiceProvider} interface here; a concrete provider ({@link
 * OpenAiVoiceProvider}, Whisper + a TTS voice) is wired in the composition root via
 * {@link buildVoiceProvider}. When no provider is configured the voice endpoints
 * return 501 and the UI mic button says so — voice is genuinely optional and needs
 * no extra keys unless you want it.
 */

export interface VoiceProvider {
  /** Provider labels surfaced by the clients and runtime status endpoint. */
  readonly sttProvider: string;
  readonly ttsProvider: string;
  /** Transcribe recorded audio to text. */
  transcribe(audio: Buffer, mimeType: string): Promise<string>;
  /** Synthesize speech for `text`, returning the audio bytes + their MIME type. */
  synthesize(text: string): Promise<{ audio: Buffer; mimeType: string }>;
}

export class VoiceNotConfiguredError extends Error {
  constructor() {
    super('No voice provider is configured.');
    this.name = 'VoiceNotConfiguredError';
  }
}

export interface OpenAiVoiceOptions {
  apiKey: string;
  /** Speech-to-text model. */
  sttModel?: string;
  /** Text-to-speech model. */
  ttsModel?: string;
  /** TTS voice name (alloy, echo, fable, onyx, nova, shimmer, …). */
  ttsVoice?: string;
  /** TTS audio container (mp3, opus, aac, flac, wav, pcm). */
  ttsFormat?: string;
  baseUrl?: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * OpenAI-backed voice provider: `whisper-1` for transcription, `tts-1` for
 * synthesis. Speaks only the {@link VoiceProvider} contract, so the rest of ARES
 * neither knows nor cares that it's OpenAI behind it.
 */
export class OpenAiVoiceProvider implements VoiceProvider {
  readonly sttProvider = 'openai';
  readonly ttsProvider = 'openai';
  private readonly apiKey: string;
  private readonly sttModel: string;
  private readonly ttsModel: string;
  private readonly ttsVoice: string;
  private readonly ttsFormat: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpenAiVoiceOptions) {
    this.apiKey = opts.apiKey;
    this.sttModel = opts.sttModel ?? 'whisper-1';
    this.ttsModel = opts.ttsModel ?? 'tts-1';
    this.ttsVoice = opts.ttsVoice ?? 'alloy';
    this.ttsFormat = opts.ttsFormat ?? 'mp3';
    this.baseUrl = opts.baseUrl ?? 'https://api.openai.com/v1';
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async transcribe(audio: Buffer, mimeType: string): Promise<string> {
    // Whisper infers the codec from the file extension, so the field needs a
    // plausible filename derived from the recorder's MIME type.
    const form = new FormData();
    form.append('model', this.sttModel);
    form.append('file', new Blob([new Uint8Array(audio)], { type: mimeType }), `audio.${extForMime(mimeType)}`);

    const res = await this.fetchImpl(`${this.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: form,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OpenAI transcription failed (${res.status}): ${body.slice(0, 300)}`);
    }
    const json = (await res.json()) as { text?: string };
    return json.text ?? '';
  }

  async synthesize(text: string): Promise<{ audio: Buffer; mimeType: string }> {
    const res = await this.fetchImpl(`${this.baseUrl}/audio/speech`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.ttsModel,
        voice: this.ttsVoice,
        input: text,
        response_format: this.ttsFormat,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OpenAI speech synthesis failed (${res.status}): ${body.slice(0, 300)}`);
    }
    const audio = Buffer.from(await res.arrayBuffer());
    return { audio, mimeType: mimeForFormat(this.ttsFormat) };
  }
}

export interface SpeechToTextProvider {
  readonly name: string;
  transcribe(audio: Buffer, mimeType: string): Promise<string>;
}

export interface TextToSpeechProvider {
  readonly name: string;
  synthesize(text: string): Promise<{ audio: Buffer; mimeType: string }>;
}

/** Combines independently selected input and output voice providers. */
export class CompositeVoiceProvider implements VoiceProvider {
  readonly sttProvider: string;
  readonly ttsProvider: string;

  constructor(
    private readonly stt: SpeechToTextProvider,
    private readonly tts: TextToSpeechProvider,
  ) {
    this.sttProvider = stt.name;
    this.ttsProvider = tts.name;
  }

  transcribe(audio: Buffer, mimeType: string): Promise<string> {
    return this.stt.transcribe(audio, mimeType);
  }

  synthesize(text: string): Promise<{ audio: Buffer; mimeType: string }> {
    return this.tts.synthesize(text);
  }
}

export class OpenAiSpeechToTextProvider implements SpeechToTextProvider {
  readonly name = 'openai';
  private readonly voice: OpenAiVoiceProvider;

  constructor(opts: OpenAiVoiceOptions) {
    this.voice = new OpenAiVoiceProvider(opts);
  }

  transcribe(audio: Buffer, mimeType: string): Promise<string> {
    return this.voice.transcribe(audio, mimeType);
  }
}

export class OpenAiTextToSpeechProvider implements TextToSpeechProvider {
  readonly name = 'openai';
  private readonly voice: OpenAiVoiceProvider;

  constructor(opts: OpenAiVoiceOptions) {
    this.voice = new OpenAiVoiceProvider(opts);
  }

  synthesize(text: string): Promise<{ audio: Buffer; mimeType: string }> {
    return this.voice.synthesize(text);
  }
}

export interface GeminiSpeechToTextOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/** Gemini audio understanding used as turn-based speech transcription. */
export class GeminiSpeechToTextProvider implements SpeechToTextProvider {
  readonly name = 'gemini';
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: GeminiSpeechToTextOptions) {
    this.model = opts.model ?? 'gemini-3.1-flash-lite';
    this.baseUrl = opts.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async transcribe(audio: Buffer, mimeType: string): Promise<string> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'x-goog-api-key': this.opts.apiKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [
              {
                text: 'Transcribe this voice note exactly. Return only the spoken words, without timestamps or commentary.',
              },
              {
                inlineData: {
                  mimeType: mimeType.split(';')[0] || 'audio/wav',
                  data: audio.toString('base64'),
                },
              },
            ],
          }],
          generationConfig: { temperature: 0 },
        }),
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Gemini transcription failed (${res.status}): ${body.slice(0, 300)}`);
    }
    const json = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    return (json.candidates?.[0]?.content?.parts ?? [])
      .map((part) => part.text ?? '')
      .join('')
      .trim();
  }
}

export interface ElevenLabsTextToSpeechOptions {
  apiKey: string;
  voiceId: string;
  model?: string;
  outputFormat?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/** Low-latency ElevenLabs Flash speech synthesis. */
export class ElevenLabsTextToSpeechProvider implements TextToSpeechProvider {
  readonly name = 'elevenlabs';
  private readonly model: string;
  private readonly outputFormat: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: ElevenLabsTextToSpeechOptions) {
    this.model = opts.model ?? 'eleven_flash_v2_5';
    this.outputFormat = opts.outputFormat ?? 'mp3_44100_128';
    this.baseUrl = opts.baseUrl ?? 'https://api.elevenlabs.io/v1';
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async synthesize(text: string): Promise<{ audio: Buffer; mimeType: string }> {
    const voiceId = encodeURIComponent(this.opts.voiceId);
    const format = encodeURIComponent(this.outputFormat);
    const res = await this.fetchImpl(
      `${this.baseUrl}/text-to-speech/${voiceId}/stream?output_format=${format}`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': this.opts.apiKey,
          'content-type': 'application/json',
          accept: mimeForElevenLabsFormat(this.outputFormat),
        },
        body: JSON.stringify({
          text,
          model_id: this.model,
        }),
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`ElevenLabs speech synthesis failed (${res.status}): ${body.slice(0, 300)}`);
    }
    return {
      audio: Buffer.from(await res.arrayBuffer()),
      mimeType: mimeForElevenLabsFormat(this.outputFormat),
    };
  }
}

export interface GeminiTextToSpeechOptions {
  apiKey: string;
  model?: string;
  /** Prebuilt Gemini voice name (e.g. Kore, Puck, Charon, Aoede). */
  voice?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Gemini text-to-speech (https://ai.google.dev/gemini-api/docs/speech-generation).
 *
 * generateContent with an AUDIO response modality returns raw little-endian PCM
 * (typically 24 kHz, 16-bit mono). Browsers can't play bare PCM, so we wrap it in
 * a minimal WAV container and return audio/wav.
 */
export class GeminiTextToSpeechProvider implements TextToSpeechProvider {
  readonly name = 'gemini';
  private readonly model: string;
  private readonly voice: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: GeminiTextToSpeechOptions) {
    this.model = opts.model ?? 'gemini-2.5-flash-preview-tts';
    this.voice = opts.voice ?? 'Kore';
    this.baseUrl = opts.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async synthesize(text: string): Promise<{ audio: Buffer; mimeType: string }> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'x-goog-api-key': this.opts.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voice } } },
          },
        }),
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Gemini speech synthesis failed (${res.status}): ${body.slice(0, 300)}`);
    }
    const json = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> } }>;
    };
    const part = (json.candidates?.[0]?.content?.parts ?? []).find((p) => p.inlineData?.data);
    const data = part?.inlineData?.data;
    if (!data) throw new Error('Gemini returned no audio data.');
    const pcm = Buffer.from(data, 'base64');
    const rate = parseRate(part?.inlineData?.mimeType) ?? 24000;
    return { audio: pcmToWav(pcm, rate), mimeType: 'audio/wav' };
  }
}

/** Extract the sample rate from a Gemini audio mime type like "audio/L16;codec=pcm;rate=24000". */
function parseRate(mimeType: string | undefined): number | undefined {
  const match = mimeType?.match(/rate=(\d+)/);
  return match ? Number(match[1]) : undefined;
}

/** Wrap little-endian 16-bit mono PCM in a minimal WAV (RIFF) container. */
function pcmToWav(pcm: Buffer, sampleRate: number, channels = 1, bitsPerSample = 16): Buffer {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // audio format = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Offline double for tests: "transcribes" to a fixed string and "synthesizes" to
 * a tiny byte buffer, so the voice endpoints can be exercised end-to-end without a
 * network call or an API key.
 */
export class FakeVoiceProvider implements VoiceProvider {
  readonly sttProvider = 'fake';
  readonly ttsProvider = 'fake';
  constructor(private readonly transcript = 'hello from fake voice') {}
  async transcribe(audio: Buffer, _mimeType: string): Promise<string> {
    // Echo the byte count so a caller can tell the audio actually arrived.
    return `${this.transcript} (${audio.length} bytes)`;
  }
  async synthesize(text: string): Promise<{ audio: Buffer; mimeType: string }> {
    return { audio: Buffer.from(`spoken:${text}`), mimeType: 'audio/mpeg' };
  }
}

/**
 * Build a voice provider from the environment. Returns undefined unless
 * `OPENAI_API_KEY` is set, so voice stays opt-in and the rest of ARES needs no
 * extra keys. Optional `ARES_VOICE_*` vars override the models/voice.
 */
export function buildVoiceProvider(env: NodeJS.ProcessEnv = process.env): VoiceProvider | undefined {
  const openaiKey = env.OPENAI_API_KEY;
  const geminiKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
  const elevenKey = env.ELEVENLABS_API_KEY;
  const elevenVoice = env.ELEVENLABS_VOICE_ID;
  const sttChoice = env.ARES_VOICE_STT_PROVIDER ?? 'auto';
  const ttsChoice = env.ARES_VOICE_TTS_PROVIDER ?? 'auto';

  const stt = sttChoice === 'gemini' || (sttChoice === 'auto' && Boolean(geminiKey))
    ? geminiKey
      ? new GeminiSpeechToTextProvider({
          apiKey: geminiKey,
          ...(env.ARES_GEMINI_STT_MODEL ? { model: env.ARES_GEMINI_STT_MODEL } : {}),
        })
      : undefined
    : openaiKey
      ? new OpenAiSpeechToTextProvider(openAiOptions(env, openaiKey))
      : undefined;

  const tts = selectTts(env, { openaiKey, geminiKey, elevenKey, elevenVoice, ttsChoice });

  return stt && tts ? new CompositeVoiceProvider(stt, tts) : undefined;
}

function selectTts(
  env: NodeJS.ProcessEnv,
  opts: {
    openaiKey: string | undefined;
    geminiKey: string | undefined;
    elevenKey: string | undefined;
    elevenVoice: string | undefined;
    ttsChoice: string;
  },
): TextToSpeechProvider | undefined {
  const { openaiKey, geminiKey, elevenKey, elevenVoice, ttsChoice } = opts;
  const elevenReady = Boolean(elevenKey && elevenVoice);

  const eleven = (): TextToSpeechProvider | undefined =>
    elevenKey && elevenVoice
      ? new ElevenLabsTextToSpeechProvider({
          apiKey: elevenKey,
          voiceId: elevenVoice,
          ...(env.ELEVENLABS_MODEL ? { model: env.ELEVENLABS_MODEL } : {}),
          ...(env.ELEVENLABS_OUTPUT_FORMAT ? { outputFormat: env.ELEVENLABS_OUTPUT_FORMAT } : {}),
        })
      : undefined;
  const gemini = (): TextToSpeechProvider | undefined =>
    geminiKey
      ? new GeminiTextToSpeechProvider({
          apiKey: geminiKey,
          ...(env.ARES_GEMINI_TTS_MODEL ? { model: env.ARES_GEMINI_TTS_MODEL } : {}),
          ...(env.ARES_GEMINI_TTS_VOICE ? { voice: env.ARES_GEMINI_TTS_VOICE } : {}),
        })
      : undefined;
  const openai = (): TextToSpeechProvider | undefined =>
    openaiKey ? new OpenAiTextToSpeechProvider(openAiOptions(env, openaiKey)) : undefined;

  if (ttsChoice === 'elevenlabs') return eleven();
  if (ttsChoice === 'gemini') return gemini();
  if (ttsChoice === 'openai') return openai();
  // auto: prefer ElevenLabs (lowest latency) → OpenAI → Gemini.
  if (elevenReady) return eleven();
  return openai() ?? gemini();
}

function openAiOptions(env: NodeJS.ProcessEnv, apiKey: string): OpenAiVoiceOptions {
  return {
    apiKey,
    ...(env.ARES_VOICE_STT_MODEL ? { sttModel: env.ARES_VOICE_STT_MODEL } : {}),
    ...(env.ARES_VOICE_TTS_MODEL ? { ttsModel: env.ARES_VOICE_TTS_MODEL } : {}),
    ...(env.ARES_VOICE_TTS_VOICE ? { ttsVoice: env.ARES_VOICE_TTS_VOICE } : {}),
    ...(env.ARES_VOICE_TTS_FORMAT ? { ttsFormat: env.ARES_VOICE_TTS_FORMAT } : {}),
    ...(env.OPENAI_BASE_URL ? { baseUrl: env.OPENAI_BASE_URL } : {}),
  };
}

/** Map a recorder MIME type to a Whisper-recognized file extension. */
function extForMime(mimeType: string): string {
  const base = mimeType.split(';')[0]!.trim().toLowerCase();
  switch (base) {
    case 'audio/webm': return 'webm';
    case 'audio/ogg': return 'ogg';
    case 'audio/wav':
    case 'audio/x-wav':
    case 'audio/wave': return 'wav';
    case 'audio/mp3':
    case 'audio/mpeg': return 'mp3';
    case 'audio/mp4':
    case 'audio/m4a':
    case 'audio/x-m4a': return 'm4a';
    case 'audio/flac': return 'flac';
    default: return 'webm';
  }
}

/** Map an OpenAI TTS response_format to its MIME type. */
function mimeForFormat(format: string): string {
  switch (format) {
    case 'opus': return 'audio/opus';
    case 'aac': return 'audio/aac';
    case 'flac': return 'audio/flac';
    case 'wav': return 'audio/wav';
    case 'pcm': return 'audio/pcm';
    case 'mp3':
    default: return 'audio/mpeg';
  }
}

function mimeForElevenLabsFormat(format: string): string {
  if (format.startsWith('pcm_')) return 'audio/pcm';
  if (format.startsWith('ulaw_')) return 'audio/basic';
  if (format.startsWith('alaw_')) return 'audio/x-alaw-basic';
  if (format.startsWith('opus_')) return 'audio/opus';
  return 'audio/mpeg';
}
