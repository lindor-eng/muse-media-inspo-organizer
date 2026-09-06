/**
 * Condenses a GitHub release body into something a user can read at a glance.
 *
 * Muse's release notes are written for the Releases page — several paragraphs of prose, an install
 * section, a macOS troubleshooting note. That's the wrong shape for a modal someone hit on launch
 * while trying to do something else, so we pull out only the headlines: each point's bold lead
 * ("**GPU acceleration works.** The engine was missing…" -> "GPU acceleration works"), capped at a
 * handful of one-line items. The full body is still one click away in the dialog.
 */

/** Longest a highlight may run before it's clipped — roughly one line in the modal. */
const MAX_ITEM_CHARS = 72;
/** Warnings get a little more room; they're the one thing worth reading in full. */
const MAX_WARNING_CHARS = 110;
/** More than this and the list stops being scannable. */
const MAX_ITEMS = 5;

/** Trailing sections that are about *getting* the release, not what changed in it. */
const BOILERPLATE =
  /^(install\b|to install\b|download\b|requires\b|full changelog\b|sha-?256|checksum|built from\b)/i;

/** Callout blocks that need to survive the trim — a manual-install release, a breaking change. */
const WARNING_LEAD = /^(warning|important|heads?[- ]up|read this|breaking|action required)\b/i;
const WARNING_MARK = /[⚠❗‼🚨]/u;

export interface ReleaseHighlights {
  /** A callout that shouldn't be summarized away (manual install required, breaking change…). */
  warning: string | null;
  /** One-line highlights, in the order the notes present them. */
  items: string[];
  /** Points that didn't fit in `items` — surfaced as "+N more". */
  more: number;
}

/** Flatten inline markdown to plain text. Structure is handled by the caller. */
function stripInline(md: string): string {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(?<![*\w])\*([^*]+)\*(?!\w)/g, '$1')
    .replace(/(?<![_\w])_([^_]+)_(?!\w)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Drop the decorative lead-in some headings carry ("⚠️ This update must…"). */
function stripLeadMarks(text: string): string {
  return text.replace(/^[\s\p{Extended_Pictographic}️:—–-]+/u, '').trim();
}

function clamp(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  const kept = space > max * 0.6 ? cut.slice(0, space) : cut;
  return `${kept.replace(/[\s,;:.—–-]+$/, '')}…`;
}

function firstSentence(text: string): string {
  return text.match(/^(.+?[.!?])(?:\s|$)/)?.[1] ?? text;
}

/**
 * Reduce one paragraph or bullet to its headline. A leading bold run is the author's own summary of
 * the point, so it wins; otherwise we take the first sentence. The trailing period goes — these read
 * as labels in the list, not sentences.
 */
function headline(raw: string): string {
  const bold = raw.match(/^\s*\*\*(.+?)\*\*/);
  const text = stripInline(bold ? bold[1] : firstSentence(raw));
  // A trailing aside ("…password (the app is unsigned, so macOS asks)") is the first thing to go —
  // it's what pushes an otherwise fine headline past the clip.
  return stripLeadMarks(text).replace(/\s*\.$/, '').replace(/\s*\([^()]*\)$/, '');
}

interface Candidate {
  text: string;
  /** True when the author bolded a lead — a deliberate headline, not just the first sentence. */
  emphasized: boolean;
}

export function summarizeReleaseNotes(notes: string): ReleaseHighlights {
  const empty: ReleaseHighlights = { warning: null, items: [], more: 0 };
  if (!notes?.trim()) return empty;

  const candidates: Candidate[] = [];
  let warning: string | null = null;

  for (const block of notes.replace(/\r\n/g, '\n').split(/\n{2,}/)) {
    for (const chunk of splitBlock(block)) {
      const raw = chunk.trim();
      if (!raw || /^-{3,}$/.test(raw)) continue;

      const heading = raw.match(/^#{1,6}\s+(.*)$/);
      const body = heading ? heading[1] : raw;
      const plain = stripInline(body);
      if (!plain || BOILERPLATE.test(plain)) continue;

      const isWarning = WARNING_MARK.test(plain) || WARNING_LEAD.test(stripLeadMarks(plain));
      if (isWarning) {
        warning ??= clamp(stripLeadMarks(stripInline(firstSentence(body))), MAX_WARNING_CHARS);
        continue;
      }

      // Section labels ("What's fixed") organize the page but say nothing on their own.
      if (heading) continue;

      const text = clamp(headline(body), MAX_ITEM_CHARS);
      if (text) candidates.push({ text, emphasized: /^\s*\*\*/.test(body) });
    }
  }

  // When the author bolded their headlines, the unbolded paragraphs are supporting detail — drop
  // them. Notes that bold nothing (or almost nothing) keep every point instead of showing one line.
  const emphasized = candidates.filter((c) => c.emphasized);
  const chosen = emphasized.length >= 2 ? emphasized : candidates;

  const seen = new Set<string>();
  const items: string[] = [];
  for (const { text } of chosen) {
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(text);
  }

  return {
    warning,
    items: items.slice(0, MAX_ITEMS),
    more: Math.max(0, items.length - MAX_ITEMS),
  };
}

/** A block may hold several bullets; each is its own point. Prose blocks pass through whole. */
function splitBlock(block: string): string[] {
  const lines = block.split('\n');
  if (!lines.some((l) => /^\s*[-*]\s+/.test(l))) return [block];
  return lines.map((l) => l.replace(/^\s*[-*]\s+/, ''));
}
