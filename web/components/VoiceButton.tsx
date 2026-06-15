'use client';

import { useEffect, useRef, useState } from 'react';
import { api, UnauthorizedError } from '@/lib/api';

/**
 * Push-to-talk mic button. Records audio in the browser, posts it to the ARES API
 * `/api/voice/transcribe` endpoint, and hands the transcript back to the chat.
 */
export function VoiceButton({
  onTranscript,
  onBeforeRecord,
  disabled,
}: {
  onTranscript: (text: string) => void;
  onBeforeRecord?: () => void;
  disabled?: boolean;
}) {
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  useEffect(() => () => {
    const recorder = recorderRef.current;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      if (recorder.state !== 'inactive') recorder.stop();
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  async function start() {
    let stream: MediaStream | null = null;
    try {
      setError(null);
      onBeforeRecord?.();
      const acquiredStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream = acquiredStream;
      streamRef.current = acquiredStream;
      const recorder = new MediaRecorder(acquiredStream);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => chunksRef.current.push(event.data);
      recorder.onstop = () => void transcribe(new Blob(chunksRef.current, { type: 'audio/webm' }), acquiredStream);
      recorder.start();
      recorderRef.current = recorder;
      setRecording(true);
    } catch {
      stream?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setError('Microphone access denied');
    }
  }

  function stop() {
    recorderRef.current?.stop();
    setRecording(false);
  }

  async function transcribe(blob: Blob, stream: MediaStream) {
    setBusy(true);
    try {
      const text = await api.transcribe(blob, 'audio/webm');
      if (text) onTranscript(text);
    } catch (caught) {
      if (caught instanceof UnauthorizedError) setError('Session expired');
      else setError('Transcription failed');
    } finally {
      setBusy(false);
      stream.getTracks().forEach((track) => track.stop());
      if (streamRef.current === stream) streamRef.current = null;
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        title={error ?? (recording ? 'Stop recording' : 'Push to talk')}
        aria-label={recording ? 'Stop voice recording' : 'Start voice recording'}
        aria-pressed={recording}
        onClick={recording ? stop : start}
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
      {error && (
        <span className="absolute bottom-full right-0 mb-2 w-max max-w-44 border border-ares-amber/40 bg-ares-bg px-2 py-1 font-mono text-[9px] uppercase tracking-wider text-ares-amber">
          {error}
        </span>
      )}
    </div>
  );
}
