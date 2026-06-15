'use client';

import { useEffect, useRef, useState, type MutableRefObject } from 'react';

/**
 * Single shared microphone tap, sampled from the *real* mic via the Web Audio API, that
 * serves two consumers from one {@link MediaStream}:
 *
 *   1. a live input **level** (for the on-screen meter), and
 *   2. **voice-activity detection** (VAD) for barge-in — "is a human talking right now?"
 *
 * The stream is opened with echo cancellation, so ARES's own TTS playing through the
 * speakers is largely removed before it reaches the analyser. That is what makes the VAD
 * meaningful while ARES is speaking: residual energy in this stream means *you*, not ARES.
 * Wake-word detection (which uses the browser's {@link SpeechRecognition}, with no echo
 * cancellation) can't tell the difference on its own — so the caller AND-gates the two:
 * a barge-in only counts when SpeechRecognition hears "ARES" *and* this VAD agrees a
 * person is speaking.
 *
 * Neither output uses React state in its hot path: the per-frame loop writes only to
 * {@link UseMicAudio.levelRef} and {@link UseMicAudio.userSpeakingRef}. The meter reads
 * the level ref on its own throttled animation frame, so high-frequency updates never
 * re-render the page. The stream is fully released the instant `enabled` goes false.
 */

export interface UseMicAudio {
  /** getUserMedia + AudioContext are both available in this browser. */
  supported: boolean;
  /** A mic stream is open and metering. */
  active: boolean;
  /** Permission or device failure, if any. */
  error: string | null;
  /** Smoothed input amplitude, 0..1. Read inside an animation frame — never triggers a render. */
  levelRef: MutableRefObject<number>;
  /** True while a human (echo-cancelled) is speaking — for barge-in gating. */
  userSpeakingRef: MutableRefObject<boolean>;
}

/** Maps quiet-speech RMS into a visible portion of the meter. */
const GAIN = 3.6;
/** Asymmetric smoothing: snap up fast, fall back slowly so peaks stay readable. */
const ATTACK = 0.6;
const RELEASE = 0.16;

// Voice-activity detection (on the echo-cancelled stream → the user, not ARES).
// Thresholds are *relative to a continuously measured noise floor* rather than
// fixed, so a steady fan/AC hum is learned as "silence" and your voice — which
// rises well above it — still registers no matter how loud the room is.
/** Speech starts when RMS exceeds noiseFloor × this. */
const VAD_ON_RATIO = 3.0;
/** Speech can end below noiseFloor × this (hysteresis avoids threshold chatter). */
const VAD_OFF_RATIO = 1.9;
/** Absolute minimum so a dead-silent room can't trigger on its own noise floor. */
const VAD_ABS_MIN = 0.02;
/** Initial/quiet-room floor estimate before the room is measured. */
const FLOOR_INIT = 0.012;
/** How fast the noise floor tracks ambient changes while no one is speaking. */
const FLOOR_ADAPT = 0.05;
/** Consecutive loud frames required before latching on (rejects clicks/pops). */
const VAD_ONSET_FRAMES = 3;
/** Keep "speaking" latched this long through brief inter-word gaps. */
const VAD_HANGOVER_MS = 350;

type WebkitWindow = typeof window & { webkitAudioContext?: typeof AudioContext };

export function useMicAudio(enabled: boolean): UseMicAudio {
  const [supported, setSupported] = useState(false);
  const [active, setActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const levelRef = useRef(0);
  const userSpeakingRef = useRef(false);

  useEffect(() => {
    setSupported(
      typeof navigator !== 'undefined' &&
        Boolean(navigator.mediaDevices?.getUserMedia) &&
        typeof window !== 'undefined' &&
        Boolean(window.AudioContext || (window as WebkitWindow).webkitAudioContext),
    );
  }, []);

  useEffect(() => {
    if (!enabled || !supported) {
      setActive(false);
      levelRef.current = 0;
      userSpeakingRef.current = false;
      return;
    }

    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let raf = 0;
    let cancelled = false;
    let smoothed = 0;
    let onsetCount = 0;
    let lastLoud = 0;
    let noiseFloor = FLOOR_INIT;

    const start = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        const Ctx = window.AudioContext || (window as WebkitWindow).webkitAudioContext!;
        ctx = new Ctx();
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.6;
        source.connect(analyser);
        const data = new Uint8Array(analyser.fftSize);
        setError(null);
        setActive(true);

        const tick = (now: number) => {
          analyser.getByteTimeDomainData(data);
          let sum = 0;
          for (let i = 0; i < data.length; i += 1) {
            const v = (data[i]! - 128) / 128; // centre on zero, normalise to [-1, 1]
            sum += v * v;
          }
          const rms = Math.sqrt(sum / data.length);

          // Thresholds float above the learned noise floor (fan-robust).
          const onThreshold = Math.max(noiseFloor * VAD_ON_RATIO, VAD_ABS_MIN);
          const offThreshold = Math.max(noiseFloor * VAD_OFF_RATIO, VAD_ABS_MIN * 0.6);

          // Display level — measured above the floor so a fan doesn't peg the meter.
          const norm = Math.min(1, Math.max(0, rms - noiseFloor) * GAIN);
          smoothed += (norm - smoothed) * (norm > smoothed ? ATTACK : RELEASE);
          levelRef.current = smoothed;

          // Voice activity — onset count to latch on, hangover to ride out gaps.
          if (rms >= onThreshold) {
            onsetCount += 1;
            if (onsetCount >= VAD_ONSET_FRAMES) {
              userSpeakingRef.current = true;
              lastLoud = now;
            }
          } else {
            onsetCount = 0;
            // Track the ambient floor only while it's quiet, so speech never raises it.
            noiseFloor += (rms - noiseFloor) * FLOOR_ADAPT;
            if (rms < offThreshold && now - lastLoud > VAD_HANGOVER_MS) {
              userSpeakingRef.current = false;
            }
          }

          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      } catch (err) {
        if (cancelled) return;
        const name = (err as DOMException)?.name;
        setError(name === 'NotAllowedError' || name === 'SecurityError' ? 'Mic denied' : 'No mic');
        setActive(false);
      }
    };

    void start();

    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
      stream?.getTracks().forEach((track) => track.stop());
      if (ctx && ctx.state !== 'closed') void ctx.close();
      setActive(false);
      levelRef.current = 0;
      userSpeakingRef.current = false;
    };
  }, [enabled, supported]);

  return { supported, active, error, levelRef, userSpeakingRef };
}
