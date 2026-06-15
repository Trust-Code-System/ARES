interface OperationalStoryProps {
  factCount: number;
  toolCount: number;
  jobCount: number;
  taskCount: number;
}

export function OperationalStory({ factCount, toolCount, jobCount, taskCount }: OperationalStoryProps) {
  const chapters = [
    {
      index: '01',
      eyebrow: 'Observe',
      title: 'The world becomes signal.',
      body: 'Market movement, system health, time, memory, and incoming requests converge into one intelligence surface.',
      metric: `${factCount} memory facts`,
    },
    {
      index: '02',
      eyebrow: 'Reason',
      title: 'Signal becomes context.',
      body: 'ARES connects present telemetry with stored knowledge and available capabilities before proposing action.',
      metric: `${toolCount} active tools`,
    },
    {
      index: '03',
      eyebrow: 'Execute',
      title: 'Context becomes controlled action.',
      body: 'Scheduled operations and principal-approved tasks move forward while safety gates remain visible at every step.',
      metric: `${jobCount} cycles / ${taskCount} tasks`,
    },
  ];

  return (
    <section className="story-section" aria-labelledby="operational-story-title">
      <div className="story-section__intro scroll-reveal">
        <div className="hud-label text-ares-amber">Operational narrative</div>
        <h2 id="operational-story-title" className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-white sm:text-4xl">
          Intelligence has a sequence.
        </h2>
        <p className="mt-3 max-w-2xl text-sm leading-7 text-slate-400">
          The dashboard is not a collection of panels. It is the visible path from awareness to accountable execution.
        </p>
      </div>

      <div className="story-rail">
        {chapters.map((chapter) => (
          <article key={chapter.index} className="story-chapter scroll-reveal">
            <div className="story-chapter__number">{chapter.index}</div>
            <div className="hud-label">{chapter.eyebrow}</div>
            <h3 className="mt-3 text-xl font-semibold text-slate-100">{chapter.title}</h3>
            <p className="mt-3 text-sm leading-6 text-slate-400">{chapter.body}</p>
            <div className="mt-5 border-t border-ares-line/70 pt-3 font-mono text-[9px] uppercase tracking-[0.16em] text-ares-cyan">
              {chapter.metric}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
