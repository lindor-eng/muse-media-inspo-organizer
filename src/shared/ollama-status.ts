/** Why a start attempt for the bundled Ollama server failed. Shared by main (which produces
    it), preload (which types the bridge), and the renderer (which renders the message). */
export type OllamaStartFailure =
  | 'binary-missing'
  | 'not-executable'
  | 'spawn-failed'
  | 'timeout'
  | 'unknown';

export interface OllamaStartResult {
  running: boolean;
  reason?: OllamaStartFailure;
  /** Path, exit code, or stderr tail — diagnostic detail, not user-facing prose. */
  detail?: string;
}

/** User-facing explanation per failure. Each one names a concrete next step, because
    "it isn't running" left users with no way to tell a missing file from a blocked one. */
export const OLLAMA_FAILURE_MESSAGE: Record<OllamaStartFailure, string> = {
  'binary-missing':
    "The local AI engine is missing from this copy of Muse. Reinstall using the .pkg installer to restore it.",
  'not-executable':
    "macOS blocked the local AI engine from running. Muse just tried to unblock it — use Try again. If it keeps failing, run `xattr -cr /Applications/Muse.app` in Terminal.",
  'spawn-failed':
    "The local AI engine failed to start. Reinstalling with the .pkg installer usually fixes this.",
  timeout:
    "The local AI engine is taking longer than expected to start. Give it a moment and try again.",
  unknown: "The local AI engine couldn't be started.",
};
