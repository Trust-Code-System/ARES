/**
 * Decorative HUD corner brackets that frame a relatively-positioned container,
 * the way targeting reticles bound a panel in the Stark interface. Pointer-events
 * are off so it never intercepts clicks.
 */
export function HudCorners({
  color = 'cyan',
  className = '',
}: {
  color?: 'cyan' | 'amber';
  className?: string;
}) {
  const stroke = color === 'amber' ? 'border-ares-amber/45' : 'border-ares-cyan/45';
  const glow = color === 'amber' ? 'shadow-[0_0_8px_rgba(255,159,28,0.35)]' : 'shadow-[0_0_8px_rgba(0,217,255,0.35)]';
  return (
    <div className={`pointer-events-none absolute inset-0 z-20 ${className}`} aria-hidden="true">
      <span className={`absolute left-1.5 top-1.5 h-4 w-4 border-l border-t ${stroke} ${glow}`} />
      <span className={`absolute right-1.5 top-1.5 h-4 w-4 border-r border-t ${stroke} ${glow}`} />
      <span className={`absolute bottom-1.5 left-1.5 h-4 w-4 border-b border-l ${stroke} ${glow}`} />
      <span className={`absolute bottom-1.5 right-1.5 h-4 w-4 border-b border-r ${stroke} ${glow}`} />
    </div>
  );
}
