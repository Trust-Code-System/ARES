'use client';

import { useEffect, useRef, useState } from 'react';
import { api, UnauthorizedError } from '@/lib/api';

const SILENCE_MS = 700;
const MAX_RECORDING_MS = 30_000;
const SPEECH_LEVEL = 0.025;

/**
 * Fast voice capture. Chromium uses its streaming speech recognizer so a turn is
 * submitted as soon as the user pauses. Other browsers fall back to MediaRecorder
 * with local silence detection, then use the configured server transcription.
 */
export function VoiceButton({
  onTranscript,
  onBeforeRecord,
  onListeningChange,
  disabled,
}: {
  onTranscript: (text: string) => void;
  onBeforeRecord?: () => void;
  onListeningChange?: (listening: boolean) => void;
  disabled?: boolean;
}) {
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const transcriptRef = useRef('');
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const monitorCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => () => cleanup(), []);

  function setListening(value: boolean) {
    setRecording(value);
    onListeningChange?.(value);
  }

  function cleanup() {
    monitorCleanupRef.current?.();
    monitorCleanupRef.current = null;

    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    if (recognition) {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      recognition.onstart = null;
      try {
        recognition.abort();
      } catch {
        // Already stopped.
      }
    }

    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      if (recorder.state !== 'inactive') recorder.stop();
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }

  async function start() {
    setError(null);
    onBeforeRecord?.();
    transcriptRef.current = '';

    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (Recognition) {
      startRecognition(new Recognition());
      return;
    }

    await startRecorder();
  }

  function startRecognition(recognition: SpeechRecognition) {
    recognitionRef.current = recognition;
    recognition.lang = navigator.language || 'en-US';
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => setListening(true);
    recognition.onresult = (event) => {
      let text = '';
      let final = false;
      for (let i = 0; i < event.results.length; i += 1) {
        text += `${event.results[i]?.[0]?.transcript ?? ''} `;
        final ||= Boolean(event.results[i]?.isFinal);
      }
      transcriptRef.current = text.trim();
      if (final) recognition.stop();
    };
    recognition.onerror = (event) => {
      if (event.error !== 'aborted') {
        setError(event.error === 'no-speech' ? 'No speech detected' : 'Voice recognition failed');
      }
    };
    recognition.onend = () => {
      recognitionRef.current = null;
      setListening(false);
      const text = transcriptRef.current.trim();
      transcriptRef.current = '';
      if (text) onTranscript(text);
    };

    try {
      recognition.start();
    } catch {
      recognitionRef.current = null;
      setListening(false);
      setError('Voice recognition failed');
    }
  }

  async function startRecorder() {
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;
      const mimeType = preferredMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        void transcribe(blob, recorder.mimeType || 'audio/webm', stream!);
      };
      recorder.start(250);
      monitorSilence(stream, recorder);
      setListening(true);
    } catch {
      stream?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setListening(false);
      setError('Microphone access denied');
    }
  }

  function monitorSilence(stream: MediaStream, recorder: MediaRecorder) {
    const context = new AudioContext();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    const samples = new Uint8Array(analyser.fftSize);
    source.connect(analyser);

    let heardSpeech = false;
    let lastSpeechAt = performance.now();
    const startedAt = lastSpeechAt;
    const timer = window.setInterval(() => {
      analyser.getByteTimeDomainData(samples);
      let energy = 0;
      for (const sample of samples) {
        const normalized = (sample - 128) / 128;
        energy += normalized * normalized;
      }
      const level = Math.sqrt(energy / samples.length);
      const now = performance.now();
      if (level >= SPEECH_LEVEL) {
        heardSpeech = true;
        lastSpeechAt = now;
      }
      if ((heardSpeech && now - lastSpeechAt >= SILENCE_MS) || now - startedAt >= MAX_RECORDING_MS) {
        if (recorder.state !== 'inactive') recorder.stop();
      }
    }, 100);

    monitorCleanupRef.current = () => {
      window.clearInterval(timer);
      source.disconnect();
      void context.close();
    };
  }

  function stop() {
    const recognition = recognitionRef.current;
    if (recognition) {
      recognition.stop();
      return;
    }
    const recorder = recorderRef.current;
    if (recorder?.state !== 'inactive') recorder?.stop();
  }

  async function transcribe(blob: Blob, contentType: string, stream: MediaStream) {
    monitorCleanupRef.current?.();
    monitorCleanupRef.current = null;
    setListening(false);
    setBusy(true);
    try {
      const text = await api.transcribe(blob, contentType);
      if (text) onTranscript(text);
    } catch (caught) {
      if (caught instanceof UnauthorizedError) setError('Session expired');
      else setError('Transcription failed');
    } finally {
      setBusy(false);
      stream.getTracks().forEach((track) => track.stop());
      if (streamRef.current === stream) streamRef.current = null;
      recorderRef.current = null;
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        title={error ?? (recording ? 'Listening - tap to finish' : 'Talk to ARES')}
        aria-label={recording ? 'Finish voice message' : 'Start voice conversation'}
        aria-pressed={recording}
        onClick={recording ? stop : () => void start()}
        disabled={disabled || busy}
        className={`group relative grid h-11 w-11 place-items-center rounded-full border transition disabled:cursor-not-allowed disabled:opacity-40 ${
          recording
            ? 'border-ares-red bg-ares-red/20 text-ares-red shadow-hud-red'
            : error
              ? 'border-ares-amber/60 bg-ares-amber/10 text-ares-amber'
              : 'border-ares-cyan/50 bg-ares-cyan/10 text-ares-cyan shadow-hud-cyan hover:border-ares-cyan hover:bg-ares-cyan/20'
        }`}
      >
        <span className={`absolute inset-1 rounded-full border border-dashed ${recording ? 'animate-hud-spin-fast border-ares-red/60' : 'animate-hud-spin border-ares-cyan/30'}`} />
        {busy ? (
          <span className="h-3 w-3 animate-pulse rounded-full bg-current" />
        ) : (
          <svg viewBox="0 0 24 24" className="relative h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
            <rect x="8" y="3" width="8" height="12" rx="4" />
            <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M9 21h6" />
          </svg>
        )}
      </button>
      {recording && (
        <span className="absolute bottom-full right-0 mb-2 w-max border border-ares-red/40 bg-ares-bg px-2 py-1 font-mono text-[9px] uppercase tracking-wider text-ares-red">
          Listening...
        </span>
      )}
      {error && !recording && (
        <span className="absolute bottom-full right-0 mb-2 w-max max-w-44 border border-ares-amber/40 bg-ares-bg px-2 py-1 font-mono text-[9px] uppercase tracking-wider text-ares-amber">
          {error}
        </span>
      )}
    </div>
  );
}

function preferredMimeType(): string | undefined {
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
    .find((type) => MediaRecorder.isTypeSupported(type));
}
