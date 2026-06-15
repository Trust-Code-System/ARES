'use client';

import { useEffect, useRef, useState } from 'react';
import { SystemCore } from '@/components/SystemCore';
import { VoiceButton } from '@/components/VoiceButton';
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
  const assistantRef = useRef<number>(-1);
  const messageIdRef = useRef(0);
  const scrollAnchorRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);

  useEffect(() => {
    let active = true;

    async function refreshTelemetry() {
      try {
        const [health, status, kill, tools] = await Promise.all([
          api.health(),
          api.status(),
          api.killSwitch(),
          api.tools(),
        ]);
        if (!active) return;
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
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    };
  }, []);

  useEffect(() => {
    scrollAnchorRef.current?.scrollIntoView({ behavior: streaming ? 'auto' : 'smooth' });
  }, [messages, streaming]);

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || streaming) return;

    stopSpeaking();
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
          gotToken = true;
          completeText += token;
          setMessages((current) => {
            const next = [...current];
            const index = assistantRef.current;
            if (next[index]) next[index] = { ...next[index], text: next[index].text + token };
            return next;
          });
        },
        onActivity: (events) => setActivity(events),
        onError: (message) => {
          failure = `System error: ${message}`;
          setLastError(message);
        },
        onDone: (done) => {
          if (!gotToken && !failure && done.stopReason !== 'completed') {
            failure = `Run ${done.stopReason}. Review the systems activity feed for details.`;
            setLastError(failure);
          }
        },
      }, { mode });

      if (failure) {
        setMessages((current) => replaceAssistantMessage(current, assistantRef.current, failure!));
      } else if (autoSpeak && completeText.trim() && runtime?.voiceEnabled) {
        void speak(completeText);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLastError(message);
      setMessages((current) => replaceAssistantMessage(current, assistantRef.current, `System error: ${message}`));
    } finally {
      setStreaming(false);
    }
  }

  async function speak(text: string) {
    stopSpeaking();
    try {
      setSpeaking(true);
      const blob = await api.speak(text);
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      audioUrlRef.current = url;
      audio.onended = stopSpeaking;
      audio.onerror = stopSpeaking;
      await audio.play();
    } catch (error) {
      setSpeaking(false);
      setLastError(error instanceof Error ? error.message : String(error));
    }
  }

  function stopSpeaking() {
    audioRef.current?.pause();
    audioRef.current = null;
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    audioUrlRef.current = null;
    setSpeaking(false);
  }

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
    <div className="mx-auto grid h-[calc(100vh-73px)] max-w-[1800px] grid-cols-1 lg:grid-cols-[minmax(0,1fr)_330px]">
      <section className="flex min-h-0 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 pt-5 sm:px-8">
          <div className="mx-auto max-w-4xl">
            <SystemCore
              state={reactorState}
              connected={connected}
              killEngaged={killEngaged}
              toolCount={toolCount}
              model={runtime ? `${runtime.provider} / ${runtime.model}` : 'detecting provider'}
            />

            <div className="mb-5 flex items-center gap-3">
              <span className="hud-label">Communication channel</span>
              <span className="h-px flex-1 bg-gradient-to-r from-ares-cyan/40 to-transparent" />
              <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-ares-muted">
                {messages.length.toString().padStart(2, '0')} packets
              </span>
            </div>

            <div className="space-y-5" aria-live="polite">
              {messages.length === 0 && (
                <div className="hud-panel mx-auto max-w-2xl p-7 text-center">
                  <div className="mb-3 font-mono text-xs uppercase tracking-[0.28em] text-ares-cyan">Interface ready</div>
                  <p className="text-sm leading-7 text-slate-300">
                    Ask ARES to reason, retrieve memory, or execute a task. Tool telemetry will appear in the live operations log.
                  </p>
                </div>
              )}

              {messages.map((message) => (
                <article key={message.id} className={message.role === 'user' ? 'ml-auto max-w-[88%] sm:max-w-[76%]' : 'mr-auto max-w-[94%] sm:max-w-[82%]'}>
                  <div className={`mb-1 flex items-center gap-2 ${message.role === 'user' ? 'justify-end' : ''}`}>
                    <span className="hud-label">{message.role === 'user' ? 'Principal' : 'ARES'}</span>
                    <span className={`h-px w-10 ${message.role === 'user' ? 'bg-ares-amber/60' : 'bg-ares-cyan/60'}`} />
                    {message.role === 'assistant' && message.text && runtime?.voiceEnabled && (
                      <button
                        type="button"
                        onClick={() => speaking ? stopSpeaking() : void speak(message.text)}
                        className="font-mono text-[9px] uppercase tracking-[0.14em] text-ares-muted transition hover:text-ares-cyan"
                        aria-label={speaking ? 'Stop assistant speech' : 'Read assistant response aloud'}
                      >
                        {speaking ? 'Stop voice' : 'Speak'}
                      </button>
                    )}
                  </div>
                  <div className={`relative whitespace-pre-wrap border px-4 py-3 text-sm leading-7 backdrop-blur-sm ${
                    message.role === 'user'
                      ? 'border-ares-amber/35 bg-ares-amber/[0.07] text-amber-50 shadow-hud-amber'
                      : 'border-ares-cyan/30 bg-ares-panel/80 text-slate-100 shadow-hud-cyan'
                  }`}>
                    <span className={`absolute top-0 h-px w-12 ${message.role === 'user' ? 'right-0 bg-ares-amber' : 'left-0 bg-ares-cyan'}`} />
                    {message.text || (
                      <span className="thinking-shimmer font-mono text-xs uppercase tracking-[0.2em]">
                        Synthesizing response...
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
          className="relative border-t border-ares-line/80 bg-ares-bg/90 px-4 py-4 backdrop-blur-xl sm:px-8"
          onSubmit={(event) => {
            event.preventDefault();
            void send(input);
          }}
        >
          <div className="telemetry-line absolute left-0 top-0 h-px w-full" />
          <div className="mx-auto max-w-4xl">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <label htmlFor="assistant-mode" className="hud-label">Mode</label>
              <select
                id="assistant-mode"
                value={mode}
                onChange={(event) => setMode(event.target.value as AssistantMode)}
                className="border border-ares-line bg-ares-bg px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-ares-cyan outline-none"
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
                className={`border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] ${
                  autoSpeak && runtime?.voiceEnabled
                    ? 'border-ares-cyan/50 bg-ares-cyan/10 text-ares-cyan'
                    : 'border-ares-line text-ares-muted'
                } disabled:opacity-40`}
              >
                Auto voice {autoSpeak && runtime?.voiceEnabled ? 'on' : 'off'}
              </button>
              {speaking && (
                <button type="button" onClick={stopSpeaking} className="border border-ares-amber/50 bg-ares-amber/10 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-ares-amber">
                  Interrupt speech
                </button>
              )}
            </div>
            <div className="flex items-center gap-3">
              <span className="hidden font-mono text-lg text-ares-cyan sm:block">&gt;_</span>
              <label htmlFor="ares-command" className="sr-only">Message ARES</label>
              <input
                id="ares-command"
                className="hud-input h-12 min-w-0 flex-1 px-4"
                placeholder={connected ? `Command ARES in ${mode} mode...` : 'Waiting for API link...'}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                disabled={streaming || !connected}
                autoComplete="off"
              />
              <VoiceButton
                onTranscript={(transcript) => void send(transcript)}
                onBeforeRecord={stopSpeaking}
                disabled={streaming || !connected || !runtime?.voiceEnabled}
              />
              <button type="submit" className="hud-button h-11 px-4 sm:px-6" disabled={streaming || !connected || !input.trim()}>
                {streaming ? 'Running' : 'Transmit'}
              </button>
            </div>
          </div>
        </form>
      </section>

      <aside className="hidden min-h-0 border-l border-ares-line/80 bg-ares-panel/30 lg:flex lg:flex-col">
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
          <TelemetryCell label="Events" value={toolEvents.length.toString().padStart(2, '0')} />
        </div>
      </aside>
    </div>
  );
}

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
