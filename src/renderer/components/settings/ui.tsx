/** Pieces every Settings section is built from, so they look like one window. */

export function Switch({ id, on, onChange, disabled }: { id: string; on: boolean; onChange: (on: boolean) => void; disabled?: boolean }) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative w-[38px] h-[22px] rounded-full shrink-0 transition-colors disabled:opacity-50 ${on ? 'bg-blue-500' : 'bg-gray-700'}`}
    >
      <span className={`absolute top-[2px] w-[18px] h-[18px] rounded-full transition-all ${on ? 'left-[18px] bg-white' : 'left-[2px] bg-gray-300'}`} />
    </button>
  );
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">{children}</h3>;
}

export function Page({ title, intro, action, children }: { title: string; intro?: React.ReactNode; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="px-8 py-6 flex flex-col gap-5 min-h-full">
      <header className="flex items-start gap-4 pr-8">
        <div className="flex-1 flex flex-col gap-1">
          <h2 className="text-lg font-semibold text-gray-100">{title}</h2>
          {intro && <p className="text-sm text-gray-400 max-w-[480px] leading-snug">{intro}</p>}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

/** A bordered group of rows. */
export function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`bg-gray-950/40 border border-gray-800 rounded-lg flex flex-col divide-y divide-gray-800 ${className}`}>{children}</div>;
}

/** One line of a card: a label (with an optional note under it) and a control on the right. */
export function Row({ label, note, htmlFor, children }: { label: React.ReactNode; note?: React.ReactNode; htmlFor?: string; children?: React.ReactNode }) {
  const text = (
    <>
      <span className="text-sm font-medium text-gray-100">{label}</span>
      {note && <span className="text-xs text-gray-500 leading-relaxed">{note}</span>}
    </>
  );
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      {htmlFor ? (
        <label htmlFor={htmlFor} className="flex-1 min-w-0 flex flex-col gap-0.5 cursor-pointer">{text}</label>
      ) : (
        <div className="flex-1 min-w-0 flex flex-col gap-0.5">{text}</div>
      )}
      {children}
    </div>
  );
}

export const buttonSecondary =
  'shrink-0 px-3 py-1.5 text-xs font-medium text-gray-200 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-md transition-colors disabled:opacity-50';
export const buttonPrimary =
  'shrink-0 px-3.5 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-md transition-colors';
export const selectClass =
  'bg-gray-900 border border-gray-700 rounded-md text-gray-200 px-2 py-1.5 text-xs focus:outline-none focus:border-blue-500';

export function StatusDot({ tone, children }: { tone: 'good' | 'off' | 'warn'; children: React.ReactNode }) {
  const color = tone === 'good' ? 'text-green-300' : tone === 'warn' ? 'text-amber-300' : 'text-gray-400';
  const dot = tone === 'good' ? 'bg-green-500' : tone === 'warn' ? 'bg-amber-400' : 'bg-gray-600';
  return (
    <span className={`text-xs flex items-center gap-1.5 ${color}`}>
      <span className={`w-[7px] h-[7px] rounded-full shrink-0 ${dot}`} />
      {children}
    </span>
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
