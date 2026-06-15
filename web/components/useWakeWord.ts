'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Always-on wake-word listening. While {@link UseWakeWordOptions.enabled} is true a
 * continuous {@link SpeechRecognition} session runs in the background; the moment it
 * hears the wake word "ARES" (alone or leading a sentence) it fires {@link
 * UseWakeWordOptions.onWake} for instant feedback, then hands back the command —
 * either the rest of the same sentence ("ARES, what's the weather") or the next
 * utterance after a bare "ARES".
 *
 * Tuned for responsive, far-field pickup:
 *   - interim results → it reacts the instant the word is recognized, not after the
 *     speaker goes silent;
 *   - multiple recognition alternatives are all scanned, so a mis-heard top guess
 *     ("eris", "aris") still triggers;
 *   - whole-word matching against a curated set of "ARES" homophones avoids firing
 *     on words that merely contain the letters (stares, compares…).
 *
 * It deliberately uses the browser's free, low-latency recognizer rather than the
 * server STT pipeline: wake detection runs constantly, and round-tripping every
 * ambient sound to Whisper/Gemini would be slow and wasteful.
 *
 * Only Chromium browsers (Chrome/Edge) expose SpeechRecognition; elsewhere {@link
 * UseWakeWord.supported} is false and the caller hides the toggle.
 */

export type WakeStatus = 'idle' | 'listening' | 'heard' | 'armed';

export interface UseWakeWordOptions {
  /** Master switch. When false the recognizer is fully torn down. */
  enabled: boolean;
  /** Called with the spoken command once the wake word (and its command) is heard. */
  onCommand: (text: string) => void;
  /** Fired the instant the wake word is detected, for an immediate confirmation cue. */
  onWake?: () => void;
  /**
   * Suspend capture without disabling — e.g. while ARES is streaming or speaking,
   * so the mic doesn't transcribe ARES's own voice and trigger itself.
   */
  paused?: boolean;
  /** BCP-47 language tag for the recognizer. */
  lang?: string;
  /** How long (ms) to wait for a command after a bare "ARES" before re-idling. */
  armWindowMs?: number;
  /**
   * Optional veto checked the instant a wake word is heard: when it returns false the
   * detection is dropped. Used for barge-in — while ARES is speaking, only honour "ARES"
   * if an echo-cancelled detector confirms a real human is talking, so ARES's own TTS
   * leaking into the (non-echo-cancelled) recognizer can't trigger itself.
   */
  gate?: () => boolean;
}

export interface UseWakeWord {
  /** Whether this browser exposes the Web Speech API at all. */
  supported: boolean;
  /** Current listening phase, for UI feedback. */
  status: WakeStatus;
  /** A fatal error (e.g. mic permission denied), if any. */
  error: string | null;
}

/** How many recognition alternatives to scan per result (higher = better recall). */
const MAX_ALTERNATIVES = 5;

/**
 * Curated homophones/mis-hearings of "ARES". Whole-word matched, so "stares" or
 * "compares" never trigger. Kept tight to balance far-field recall vs. false fires.
 */
const WAKE_WORDS = new Set([
  'ares', 'aress', 'aries', 'arie', 'aris', 'arris', 'arus', 'arius',
  'eris', 'arez', 'arees', 'ariz', 'aaris', 'areez', 'arese', 'aaron',
]);

function isWakeWord(word: string): boolean {
  if (WAKE_WORDS.has(word)) return true;
  // "ares", "ares!" → "ares", and slight tails like "aresss".
  return word.startsWith('ares') && word.length <= 7;
}

/** Strip to lower-case words. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * If a transcript contains the wake word, return the command following its *last*
 * occurrence ('' when "ARES" was spoken alone). Returns null when absent.
 */
function findWake(text: string): { command: string } | null {
  const words = normalize(text).split(' ').filter(Boolean);
  let at = -1;
  for (let i = 0; i < words.length; i += 1) {
    if (isWakeWord(words[i]!)) at = i;
  }
  if (at === -1) return null;
  return { command: words.slice(at + 1).join(' ').trim() };
}

export function useWakeWord(options: UseWakeWordOptions): UseWakeWord {
  const { enabled, onCommand, onWake, paused = false, lang = 'en-US', armWindowMs = 8000, gate } = options;

  const [supported, setSupported] = useState(false);
  const [status, setStatus] = useState<WakeStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  // Latest values, read inside long-lived recognizer callbacks without re-subscribing.
  const onCommandRef = useRef(onCommand);
  const onWakeRef = useRef(onWake);
  const pausedRef = useRef(paused);
  const gateRef = useRef(gate);
  const armedRef = useRef(false);
  const armTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  onCommandRef.current = onCommand;
  onWakeRef.current = onWake;
  pausedRef.current = paused;
  gateRef.current = gate;

  useEffect(() => {
    setSupported(typeof window !== 'undefined' && Boolean(window.SpeechRecognition || window.webkitSpeechRecognition));
  }, []);

  const disarm = useCallback(() => {
    armedRef.current = false;
    if (armTimerRef.current) {
      clearTimeout(armTimerRef.current);
      armTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!enabled || !supported) {
      setStatus('idle');
      return;
    }

    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) return;

    const recognition = new Recognition();
    recognition.lang = lang;
    recognition.continuous = true;
    recognition.interimResults = true; // react before the speaker falls silent
    recognition.maxAlternatives = MAX_ALTERNATIVES;

    let stopped = false; // set on cleanup so onend doesn't auto-restart
    let restartTimer: ReturnType<typeof setTimeout> | null = null;
    let triggered = false; // wake already confirmed for the in-progress utterance

    const fire = (command: string) => {
      disarm();
      triggered = false;
      setStatus('listening');
      onCommandRef.current(command);
    };

    const arm = () => {
      armedRef.current = true;
      setStatus('armed');
      if (armTimerRef.current) clearTimeout(armTimerRef.current);
      armTimerRef.current = setTimeout(() => {
        armedRef.current = false;
        armTimerRef.current = null;
        setStatus('listening');
      }, armWindowMs);
    };

    recognition.onstart = () => {
      if (!armedRef.current) setStatus('listening');
    };

    recognition.onresult = (event) => {
      // Ignore everything heard while suspended (e.g. push-to-talk owns the mic).
      if (pausedRef.current) return;
      // Barge-in veto: drop detections the gate rejects (e.g. ARES's own TTS while speaking).
      if (gateRef.current && !gateRef.current()) return;

      const result = event.results[event.results.length - 1];
      if (!result) return;
      const isFinal = result.isFinal;

      // All alternatives for this result — scanning them all boosts recall.
      const transcripts: string[] = [];
      for (let a = 0; a < result.length; a += 1) transcripts.push(result[a]?.transcript ?? '');

      // Waiting for the command after a bare "ARES".
      if (armedRef.current) {
        if (isFinal) {
          const command = normalize(transcripts[0] ?? '');
          if (command) fire(command); // else stay armed until the window elapses
        }
        return;
      }

      let wake: { command: string } | null = null;
      for (const t of transcripts) {
        wake = findWake(t);
        if (wake) break;
      }

      // Confirm the instant we hear it (interim), once per utterance.
      if (wake && !triggered) {
        triggered = true;
        setStatus('heard');
        onWakeRef.current?.();
      }

      if (isFinal) {
        if (wake) {
          if (wake.command) fire(wake.command); // "ARES, do the thing"
          else arm(); // bare "ARES" → listen for the next utterance
        }
        triggered = false; // ready for the next utterance
      }
    };

    recognition.onerror = (event) => {
      // Transient: no speech / aborted mid-stream / browser hiccup. onend restarts us.
      if (event.error === 'no-speech' || event.error === 'aborted' || event.error === 'network') return;
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        stopped = true;
        setError('Microphone access denied — wake word disabled.');
        setStatus('idle');
      }
    };

    recognition.onend = () => {
      // Chrome ends the session after silence; keep it alive while enabled.
      if (stopped) return;
      restartTimer = setTimeout(() => {
        try {
          recognition.start();
        } catch {
          // Already started or torn down — ignore.
        }
      }, 200);
    };

    try {
      recognition.start();
    } catch {
      // start() throws if a session is already live; onend will recover.
    }

    return () => {
      stopped = true;
      disarm();
      if (restartTimer) clearTimeout(restartTimer);
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      recognition.onstart = null;
      try {
        recognition.abort();
      } catch {
        // Ignore — already stopped.
      }
      setStatus('idle');
    };
  }, [enabled, supported, lang, armWindowMs, disarm]);

  // Clear the armed countdown if the master switch flips off.
  useEffect(() => {
    if (!enabled) disarm();
  }, [enabled, disarm]);

  return { supported, status, error };
}
