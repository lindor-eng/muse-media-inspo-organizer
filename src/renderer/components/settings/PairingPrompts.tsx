import { Check, Loader2 } from 'lucide-react';
import { api } from '../../lib/ipc';
import { formatCode, useSyncState } from './useSyncState';

function Sheet({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-[90] bg-black/55 backdrop-blur-sm flex items-center justify-center">
      <div role="dialog" aria-label={label} className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-[460px] max-w-[92vw] p-7 flex flex-col gap-4">
        {children}
      </div>
    </div>
  );
}

function Code({ code }: { code: string | null }) {
  return (
    <div className="text-[40px] font-semibold tracking-[0.12em] text-gray-50 tabular-nums text-center py-3 bg-gray-950/50 border border-gray-800 rounded-lg">
      {formatCode(code)}
    </div>
  );
}

const secondary = 'px-4 py-2 text-sm text-gray-200 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-md transition-colors';
const primary = 'px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-500 rounded-md transition-colors';

/**
 * Pairing, on both Macs. Mounted at the top of the app rather than inside Settings: the Mac
 * being asked shows its prompt over whatever is open, since someone is waiting at the other Mac.
 */
export function PairingPrompts() {
  const { outgoingPair: out, incomingPair: inc } = useSyncState();

  if (inc) {
    return (
      <Sheet label="Pairing request">
        <h2 className="text-[17px] font-semibold text-gray-100">{inc.name} wants to sync with this library</h2>
        {inc.phase === 'ask' ? (
          <>
            <p className="text-sm text-gray-400 leading-relaxed">Only allow it if {inc.name} shows the same code.</p>
            <Code code={inc.code} />
            <p className="text-xs text-gray-400 leading-relaxed">
              The two libraries are merged, and changes either Mac makes show up on the other while both are on this Wi-Fi.
            </p>
            <div className="flex justify-end gap-2.5">
              <button type="button" className={secondary} onClick={() => void api.respondToPair(inc.session, false)}>
                Don&apos;t Allow
              </button>
              <button type="button" className={primary} onClick={() => void api.respondToPair(inc.session, true)}>
                Allow
              </button>
            </div>
          </>
        ) : (
          <>
            <Code code={inc.code} />
            <p className="text-sm text-gray-400 flex items-center gap-2">
              <Loader2 size={14} className="animate-spin" />
              Waiting for Codes Match on {inc.name}…
            </p>
          </>
        )}
      </Sheet>
    );
  }

  if (!out) return null;

  return (
    <Sheet label={`Pair with ${out.name}`}>
      <h2 className="text-[17px] font-semibold text-gray-100">
        {out.phase === 'failed' ? `Couldn't pair with ${out.name}` : out.phase === 'done' ? `Paired with ${out.name}` : `Pair with ${out.name}`}
      </h2>

      {out.phase === 'connecting' && (
        <p className="text-sm text-gray-400 flex items-center gap-2">
          <Loader2 size={14} className="animate-spin" />
          Connecting…
        </p>
      )}

      {(out.phase === 'confirm' || out.phase === 'waiting') && (
        <>
          <p className="text-sm text-gray-400 leading-relaxed">
            Check that {out.name} is showing this code, then click Codes Match here and Allow there.
          </p>
          <Code code={out.code} />
          <p className="text-xs text-amber-300/90 leading-relaxed">
            The two libraries are merged: everything on either Mac ends up on both.
          </p>
        </>
      )}

      {out.phase === 'waiting' && (
        <p className="text-sm text-gray-400 flex items-center gap-2">
          <Loader2 size={14} className="animate-spin" />
          Waiting for Allow on {out.name}…
        </p>
      )}

      {out.phase === 'done' && (
        <p className="text-sm text-green-300 flex items-center gap-2">
          <Check size={15} />
          Syncing now.
        </p>
      )}

      {out.phase === 'failed' && <p className="text-sm text-gray-400 leading-relaxed">{out.error ?? 'Something went wrong.'}</p>}

      <div className="flex justify-end gap-2.5">
        {out.phase === 'failed' || out.phase === 'done' ? (
          <button type="button" className={secondary} onClick={() => void api.cancelPair()}>
            OK
          </button>
        ) : (
          <>
            <button type="button" className={secondary} onClick={() => void api.cancelPair()}>
              Cancel
            </button>
            {out.phase === 'confirm' && (
              <button type="button" className={primary} onClick={() => void api.confirmPair()}>
                Codes Match
              </button>
            )}
          </>
        )}
      </div>
    </Sheet>
  );
}
