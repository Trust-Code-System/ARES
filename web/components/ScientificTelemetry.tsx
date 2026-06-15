interface ScientificTelemetryProps {
  connected: boolean;
  active: boolean;
  speaking: boolean;
  latencyMs: number | null;
  toolCount: number;
}

export function ScientificTelemetry({
  connected,
  active,
  speaking,
  latencyMs,
  toolCount,
}: ScientificTelemetryProps) {
  const latency = latencyMs ?? 0;
  const coherence = connected ? Math.max(91.2, 99.4 - latency / 180) : 8.4;
  const phase = connected ? (latency * 0.37 + toolCount * 7.2) % 360 : 0;
  const signal = connected ? Math.max(-58, -36 - latency / 85) : -96;
  const entropy = active ? 0.042 : speaking ? 0.031 : 0.018;
  const circumference = 2 * Math.PI * 24;
  const coherenceOffset = circumference * (1 - coherence / 100);

  return (
    <div className={`scientific-telemetry ${active ? 'scientific-telemetry--active' : ''}`} aria-hidden="true">
      <div className="scientific-equation">
        <span>Ψ(t) = Σ cₙe<sup>−iEₙt/ℏ</sup>|n⟩</span>
        <i />
        <span>ΔS = {entropy.toFixed(3)}</span>
      </div>

      <div className="scientific-reticle">
        <span className="scientific-reticle__axis scientific-reticle__axis--x" />
        <span className="scientific-reticle__axis scientific-reticle__axis--y" />
        <span className="scientific-reticle__tick scientific-reticle__tick--a" />
        <span className="scientific-reticle__tick scientific-reticle__tick--b" />
        <span className="scientific-reticle__tick scientific-reticle__tick--c" />
      </div>

      <section className="scientific-module scientific-module--spectrum">
        <header>
          <span>Spectral density</span>
          <b>{active ? 'Sampling' : 'Stable'}</b>
        </header>
        <svg viewBox="0 0 180 42" preserveAspectRatio="none">
          <path className="scientific-grid-line" d="M0 10.5H180 M0 21H180 M0 31.5H180 M45 0V42 M90 0V42 M135 0V42" />
          <path
            className="scientific-wave"
            d="M0 28 L8 27 L14 30 L20 18 L26 25 L33 23 L40 9 L47 31 L53 24 L61 26 L68 14 L76 25 L83 22 L90 7 L96 29 L103 24 L111 27 L119 15 L126 22 L134 20 L142 10 L150 28 L158 23 L166 25 L174 17 L180 20"
          />
          <circle className="scientific-wave-dot" cx="142" cy="10" r="2" />
        </svg>
        <footer>
          <span>ν 4.72 THz</span>
          <span>SNR {Math.max(0, 72 + signal).toFixed(1)} dB</span>
        </footer>
      </section>

      <section className="scientific-module scientific-module--coherence">
        <div className="scientific-gauge">
          <svg viewBox="0 0 58 58">
            <circle className="scientific-gauge__track" cx="29" cy="29" r="24" />
            <circle
              className="scientific-gauge__value"
              cx="29"
              cy="29"
              r="24"
              style={{
                strokeDasharray: circumference,
                strokeDashoffset: coherenceOffset,
              }}
            />
            <path className="scientific-gauge__cross" d="M29 10V48 M10 29H48" />
          </svg>
          <strong>{coherence.toFixed(1)}</strong>
        </div>
        <div className="scientific-readout">
          <span>Coherence</span>
          <b>{connected ? 'Phase locked' : 'No carrier'}</b>
          <dl>
            <div><dt>φ</dt><dd>{phase.toFixed(1)}°</dd></div>
            <div><dt>σ</dt><dd>{signal.toFixed(1)} dBm</dd></div>
            <div><dt>μ</dt><dd>{toolCount.toString().padStart(2, '0')} nodes</dd></div>
          </dl>
        </div>
      </section>

      <div className="scientific-calibration">
        <span>CAL 7.83 Hz</span>
        <i />
        <span>{speaking ? 'Acoustic carrier engaged' : 'Vacuum baseline nominal'}</span>
      </div>
    </div>
  );
}
