'use client';

import { useEffect, useRef, useState } from 'react';
import { SystemCore } from '@/components/SystemCore';
import { VoiceButton } from '@/components/VoiceButton';
import { VoiceWave } from '@/components/VoiceWave';
import { HudCorners } from '@/components/HudCorners';
import { HudClock } from '@/components/HudClock';
import { HudWeather } from '@/components/HudWeather';
import { HudMetrics } from '@/components/HudMetrics';
import { CircuitLines } from '@/components/CircuitLines';
import { Markdown } from '@/components/Markdown';
import { useWakeWord } from '@/components/useWakeWord';
import {
  api,
  streamChat,
  type AssistantMode,
  type AuditEvent,
  type RuntimeStatus,
} from '@/lib/api';
import type { ReactorState } from '@/components/ArcReactor';

interface Message {
  id: number;
  role: 'user' | 'assistant';
  text: string;
}

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [activity, setActivity] = useState<AuditEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [killEngaged, setKillEngaged] = useState(false);
  const [toolCount, setToolCount] = useState(0);
  const [lastError, setLastError] = useState<string | null>(null);
  const [mode, setMode] = useState<AssistantMode>('general');
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [autoSpeak, setAutoSpeak] = useState(true);
  const [speaking, setSpeaking] = useState(false);
  const [voiceListening, setVoiceListening] = useState(false);
  const [wakeEnabled, setWakeEnabled] = useState(true);
  const [wakeFlash, setWakeFlash] = useState(false);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const assistantRef = useRef<number>(-1);
  const messageIdRef = useRef(0);
  const scrollAnchorRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  // Streaming speech: sentences are queued as tokens arrive and played in order so
  // ARES talks *while* the answer is typing, not after it finishes.
  const speechQueueRef = useRef<string[]>([]);
  const prefetchedSpeechRef = useRef<{
    text: string;
    audio: Promise<{ blob?: Blob; error?: unknown }>;
  } | null>(null);
  const speechBusyRef = useRef(false);
  const speechGenRef = useRef(0); // bumped on stop to invalidate in-flight fetch/playback
  const pendingSpeechRef = useRef(''); // un-spoken tail not yet ending in a sentence boundary
  const speechChunkCountRef = useRef(0); // chunks emitted this turn (first flushes sooner)
  const wakeAudioCtxRef = useRef<AudioContext | null>(null);
  const wakeFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voiceFirstRef = useRef(false);
  const voiceResponseRef = useRef('');
  const chatAbortRef = useRef<AbortController | null>(null);
  const turnGenRef = useRef(0);

  useEffect(() => {
    let active = true;

    async function refreshTelemetry() {
      try {
        const startedAt = performance.now();
        const [health, status, kill, tools] = await Promise.all([
          api.health(),
          api.status(),
          api.killSwitch(),
          api.tools(),
        ]);
        if (!active) return;
        setLatencyMs(Math.round(performance.now() - startedAt));
        setConnected(health.ok);
        setRuntime(status);
        setKillEngaged(kill.state.engaged);
        setToolCount(tools.tools.filter((tool) => tool.enabled).length);
      } catch {
        if (active) setConnected(false);
      }
    }

    void refreshTelemetry();
    const id = window.setInterval(() => void refreshTelemetry(), 5000);
    return () => {
      active = false;
      window.clearInterval(id);
      audioRef.current?.pause();
      audioRef.current = null;
      chatAbortRef.current?.abort();
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    };
  }, []);

  useEffect(() => {
    scrollAnchorRef.current?.scrollIntoView({ behavior: streaming ? 'auto' : 'smooth' });
  }, [messages, streaming]);

  // Restore the conversation transcript from the previous session on first load.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(CHAT_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as Message[];
        if (Array.isArray(parsed) && parsed.length) {
          setMessages(parsed);
          messageIdRef.current = parsed.reduce((max, m) => Math.max(max, m.id), 0) + 1;
        }
      }
    } catch {
      // Corrupt/blocked storage — start fresh.
    }
    // Wake word defaults on; honour an explicit previous "off" choice.
    try {
      if (window.localStorage.getItem(WAKE_STORAGE_KEY) === 'off') setWakeEnabled(false);
    } catch {
      // ignore
    }
    setHydrated(true);
  }, []);

  // Remember the wake-word on/off choice across reloads.
  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(WAKE_STORAGE_KEY, wakeEnabled ? 'on' : 'off');
    } catch {
      // ignore
    }
  }, [wakeEnabled, hydrated]);

  // Persist the transcript whenever it settles (skip mid-stream churn).
  useEffect(() => {
    if (!hydrated || streaming) return;
    try {
      const trimmed = messages.slice(-MAX_SAVED_MESSAGES);
      window.localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(trimmed));
    } catch {
      // Storage full/blocked — non-fatal.
    }
  }, [messages, streaming, hydrated]);

  function clearHistory() {
    interruptResponse();
    setMessages([]);
    setActivity([]);
    setLastError(null);
    messageIdRef.current = 0;
    try {
      window.localStorage.removeItem(CHAT_STORAGE_KEY);
    } catch {
      // ignore
    }
  }

  async function send(text: string, options?: { voice?: boolean }) {
    const trimmed = text.trim();
    if (!trimmed || (streaming && !options?.voice)) return;

    stopSpeaking();
    // Snapshot prior turns (this render's messages, before we append the new ones)
    // so ARES answers with full conversation context.
    const history = messages
      .filter((m) => m.text.trim())
      .slice(-CONTEXT_TURNS)
      .map((m) => ({ role: m.role, content: m.text }));
    const turnGen = ++turnGenRef.current;
    const controller = new AbortController();
    chatAbortRef.current = controller;
    voiceFirstRef.current = Boolean(options?.voice && autoSpeak && runtime?.voiceEnabled);
    voiceResponseRef.current = '';
    setLastError(null);
    setActivity([]);
    setMessages((current) => [...current, { id: messageIdRef.current++, role: 'user', text: trimmed }]);
    setInput('');
    setStreaming(true);
    setMessages((current) => {
      assistantRef.current = current.length;
      return [...current, { id: messageIdRef.current++, role: 'assistant', text: '' }];
    });

    try {
      let gotToken = false;
      let failure: string | null = null;
      let completeText = '';
      await streamChat(trimmed, {
        onToken: (token) => {
          if (turnGen !== turnGenRef.current) return;
          gotToken = true;
          completeText += token;
          voiceResponseRef.current = completeText;
          if (!voiceFirstRef.current) appendAssistantToken(token);
          // Speak whole sentences (grouped to a natural length) for fluent prosody.
          if (autoSpeak && runtime?.voiceEnabled) {
            pendingSpeechRef.current += token;
            const { chunks, rest } = splitSpeechChunks(pendingSpeechRef.current, speechChunkCountRef.current);
            pendingSpeechRef.current = rest;
            for (const chunk of chunks) {
              enqueueSpeech(chunk);
              speechChunkCountRef.current++;
            }
          }
        },
        onActivity: (events) => {
          if (turnGen === turnGenRef.current) setActivity(events);
        },
        onError: (message) => {
          if (turnGen !== turnGenRef.current) return;
          failure = `System error: ${message}`;
          setLastError(message);
        },
        onDone: (done) => {
          if (turnGen !== turnGenRef.current) return;
          if (!gotToken && !failure && done.stopReason !== 'completed') {
            failure = `Run ${done.stopReason}. Review the systems activity feed for details.`;
            setLastError(failure);
          }
        },
      }, { mode, signal: controller.signal, history });

      if (turnGen !== turnGenRef.current) return;
      if (failure) {
        stopSpeaking(); // drop any partially-spoken sentences from the failed run
        setMessages((current) => replaceAssistantMessage(current, assistantRef.current, failure!));
      } else if (autoSpeak && runtime?.voiceEnabled) {
        // Speak the final tail that never ended in sentence punctuation.
        const tail = pendingSpeechRef.current;
        pendingSpeechRef.current = '';
        if (tail.trim()) enqueueSpeech(tail);
      }
    } catch (error) {
      if (turnGen !== turnGenRef.current || (error instanceof DOMException && error.name === 'AbortError')) return;
      const message = error instanceof Error ? error.message : String(error);
      setLastError(message);
      setMessages((current) => replaceAssistantMessage(current, assistantRef.current, `System error: ${message}`));
    } finally {
      if (turnGen === turnGenRef.current) {
        chatAbortRef.current = null;
        setStreaming(false);
      }
    }
  }

  function appendAssistantToken(token: string) {
    setMessages((current) => {
      const next = [...current];
      const index = assistantRef.current;
      if (next[index]) next[index] = { ...next[index], text: next[index].text + token };
      return next;
    });
  }

  function revealVoiceResponse() {
    if (!voiceFirstRef.current) return;
    voiceFirstRef.current = false;
    setMessages((current) => replaceAssistantMessage(current, assistantRef.current, voiceResponseRef.current));
  }

  function interruptResponse() {
    revealVoiceResponse();
    turnGenRef.current += 1;
    chatAbortRef.current?.abort();
    chatAbortRef.current = null;
    setStreaming(false);
    stopSpeaking();
  }

  /** Queue a chunk of text to be spoken after whatever is already playing. */
  function enqueueSpeech(text: string) {
    const clean = speakable(text);
    if (!clean) return;
    speechQueueRef.current.push(clean);
    if (speechBusyRef.current) prefetchNextSpeech();
    void drainSpeech();
  }

  function prefetchNextSpeech() {
    if (prefetchedSpeechRef.current || speechQueueRef.current.length === 0) return;
    const text = speechQueueRef.current.shift()!;
    prefetchedSpeechRef.current = {
      text,
      audio: api.speak(text)
        .then((blob) => ({ blob }))
        .catch((error: unknown) => ({ error })),
    };
  }

  /** Play one queued chunk while prefetching the following phrase. */
  async function drainSpeech() {
    if (speechBusyRef.current) return;
    prefetchNextSpeech();
    const prepared = prefetchedSpeechRef.current;
    prefetchedSpeechRef.current = null;
    if (!prepared) {
      setSpeaking(false);
      return;
    }
    speechBusyRef.current = true;
    setSpeaking(true);
    const gen = speechGenRef.current;
    try {
      const result = await prepared.audio;
      if (result.error) throw result.error;
      const blob = result.blob;
      if (!blob) throw new Error('Speech synthesis returned no audio.');
      if (gen !== speechGenRef.current) return; // stopped while fetching
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      audioUrlRef.current = url;
      await new Promise<void>((resolve) => {
        audio.onended = () => resolve();
        audio.onerror = () => resolve();
        void audio.play()
          .then(() => {
            revealVoiceResponse();
            prefetchNextSpeech();
          })
          .catch(() => resolve());
      });
      if (audioUrlRef.current === url) {
        URL.revokeObjectURL(url);
        audioUrlRef.current = null;
      }
      if (audioRef.current === audio) audioRef.current = null;
    } catch (error) {
      if (gen === speechGenRef.current) {
        revealVoiceResponse();
        setLastError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      // Only the current generation owns the pipeline; a stop hands it to no one.
      if (gen === speechGenRef.current) {
        speechBusyRef.current = false;
        void drainSpeech();
      }
    }
  }

  /** Speak a single piece of text immediately, cancelling anything in progress. */
  function speakNow(text: string) {
    stopSpeaking();
    enqueueSpeech(text);
  }

  function stopSpeaking() {
    speechGenRef.current += 1; // invalidate any in-flight fetch/playback
    speechQueueRef.current = [];
    prefetchedSpeechRef.current = null;
    pendingSpeechRef.current = '';
    speechChunkCountRef.current = 0;
    speechBusyRef.current = false;
    audioRef.current?.pause();
    audioRef.current = null;
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    audioUrlRef.current = null;
    setSpeaking(false);
  }

  // A short rising two-tone "blip" acknowledging the wake word, via Web Audio.
  function playWakeChime() {
    try {
      const Ctx = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      const ctx = wakeAudioCtxRef.current ?? (wakeAudioCtxRef.current = new Ctx());
      if (ctx.state === 'suspended') void ctx.resume();
      const now = ctx.currentTime;
      const tone = (freq: number, start: number, dur: number) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now + start);
        gain.gain.setValueAtTime(0.0001, now + start);
        gain.gain.exponentialRampToValueAtTime(0.2, now + start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
        osc.connect(gain).connect(ctx.destination);
        osc.start(now + start);
        osc.stop(now + start + dur + 0.02);
      };
      tone(680, 0, 0.12);
      tone(1020, 0.09, 0.16);
    } catch {
      // Audio unavailable — the visual flash still confirms.
    }
  }

  // Browsers block audio until a user gesture; prime the context on first interaction
  // so the wake chime is audible even though wake listening starts on its own.
  useEffect(() => {
    const prime = () => {
      try {
        const Ctx = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctx) return;
        const ctx = wakeAudioCtxRef.current ?? (wakeAudioCtxRef.current = new Ctx());
        void ctx.resume();
      } catch {
        // ignore
      }
    };
    window.addEventListener('pointerdown', prime, { once: true });
    window.addEventListener('keydown', prime, { once: true });
    return () => {
      window.removeEventListener('pointerdown', prime);
      window.removeEventListener('keydown', prime);
    };
  }, []);

  // Always-on wake word: say "ARES" (alone or leading a command) — no button press.
  // Detection runs entirely in the browser, so it works even without server voice.
  const wake = useWakeWord({
    enabled: wakeEnabled && connected,
    paused: streaming || speaking || voiceListening,
    onWake: () => {
      playWakeChime();
      setWakeFlash(true);
      if (wakeFlashTimerRef.current) clearTimeout(wakeFlashTimerRef.current);
      wakeFlashTimerRef.current = setTimeout(() => setWakeFlash(false), 1800);
    },
    onCommand: (text) => {
      interruptResponse();
      void send(text, { voice: true });
    },
  });

  const reactorState: ReactorState = !connected
    ? 'offline'
    : lastError
      ? 'error'
      : killEngaged
        ? 'halted'
        : streaming
          ? 'thinking'
          : 'idle';
  const toolEvents = activity.filter((event) => event.type.startsWith('tool_') || event.type === 'refusal');

  return (
    <div className="mx-auto grid h-[calc(100dvh-64px)] max-w-[1800px] grid-cols-1 md:h-[calc(100dvh-73px)] lg:grid-cols-[minmax(0,1fr)_330px]">
      <section className="relative flex min-h-0 flex-col">
        <CircuitLines className="z-0" />
        <HudCorners />
        {wakeFlash && (
          <div className="pointer-events-none absolute left-1/2 top-4 z-30 -translate-x-1/2">
            <div className="flex items-center gap-2 border border-ares-green/60 bg-ares-green/10 px-4 py-2 font-mono text-xs uppercase tracking-[0.2em] text-ares-green shadow-[0_0_24px_rgba(53,242,161,0.35)] backdrop-blur">
              <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-ares-green shadow-[0_0_12px_#35f2a1]" />
              ARES online — listening
            </div>
          </div>
        )}
        <div className="relative z-10 min-h-0 flex-1 overflow-y-auto px-3 pb-6 pt-3 sm:px-6 sm:pb-8 sm:pt-5 lg:px-8">
          <div className="mx-auto max-w-4xl">
            <SystemCore
              state={reactorState}
              connected={connected}
              killEngaged={killEngaged}
              toolCount={toolCount}
              model={runtime ? `${runtime.provider} / ${runtime.model}` : 'detecting provider'}
            />

            <div className="mb-4 flex min-w-0 items-center gap-2 sm:mb-5 sm:gap-3">
              <span className="hud-label truncate">Communication channel</span>
              <span className="h-px flex-1 bg-gradient-to-r from-ares-cyan/40 to-transparent" />
              <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-ares-muted">
                {messages.length.toString().padStart(2, '0')} packets
              </span>
              {messages.length > 0 && (
                <button
                  type="button"
                  onClick={clearHistory}
                  title="Clear conversation history"
                  className="shrink-0 border border-ares-line px-2 py-1.5 font-mono text-[9px] uppercase tracking-[0.14em] text-ares-muted transition hover:border-ares-red/50 hover:text-ares-red"
                >
                  New session
                </button>
              )}
            </div>

            <div className="space-y-4 sm:space-y-5" aria-live="polite">
              {messages.length === 0 && (
                <div className="hud-panel mx-auto max-w-2xl p-5 text-center sm:p-7">
                  <div className="mb-3 font-mono text-xs uppercase tracking-[0.28em] text-ares-cyan">Interface ready</div>
                  <p className="text-sm leading-7 text-slate-300">
                    Ask ARES to reason, retrieve memory, or execute a task. Tool telemetry will appear in the live operations log.
                  </p>
                </div>
              )}

              {messages.map((message) => (
                <article key={message.id} className={message.role === 'user' ? 'ml-auto max-w-[92%] sm:max-w-[76%]' : 'mr-auto max-w-[97%] sm:max-w-[82%]'}>
                  <div className={`mb-1 flex items-center gap-2 ${message.role === 'user' ? 'justify-end' : ''}`}>
                    <span className="hud-label">{message.role === 'user' ? 'Principal' : 'ARES'}</span>
                    <span className={`h-px w-10 ${message.role === 'user' ? 'bg-ares-amber/60' : 'bg-ares-cyan/60'}`} />
                    {message.role === 'assistant' && message.text && runtime?.voiceEnabled && (
                      <button
                        type="button"
                        onClick={() => speaking ? stopSpeaking() : speakNow(message.text)}
                        className="font-mono text-[9px] uppercase tracking-[0.14em] text-ares-muted transition hover:text-ares-cyan"
                        aria-label={speaking ? 'Stop assistant speech' : 'Read assistant response aloud'}
                      >
                        {speaking ? 'Stop voice' : 'Speak'}
                      </button>
                    )}
                  </div>
                  <div className={`relative break-words border px-3 py-2.5 text-sm leading-6 backdrop-blur-sm sm:px-4 sm:py-3 sm:leading-7 ${
                    message.role === 'user'
                      ? 'border-ares-amber/35 bg-ares-amber/[0.07] text-amber-50 shadow-hud-amber'
                      : 'border-ares-cyan/30 bg-ares-panel/80 text-slate-100 shadow-hud-cyan'
                  }`}>
                    <span className={`absolute top-0 h-px w-12 ${message.role === 'user' ? 'right-0 bg-ares-amber' : 'left-0 bg-ares-cyan'}`} />
                    {message.text ? (
                      message.role === 'assistant'
                        ? <Markdown content={message.text} />
                        : <div className="whitespace-pre-wrap">{message.text}</div>
                    ) : (
                      <span className="thinking-shimmer font-mono text-xs uppercase tracking-[0.2em]">
                        {voiceFirstRef.current ? 'Preparing voice response...' : 'Synthesizing response...'}
                      </span>
                    )}
                  </div>
                </article>
              ))}
              <div ref={scrollAnchorRef} />
            </div>
          </div>
        </div>

        <form
          className="relative z-10 border-t border-ares-line/80 bg-ares-bg/95 px-3 py-3 backdrop-blur-xl sm:px-6 sm:py-4 lg:px-8"
          onSubmit={(event) => {
            event.preventDefault();
            void send(input);
          }}
        >
          <div className="telemetry-line absolute left-0 top-0 h-px w-full" />
          <div className="mx-auto max-w-4xl">
            <div className="-mx-1 mb-2 flex items-center gap-2 overflow-x-auto px-1 pb-1">
              <label htmlFor="assistant-mode" className="hud-label hidden shrink-0 sm:block">Mode</label>
              <select
                id="assistant-mode"
                value={mode}
                onChange={(event) => setMode(event.target.value as AssistantMode)}
                className="h-9 shrink-0 border border-ares-line bg-ares-bg px-2 font-mono text-[10px] uppercase tracking-[0.12em] text-ares-cyan outline-none"
                disabled={streaming}
              >
                {ASSISTANT_MODES.map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
              <button
                type="button"
                onClick={() => {
                  setAutoSpeak((value) => !value);
                  if (autoSpeak) stopSpeaking();
                }}
                disabled={!runtime?.voiceEnabled}
                className={`h-9 shrink-0 border px-2 font-mono text-[10px] uppercase tracking-[0.12em] ${
                  autoSpeak && runtime?.voiceEnabled
                    ? 'border-ares-cyan/50 bg-ares-cyan/10 text-ares-cyan'
                    : 'border-ares-line text-ares-muted'
                } disabled:opacity-40`}
              >
                Auto voice {autoSpeak && runtime?.voiceEnabled ? 'on' : 'off'}
              </button>
              {speaking && (
                <button type="button" onClick={stopSpeaking} className="h-9 shrink-0 border border-ares-amber/50 bg-ares-amber/10 px-2 font-mono text-[10px] uppercase tracking-[0.12em] text-ares-amber">
                  Interrupt speech
                </button>
              )}
              {wake.supported && (
                <button
                  type="button"
                  onClick={() => setWakeEnabled((value) => !value)}
                  title={wakeEnabled ? 'Just say "ARES" to talk hands-free' : 'Enable hands-free wake word'}
                  className={`h-9 shrink-0 border px-2 font-mono text-[10px] uppercase tracking-[0.12em] ${
                    wakeEnabled
                      ? 'border-ares-cyan/50 bg-ares-cyan/10 text-ares-cyan'
                      : 'border-ares-line text-ares-muted'
                  }`}
                >
                  {wakeEnabled ? '“ARES” wake on' : '“ARES” wake off'}
                </button>
              )}
              {wakeEnabled && wake.status !== 'idle' && (
                <span className={`flex shrink-0 items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] ${
                  wake.status === 'armed' ? 'text-ares-amber' : wake.status === 'heard' ? 'text-ares-green' : 'text-ares-cyan/80'
                }`}>
                  <span className={`h-2 w-2 rounded-full ${
                    wake.status === 'armed'
                      ? 'animate-pulse bg-ares-amber shadow-[0_0_10px_#ff9f1c]'
                      : wake.status === 'heard'
                        ? 'bg-ares-green shadow-[0_0_10px_#35f2a1]'
                        : 'animate-pulse bg-ares-cyan shadow-[0_0_10px_#00d9ff]'
                  }`} />
                  {wake.status === 'armed' ? 'Listening for command' : wake.status === 'heard' ? 'Heard you' : 'Awaiting “ARES”'}
                </span>
              )}
              {wake.error && (
                <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ares-red">{wake.error}</span>
              )}
              {runtime?.voiceEnabled && (
                <span className="ml-auto hidden shrink-0 items-center gap-2 sm:flex">
                  <span className="hud-label hidden sm:inline">{speaking ? 'Vox' : 'Vox idle'}</span>
                  <VoiceWave active={speaking} />
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 sm:gap-3">
              <span className="hidden font-mono text-lg text-ares-cyan sm:block">&gt;_</span>
              <label htmlFor="ares-command" className="sr-only">Message ARES</label>
              <input
                id="ares-command"
                className="hud-input h-12 min-w-0 flex-1 px-3 sm:px-4"
                placeholder={connected ? `Command ARES in ${mode} mode...` : 'Waiting for API link...'}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                disabled={streaming || !connected}
                autoComplete="off"
              />
              <VoiceButton
                onTranscript={(transcript) => void send(transcript, { voice: true })}
                onBeforeRecord={interruptResponse}
                onListeningChange={setVoiceListening}
                disabled={!connected || !runtime?.voiceEnabled}
              />
              <button type="submit" className="hud-button h-11 shrink-0 px-3 sm:px-6" disabled={streaming || !connected || !input.trim()}>
                <span className="sm:hidden">{streaming ? 'Wait' : 'Send'}</span>
                <span className="hidden sm:inline">{streaming ? 'Running' : 'Transmit'}</span>
              </button>
            </div>
          </div>
        </form>
      </section>

      <aside className="relative hidden min-h-0 border-l border-ares-line/80 bg-ares-panel/30 lg:flex lg:flex-col">
        <HudCorners color="amber" />
        <div className="space-y-4 border-b border-ares-line/70 px-5 py-4">
          <HudClock />
          <span className="block h-px w-full bg-gradient-to-r from-ares-cyan/30 via-ares-line to-transparent" />
          <HudWeather />
        </div>
        <div className="border-b border-ares-line/70 px-5 py-4">
          <div className="flex items-center justify-between">
            <h2 className="font-mono text-xs uppercase tracking-[0.2em] text-ares-cyan">Operations log</h2>
            <span className={`h-2 w-2 rounded-full ${streaming ? 'animate-pulse bg-ares-amber shadow-[0_0_10px_#ff9f1c]' : 'bg-ares-cyan shadow-[0_0_10px_#00d9ff]'}`} />
          </div>
          <p className="mt-1 font-mono text-[9px] uppercase tracking-[0.15em] text-ares-muted">Live tool and safety telemetry</p>
        </div>

        <ol className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 font-mono text-[11px]">
          {toolEvents.map((event, index) => (
            <li key={`${event.ts}-${index}`} className="animate-hud-flicker border-l border-ares-cyan/45 bg-black/25 px-3 py-2">
              <div className="mb-1 flex justify-between gap-3">
                <span className={event.type === 'refusal' ? 'text-ares-red' : 'text-ares-cyan'}>{event.type.toUpperCase()}</span>
                <time className="text-ares-muted">{formatTime(event.ts)}</time>
              </div>
              <div className="break-words leading-5 text-slate-400">{JSON.stringify(event.detail)}</div>
            </li>
          ))}
          {toolEvents.length === 0 && (
            <li className="border border-dashed border-ares-line px-3 py-6 text-center uppercase tracking-[0.14em] text-ares-muted">
              No tool calls detected
            </li>
          )}
        </ol>

        <div className="grid grid-cols-2 gap-px border-t border-ares-line bg-ares-line">
          <TelemetryCell label="Stream" value={streaming ? 'active' : 'standby'} active={streaming} />
          <TelemetryCell label="Latency" value={latencyMs === null ? '--' : `${latencyMs}ms`} active={Boolean(latencyMs && latencyMs > 400)} />
        </div>
        <HudMetrics latencyMs={latencyMs} online={connected} />
      </aside>
    </div>
  );
}

const CHAT_STORAGE_KEY = 'ares.chat.history';
const WAKE_STORAGE_KEY = 'ares.wake.enabled';
const MAX_SAVED_MESSAGES = 100;
// How many prior turns to send back to ARES for conversation context.
const CONTEXT_TURNS = 16;

const ASSISTANT_MODES: AssistantMode[] = [
  'general',
  'developer',
  'research',
  'business',
  'project',
  'document',
  'hr',
  'communications',
];

function replaceAssistantMessage(messages: Message[], index: number, text: string): Message[] {
  const next = [...messages];
  if (next[index]) next[index] = { ...next[index], text };
  return next;
}

// Abbreviations whose trailing period must NOT be treated as a sentence end —
// otherwise the synthesizer pauses mid-sentence and sounds like it's reading.
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'e.g', 'i.e',
  'eg', 'ie', 'a.m', 'p.m', 'am', 'pm', 'fig', 'no', 'inc', 'ltd', 'co', 'approx',
]);

// Speech is chunked at sentence boundaries so each TTS request carries a full,
// naturally-intoned sentence. The first chunk flushes early (low latency to first
// audio); later chunks accumulate to a fuller length for smoother, fewer-seam prosody.
const FIRST_CHUNK_TARGET = 60;
const CHUNK_TARGET = 220;

/**
 * Pull complete, naturally-sized speech chunks out of a streaming buffer, leaving
 * a tail (an unfinished sentence, or complete sentences too short to flush yet) to
 * keep buffering. `emitted` is how many chunks already went out this turn, so the
 * very first one can flush sooner.
 */
function splitSpeechChunks(buffer: string, emitted: number): { chunks: string[]; rest: string } {
  const { sentences, tail } = splitSentences(buffer);
  const chunks: string[] = [];
  let acc = '';
  for (const sentence of sentences) {
    acc = acc ? `${acc} ${sentence}` : sentence;
    const target = emitted === 0 && chunks.length === 0 ? FIRST_CHUNK_TARGET : CHUNK_TARGET;
    if (acc.length >= target) {
      chunks.push(acc);
      acc = '';
    }
  }
  // Unflushed complete sentences + the unfinished tail stay buffered for next time.
  const rest = acc ? `${acc} ${tail}` : tail;
  return { chunks, rest };
}

/**
 * Split text into complete sentences and a trailing unfinished `tail`. A boundary
 * is `.`/`!`/`?` (or a newline) followed by whitespace — guarded against decimals
 * (3.14), initials (J.), and common abbreviations so it never breaks mid-sentence.
 */
function splitSentences(buffer: string): { sentences: string[]; tail: string } {
  const sentences: string[] = [];
  let start = 0;
  for (let i = 0; i < buffer.length; i++) {
    const ch = buffer[i]!;
    if (ch === '\n') {
      const seg = buffer.slice(start, i).trim();
      if (seg) sentences.push(seg);
      start = i + 1;
      continue;
    }
    if (ch !== '.' && ch !== '!' && ch !== '?') continue;

    // Absorb any closing quotes/brackets that belong to the sentence.
    let j = i + 1;
    while (j < buffer.length && /["')\]]/.test(buffer[j]!)) j++;
    const next = buffer[j];
    if (next === undefined || !/\s/.test(next)) continue; // not a confirmed boundary yet

    if (ch === '.') {
      if (/\d/.test(buffer[i - 1] ?? '') && /\d/.test(buffer[i + 1] ?? '')) continue; // decimal
      const word = (buffer.slice(start, i).split(/[\s(]/).pop() ?? '').toLowerCase();
      if (word.length === 1 || ABBREVIATIONS.has(word)) continue; // initial / abbreviation
    }

    const seg = buffer.slice(start, j).trim();
    if (seg) sentences.push(seg);
    start = j;
  }
  return { sentences, tail: buffer.slice(start) };
}

/** Strip markdown so the synthesizer doesn't read asterisks, list bullets, or link URLs aloud. */
function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '')      // bullet markers
    .replace(/^\s*\d+[.)]\s+/gm, '')    // numbered-list markers
    .replace(/[*_#>~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '--:--:--' : date.toLocaleTimeString([], { hour12: false });
}

function TelemetryCell({ label, value, active = false }: { label: string; value: string; active?: boolean }) {
  return (
    <div className="bg-ares-bg/90 px-4 py-3">
      <div className="hud-label">{label}</div>
      <div className={`hud-value mt-1 ${active ? 'text-ares-amber' : ''}`}>{value}</div>
    </div>
  );
}
