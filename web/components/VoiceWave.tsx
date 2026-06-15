/**
 * Animated voice waveform — a row of bars that pulse while ARES is speaking and
 * fall flat when idle. Purely decorative HUD feedback for the streaming TTS, in
 * the J.A.R.V.I.S. voiceprint style.
 */
export function VoiceWave({
  active,
  bars = 11,
  className = '',
}: {
  active: boolean;
  bars?: number;
  className?: string;
}) {
  return (
    <div
      className={`voicewave ${active ? 'voicewave-active' : ''} ${className}`}
      role="img"
      aria-label={active ? 'ARES speaking' : 'Voice channel idle'}
    >
      {Array.from({ length: bars }).map((_, index) => (
        <span
          key={index}
          style={{
            animationDelay: `${(index % Math.ceil(bars / 2)) * 110}ms`,
            // A gentle bell (scaleY factor) so the centre bars peak taller than the edges.
            ['--peak' as string]: (0.5 + Math.sin((index / (bars - 1)) * Math.PI) * 0.5).toFixed(2),
          }}
        />
      ))}
    </div>
  );
}
