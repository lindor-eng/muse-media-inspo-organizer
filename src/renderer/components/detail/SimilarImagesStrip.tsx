import { useRef } from 'react';
import { ArrowLeft, ChevronDown, Filter, Settings } from 'lucide-react';
import {
  displayLikenessPercent,
  likenessDisplayPercentRounded,
  MATCH_STRENGTH_TO_MIN_COSINE,
  type MatchStrengthTier,
} from '../../../shared/visual-similarity';
import { REFINE_MODE_HELP, SIMILAR_REFINE_MODES } from '../../../shared/similar-refine';
import type {
  ImageRecord,
  SimilarImageEntry,
  SimilarImagesEmptyHint,
  SimilarMatchesMeta,
  SimilarityPrefs,
  SimilarRefineMode,
} from '../../stores/app-store';

/** Compact strip chip labels */
const REFINE_STRIP_LABEL: Record<SimilarRefineMode, string> = {
  colors: 'Colors',
  layout: 'Layout',
  format: 'Format',
};

interface Props {
  title?: string;
  entries: SimilarImageEntry[];
  loading: boolean;
  currentImageId: string;
  emptyHint?: SimilarImagesEmptyHint | null;
  onPick: (imageId: string, originRect?: { x: number; y: number; width: number; height: number } | null) => void;
  size?: 'sm' | 'md';
  similarFetchEmbedBaseline: boolean | null;
  similarMatchesMeta: SimilarMatchesMeta | null;
  clipSidecarRunning?: boolean | null;
  showInspectorGear?: boolean;
  inspectorSettingsOpen?: boolean;
  inspectorSettingsPopover?: React.ReactNode;
  onInspectorGearClick?: () => void;
  /** Immediately previous neighbor when chaining through the strip */
  similarNavBackThumb?: ImageRecord | null;
  onSimilarNavBack?: () => void;
  /** Saved lens — drives badge math immediately when changed via dropdown */
  similarityPreset?: SimilarityPrefs | null;
  /** Persist lens selection (immediate save + refetch similarities) */
  onSimilarityLensChange?: (next: Partial<SimilarityPrefs>) => Promise<void>;
  /** Similar-strip radio refinement (session-local); null = likeness-only baseline */
  similarRefineMode?: SimilarRefineMode | null;
  onSimilarRefineModeChange?: (mode: SimilarRefineMode | null) => void;
}

function loadingLine(
  loading: boolean,
  baselineKnown: boolean,
  baseline: boolean | null,
): string | null {
  if (!loading) return null;
  if (!baselineKnown) return 'Checking index…';
  if (baseline === false) return 'Building CLIP embedding, then comparing…';
  return 'Comparing embeddings in your library…';
}

interface ThumbProps {
  image: SimilarImageEntry['image'];
  similarity: number;
  thumbClass: string;
  /** When user has a likeness lens, % is residual above cutoff; otherwise raw library scale */
  badgeFloorCosine: number | null;
  onPick: Props['onPick'];
  /** Refinement reorder can diverge from raw likeness rank — overlay would mislead */
  showLikenessOverlay?: boolean;
}

function SimilarThumbnailButton({
  image,
  similarity,
  thumbClass,
  badgeFloorCosine,
  onPick,
  showLikenessOverlay = true,
}: ThumbProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const src = image.thumbnail_path
    ? `local-file://${image.thumbnail_path}`
    : `local-file://${image.original_path}`;
  const pct = displayLikenessPercent(similarity, badgeFloorCosine);
  const explain =
    badgeFloorCosine === null
      ? 'Library-scale likeness (OpenCLIP dot on thumbnails)'
      : `Headroom above your lens baseline (0% at cutoff, 100% at perfect match)`;
  const title = showLikenessOverlay
    ? `${image.title || image.filename} · ${pct} — ${explain}`
    : `${image.title || image.filename} · Likeness ${pct} (${explain}) — ordering follows the active filter, not left-to-right.`;
  return (
    <button
      ref={ref}
      type="button"
      onClick={() => {
        const r = ref.current?.getBoundingClientRect();
        onPick(image.id, r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null);
      }}
      className={`group relative ${thumbClass} shrink-0 rounded-md overflow-hidden border border-gray-800 hover:border-gray-600 bg-gray-800 transition-colors`}
      title={title}
    >
      <img src={src} alt="" className="h-full w-full object-cover pointer-events-none" draggable={false} />
      {showLikenessOverlay ? (
        <span className="absolute bottom-1 right-1 px-1 py-0 rounded bg-black/60 text-[10px] text-gray-300 tabular-nums leading-none">
          {pct}
        </span>
      ) : null}
    </button>
  );
}

interface BackThumbProps {
  image: ImageRecord;
  thumbClass: string;
  onBack: () => void;
  size?: 'sm' | 'md';
}

function PreviousSimilarThumb({ image, thumbClass, onBack, size = 'sm' }: BackThumbProps) {
  const src = image.thumbnail_path
    ? `local-file://${image.thumbnail_path}`
    : `local-file://${image.original_path}`;
  const label = `Back to ${image.title || image.filename}`;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onBack}
      className={`group relative ${thumbClass} shrink-0 rounded-md overflow-hidden border border-gray-700 bg-gray-800/70 hover:border-blue-700/70 transition-colors`}
    >
      <img
        src={src}
        alt=""
        className="h-full w-full object-cover pointer-events-none opacity-45 group-hover:opacity-55 transition-opacity"
        draggable={false}
      />
      <span className="absolute inset-0 flex items-center justify-center bg-black/35 group-hover:bg-black/25 transition-colors pointer-events-none">
        <ArrowLeft
          className={`${size === 'md' ? 'w-8 h-8' : 'w-6 h-6'} text-white/90 drop-shadow-md`}
          strokeWidth={1.5}
          aria-hidden
        />
      </span>
    </button>
  );
}

function emptyStateMessage(hint: SimilarImagesEmptyHint | null | undefined): string {
  if (hint === 'python_venv_missing') {
    return 'CLIP is not set up: create python/.venv in this project and run pip install -r python/requirements.txt (see README), then restart Muse.';
  }
  if (hint === 'clip_embed_failed') {
    return 'Could not compute an embedding for this image. Confirm the Python sidecar runs (Terminal: python/.venv/bin/python3 python/embed_server.py) and check the main process console.';
  }
  if (hint === 'needs_other_indexed_images') {
    return 'You need at least two indexed images for matches (Trash excluded). Import another reference — embeddings queue after import — wait a short moment, then re-open this file or browse away and back.';
  }
  if (hint === 'similarity_below_threshold') {
    return 'Nothing met your likeness cutoff — widen the lens menu (toward Narrow, Close, or Wide), bump Max suggestions in settings, or clear strip filters.';
  }
  return 'No close visual neighbors for this thumbnail embedding. Imports still indexing show up after a moment.';
}

function clipBadge(sidecarRunning: boolean | undefined | null): string {
  if (sidecarRunning === null || sidecarRunning === undefined) return 'CLIP …';
  return sidecarRunning ? 'CLIP process on' : 'CLIP Idle';
}

export function SimilarImagesStrip({
  title = 'Similar Images',
  entries,
  loading,
  currentImageId,
  emptyHint,
  onPick,
  size = 'sm',
  similarFetchEmbedBaseline,
  similarMatchesMeta: _similarMatchesMeta,
  clipSidecarRunning,
  showInspectorGear,
  inspectorSettingsOpen,
  inspectorSettingsPopover,
  onInspectorGearClick,
  similarNavBackThumb,
  onSimilarNavBack,
  similarityPreset,
  onSimilarityLensChange,
  similarRefineMode = null,
  onSimilarRefineModeChange,
}: Props) {
  const thumbClass = size === 'md' ? 'h-[88px] w-[88px]' : 'h-14 w-14';
  const badgeFloorCosine =
    similarityPreset != null && similarityPreset.similarityFloor != null
      ? MATCH_STRENGTH_TO_MIN_COSINE[similarityPreset.similarityFloor]
      : null;
  const shown = entries.filter((e) => {
    if (e.image.id === currentImageId) return false;
    return likenessDisplayPercentRounded(e.similarity, badgeFloorCosine) > 0;
  });
  const skeletonCount = size === 'md' ? 8 : 5;

  const baselineKnown = loading ? similarFetchEmbedBaseline !== null : false;
  const loadMsg =
    loading && shown.length === 0 ? loadingLine(true, baselineKnown, similarFetchEmbedBaseline) : null;

  const carouselRowBusy = loading || shown.length > 0;
  const showBackRail = !!similarNavBackThumb && carouselRowBusy && onSimilarNavBack;

  const lensSelectValue =
    similarityPreset == null || similarityPreset.similarityFloor == null
      ? 'none'
      : similarityPreset.similarityFloor;

  const refineFilterBar = !!onSimilarRefineModeChange;

  return (
    <div className="relative space-y-2">
      <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-2 md:gap-4">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-1.5 min-w-0">
            <p className="text-xs text-gray-500 shrink-0">{title}</p>
            {similarityPreset && onSimilarityLensChange ? (
              <div className="relative shrink-0 max-w-[10.5rem]">
                <select
                  aria-label="Likeness lens"
                  className={`appearance-none w-full rounded border pl-2 pr-7 py-0.5 text-[10px] tabular-nums bg-gray-950 cursor-pointer focus:outline-none focus:ring-1 focus:ring-blue-500/60 ${
                    similarityPreset.similarityFloor == null
                      ? 'border-amber-900/70 text-amber-500/95'
                      : 'border-gray-800 text-gray-400'
                  }`}
                  value={lensSelectValue}
                  onChange={(e) => {
                    const v = e.target.value;
                    const floor = v === 'none' ? null : (v as MatchStrengthTier);
                    void onSimilarityLensChange({
                      similarityFloor: floor,
                      minCosine: floor ? MATCH_STRENGTH_TO_MIN_COSINE[floor] : 0,
                    });
                  }}
                >
                  <option value="strict">Strict</option>
                  <option value="balanced">Close</option>
                  <option value="broad">Narrow</option>
                  <option value="none">Wide (Default)</option>
                </select>
                <ChevronDown
                  className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-gray-600"
                  strokeWidth={2}
                  aria-hidden
                />
              </div>
            ) : null}
            <span
              className="text-[10px] text-gray-600 tabular-nums px-1.5 py-0 rounded border border-gray-800 truncate max-w-[7rem]"
              title={`${clipBadge(clipSidecarRunning)} — embedding sidecar`}
            >
              [{clipBadge(clipSidecarRunning)}]
            </span>
            {showInspectorGear ? (
              <button
                type="button"
                aria-label="Similarity settings"
                aria-expanded={inspectorSettingsOpen ?? false}
                onClick={(e) => {
                  e.stopPropagation();
                  onInspectorGearClick?.();
                }}
                className={`p-1 rounded shrink-0 text-gray-500 hover:text-gray-200 hover:bg-gray-800 transition-colors ${inspectorSettingsOpen ? 'text-blue-400 bg-gray-800/90' : ''}`}
              >
                <Settings size={13} strokeWidth={1.75} />
              </button>
            ) : null}
          </div>
          {loadMsg ? <p className="text-[10px] text-blue-400/90 animate-pulse">{loadMsg}</p> : null}
        </div>

        {refineFilterBar ? (
          <div className="flex flex-wrap items-center gap-1 md:justify-end shrink-0 w-full md:w-auto pt-2 md:pt-0 border-t border-gray-800/80 md:border-0 mt-1 md:mt-0 md:max-w-[min(24rem,calc(100%-4rem))]">
            <Filter
              size={11}
              className={`shrink-0 md:ml-0 ${similarRefineMode != null ? 'text-blue-400/90' : 'text-gray-600'}`}
              strokeWidth={2}
              aria-hidden
            />
            <div className="flex flex-wrap items-center gap-1" role="radiogroup" aria-label="Refine similar images (one at a time)">
              {SIMILAR_REFINE_MODES.map((mode) => {
                const hint = REFINE_MODE_HELP[mode];
                const checked = similarRefineMode === mode;
                return (
                  <button
                    key={mode}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    title={checked ? `${hint} Active — click again for likeness-only ranking.` : hint}
                    onClick={() => {
                      const next = checked ? null : mode;
                      onSimilarRefineModeChange?.(next);
                    }}
                    className={`rounded border px-1.5 py-0 text-[10px] leading-tight transition-colors shrink-0 ${
                      checked
                        ? 'border-blue-700/85 bg-blue-950/55 text-blue-200'
                        : 'border-gray-800 text-gray-500 hover:border-gray-600 hover:text-gray-400'
                    }`}
                  >
                    {REFINE_STRIP_LABEL[mode]}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>

      {showInspectorGear && inspectorSettingsOpen && inspectorSettingsPopover ? (
        <div className="mt-2">{inspectorSettingsPopover}</div>
      ) : null}

      {carouselRowBusy ? (
        <div className={`flex gap-2 items-start ${size === 'md' ? '' : '-mx-1 px-1'} pb-1`}>
          {showBackRail ? (
            <>
              <PreviousSimilarThumb
                image={similarNavBackThumb}
                thumbClass={thumbClass}
                onBack={onSimilarNavBack}
                size={size}
              />
              <div className="w-px self-stretch min-h-[3.5rem] bg-gray-800 shrink-0" aria-hidden />
            </>
          ) : null}
          <div className="flex gap-2 overflow-x-auto flex-1 min-w-0">
            {loading && shown.length === 0 ? (
              Array.from({ length: skeletonCount }).map((_, i) => (
                <div
                  key={i}
                  className={`${thumbClass} rounded-md bg-gray-800/90 animate-pulse border border-gray-800 shrink-0`}
                />
              ))
            ) : shown.length > 0 ? (
              shown.map(({ image, similarity }) => (
                <SimilarThumbnailButton
                  key={image.id}
                  image={image}
                  similarity={similarity}
                  thumbClass={thumbClass}
                  badgeFloorCosine={badgeFloorCosine}
                  showLikenessOverlay={similarRefineMode === null}
                  onPick={onPick}
                />
              ))
            ) : null}
          </div>
        </div>
      ) : null}

      {!loading && shown.length === 0 ? (
        <div className="flex gap-2 items-start">
          {similarNavBackThumb && onSimilarNavBack ? (
            <>
              <PreviousSimilarThumb image={similarNavBackThumb} thumbClass={thumbClass} onBack={onSimilarNavBack} size={size} />
              <div className="flex-1 min-w-0">
                <p className="text-xs text-gray-600 leading-relaxed">{emptyStateMessage(emptyHint)}</p>
              </div>
            </>
          ) : (
            <p className="text-xs text-gray-600 leading-relaxed">{emptyStateMessage(emptyHint)}</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
