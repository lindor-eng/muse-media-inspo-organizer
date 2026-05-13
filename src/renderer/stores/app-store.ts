import { create } from 'zustand';
import type { MatchStrengthTier } from '../../shared/visual-similarity';
import { MATCH_STRENGTH_TO_MIN_COSINE } from '../../shared/visual-similarity';
import type { SimilarRefineMode } from '../../shared/similar-refine';
import { api } from '../lib/ipc';

export type { MatchStrengthTier };
export type { SimilarRefineMode };

export interface SimilarityPrefs {
  similarityFloor: MatchStrengthTier | null;
  minCosine: number;
  maxResults: number;
}

const DEFAULT_SIMILARITY_PREFS: SimilarityPrefs = {
  similarityFloor: null,
  minCosine: 0,
  maxResults: 14,
};

/** Bounds and storage key for the user-resizable grid thumbnail. */
export const GRID_THUMB_MIN = 96;
export const GRID_THUMB_MAX = 360;
export const GRID_THUMB_DEFAULT = 192;
const GRID_THUMB_STORAGE_KEY = 'muse:gridThumbHeight';

function loadInitialGridThumb(): number {
  if (typeof window === 'undefined') return GRID_THUMB_DEFAULT;
  try {
    const raw = window.localStorage.getItem(GRID_THUMB_STORAGE_KEY);
    if (!raw) return GRID_THUMB_DEFAULT;
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n)) return GRID_THUMB_DEFAULT;
    return Math.min(GRID_THUMB_MAX, Math.max(GRID_THUMB_MIN, n));
  } catch {
    return GRID_THUMB_DEFAULT;
  }
}

/** Bounds and storage key for the user-resizable sidebar width (px). */
export const SIDEBAR_WIDTH_MIN = 180;
export const SIDEBAR_WIDTH_MAX = 480;
export const SIDEBAR_WIDTH_DEFAULT = 240;
const SIDEBAR_WIDTH_STORAGE_KEY = 'muse:sidebarWidth';

function loadInitialSidebarWidth(): number {
  if (typeof window === 'undefined') return SIDEBAR_WIDTH_DEFAULT;
  try {
    const raw = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    if (!raw) return SIDEBAR_WIDTH_DEFAULT;
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n)) return SIDEBAR_WIDTH_DEFAULT;
    return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, n));
  } catch {
    return SIDEBAR_WIDTH_DEFAULT;
  }
}

/** Dedupe parallel initial loads (StrictMode double-mount). */
let similarityPrefsHydrateBusy = false;
/** Incremented on each prefs save so in-flight hydrate reads cannot clobber newer UI state (async race vs IPC). */
let similarityPrefsHydrateEpoch = 0;

/** Parse IPC payloads that may omit or strip fields across the preload bridge. */
function coerceSimilarityPrefs(raw: unknown, fallback: SimilarityPrefs): SimilarityPrefs {
  if (!raw || typeof raw !== 'object') return fallback;
  const r = raw as Record<string, unknown>;

  let similarityFloor: MatchStrengthTier | null = fallback.similarityFloor;
  if ('similarityFloor' in r) {
    const v = r.similarityFloor;
    if (v === null) similarityFloor = null;
    else if (v === 'broad' || v === 'balanced' || v === 'strict') similarityFloor = v;
  }

  let maxR = fallback.maxResults;
  if ('maxResults' in r && typeof r.maxResults === 'number' && Number.isFinite(r.maxResults)) {
    maxR = Math.min(48, Math.max(4, Math.round(r.maxResults)));
  }

  return {
    similarityFloor,
    minCosine: similarityFloor !== null ? MATCH_STRENGTH_TO_MIN_COSINE[similarityFloor] : 0,
    maxResults: maxR,
  };
}

function ipcSerializablePrefs(patch: Partial<SimilarityPrefs>): Partial<SimilarityPrefs> {
  try {
    return JSON.parse(JSON.stringify(patch)) as Partial<SimilarityPrefs>;
  } catch {
    return { ...patch };
  }
}

export interface Folder {
  id: string;
  name: string;
  parent_id: string | null;
  sort_order: number;
  color: string | null;
  image_count?: number;
}

export interface ImageRecord {
  id: string;
  filename: string;
  original_path: string;
  thumbnail_path: string | null;
  title: string;
  notes: string;
  alt_text: string;
  source_url: string;
  width: number | null;
  height: number | null;
  file_size: number | null;
  file_type: string | null;
  is_trashed: number;
  folder_id: string | null;
  imported_at: string;
  /** 0 grayscale-dominant, 1 chromatic; missing on older rows until reindex or re-import. */
  indexed_chromatic?: number | null;
  /** Dominant 30° hue bin and strength once thumb index runs — used for filters & Similar colors. */
  indexed_hue_bucket?: number | null;
  indexed_hue_strength?: number | null;
  indexed_hue_degrees?: number | null;
  indexed_hue_bucket_2?: number | null;
  indexed_hue_strength_2?: number | null;
}

export interface Tag {
  id: string;
  name: string;
  color: string | null;
  image_count?: number;
}

export interface ImageColor {
  id: string;
  image_id: string;
  hex_color: string;
  percentage: number;
  sort_order: number;
}

export interface SimilarImageEntry {
  image: ImageRecord;
  similarity: number;
}

export type SimilarImagesEmptyHint =
  | 'ollama_unavailable'
  | 'embedding_failed'
  | 'needs_other_indexed_images'
  | 'similarity_below_threshold';

export interface SimilarMatchesMeta {
  sourceHadEmbeddingBefore: boolean;
  peerCandidatesWithEmbedding: number;
  similarityFloor: MatchStrengthTier | null;
  minCosine: number;
  maxResultsRequested: number;
  refineModesApplied?: SimilarRefineMode[];
}

type ViewMode = 'all' | 'uncategorized' | 'untagged' | 'trash' | 'folder' | 'tag';

interface AppState {
  // Navigation
  viewMode: ViewMode;
  selectedFolderId: string | null;
  selectedTagId: string | null;
  selectedImageId: string | null;
  selectedImageIds: Set<string>;

  // Data
  folders: Folder[];
  images: ImageRecord[];
  tags: Tag[];
  totalImages: number;
  counts: { total: number; uncategorized: number; untagged: number; trashed: number };

  // UI
  theme: 'light' | 'dark';
  isImporting: boolean;
  searchQuery: string;
  isSearching: boolean;
  isCmdHeld: boolean;
  /** Grid thumbnail height in px (user-controlled via slider). */
  gridThumbHeight: number;
  /** Left sidebar width in px (user-resizable via right-edge drag handle). */
  sidebarWidth: number;
  /** Bumped to force DetailPanel/ImageFocus to re-fetch image metadata after a backend mutation that bypassed local state (e.g. AI re-analysis). */
  detailRefreshNonce: number;
  draggingImageId: string | null;
  focusOriginRect: { x: number; y: number; width: number; height: number } | null;
  isClosingFocus: boolean;
  similarImages: SimilarImageEntry[];
  isFetchingSimilar: boolean;
  similarEmptyHint: SimilarImagesEmptyHint | null;
  similarFetchEmbedBaseline: boolean | null;
  similarMatchesMeta: SimilarMatchesMeta | null;
  similarityPrefs: SimilarityPrefs;
  similarityPrefsHydrated: boolean;
  similarNavStack: ImageRecord[];
  /** Session-only similar-strip radio: one of layout / colors / format, or null (likeness only); cleared when focus closes. */
  similarRefineMode: SimilarRefineMode | null;

  // Actions
  setViewMode: (mode: ViewMode, id?: string | null) => void;
  setSelectedImage: (
    id: string | null,
    originRect?: { x: number; y: number; width: number; height: number } | null,
    opts?: { similarityAnchorSnapshot?: ImageRecord },
  ) => void;
  similarNavGoBack: () => void;
  toggleImageSelection: (id: string) => void;
  clearSelection: () => void;
  setClosingFocus: (closing: boolean) => void;
  setSearchQuery: (query: string) => void;
  executeSearch: (query: string) => Promise<void>;
  setTheme: (theme: 'light' | 'dark') => void;
  setGridThumbHeight: (px: number) => void;
  setSidebarWidth: (px: number) => void;
  setDraggingImage: (id: string | null) => void;

  loadFolders: () => Promise<void>;
  loadImages: () => Promise<void>;
  loadTags: () => Promise<void>;
  loadCounts: () => Promise<void>;
  refreshAll: () => Promise<void>;

  fetchSimilarImages: (imageId: string | null) => Promise<void>;
  setSimilarRefineMode: (mode: SimilarRefineMode | null) => void;
  loadSimilarityPrefs: () => Promise<void>;
  saveSimilarityPrefsAndRefresh: (prefs: Partial<SimilarityPrefs>) => Promise<void>;

  importFiles: (filePaths: string[]) => Promise<void>;
  createFolder: (name: string, parentId?: string | null) => Promise<void>;
  deleteFolder: (id: string) => Promise<void>;
  trashImage: (id: string) => Promise<void>;
  restoreImage: (id: string) => Promise<void>;
  deleteImage: (id: string) => Promise<void>;
  updateImage: (id: string, data: Partial<ImageRecord>) => Promise<void>;
  bulkTrashImages: (ids: string[]) => Promise<void>;
  bulkDeleteImages: (ids: string[]) => Promise<void>;
  bulkRestoreImages: (ids: string[]) => Promise<void>;
  bulkMoveToFolder: (ids: string[], folderId: string) => Promise<void>;
  bulkAddTag: (ids: string[], tagId: string) => Promise<void>;
}

export const useAppStore = create<AppState>((set, get) => ({
  viewMode: 'all',
  selectedFolderId: null,
  selectedTagId: null,
  selectedImageId: null,
  selectedImageIds: new Set<string>(),
  folders: [],
  images: [],
  tags: [],
  totalImages: 0,
  counts: { total: 0, uncategorized: 0, untagged: 0, trashed: 0 },
  theme: 'dark',
  isImporting: false,
  detailRefreshNonce: 0,
  searchQuery: '',
  isSearching: false,
  isCmdHeld: false,
  gridThumbHeight: loadInitialGridThumb(),
  sidebarWidth: loadInitialSidebarWidth(),
  draggingImageId: null,
  focusOriginRect: null,
  isClosingFocus: false,
  similarImages: [],
  isFetchingSimilar: false,
  similarEmptyHint: null,
  similarFetchEmbedBaseline: null,
  similarMatchesMeta: null,
  similarityPrefs: { ...DEFAULT_SIMILARITY_PREFS },
  similarityPrefsHydrated: false,
  similarNavStack: [],
  similarRefineMode: null,

  setViewMode: (mode, id = null) => {
    const folderId = mode === 'folder' ? id : null;
    set({ viewMode: mode, selectedFolderId: folderId, selectedTagId: mode === 'tag' ? id : null, selectedImageId: null, similarNavStack: [] });
    window.electronAPI.setCurrentFolder(folderId ?? null);
    get().loadImages();
  },

  setSelectedImage: (id, originRect = null, opts) =>
    set((state) => {
      const pushed = opts?.similarityAnchorSnapshot ? [...state.similarNavStack, opts.similarityAnchorSnapshot] : [];
      const similarNavStack = id === null ? [] : opts?.similarityAnchorSnapshot ? pushed : [];
      const nextSimilar = id
        ? {
            similarImages: [] as SimilarImageEntry[],
            isFetchingSimilar: true,
            similarEmptyHint: null,
            similarFetchEmbedBaseline: null,
            similarMatchesMeta: null,
          }
        : {
            similarImages: [] as SimilarImageEntry[],
            isFetchingSimilar: false,
            similarEmptyHint: null,
            similarFetchEmbedBaseline: null,
            similarMatchesMeta: null,
          };

      return {
        selectedImageId: id,
        focusOriginRect: originRect ?? null,
        isClosingFocus: false,
        selectedImageIds: new Set<string>(),
        similarNavStack,
        ...(id === null ? { similarRefineMode: null } : {}),
        ...nextSimilar,
      };
    }),

  similarNavGoBack: () =>
    set((state) => {
      if (!state.similarNavStack.length || !state.selectedImageId) return {};
      const parent = state.similarNavStack[state.similarNavStack.length - 1];
      return {
        similarNavStack: state.similarNavStack.slice(0, -1),
        selectedImageId: parent.id,
        focusOriginRect: null,
        isClosingFocus: false,
        similarImages: [],
        isFetchingSimilar: true,
        similarEmptyHint: null,
        similarFetchEmbedBaseline: null,
        similarMatchesMeta: null,
      };
    }),

  toggleImageSelection: (id) => {
    const current = new Set(get().selectedImageIds);
    if (current.has(id)) {
      current.delete(id);
    } else {
      current.add(id);
    }
    set({ selectedImageIds: current, selectedImageId: null });
  },

  clearSelection: () => set({ selectedImageIds: new Set<string>() }),


  setClosingFocus: (closing) => set({ isClosingFocus: closing }),
  setSearchQuery: (query) => {
    set({ searchQuery: query });
    if (!query.trim()) {
      get().loadImages();
    }
  },

  executeSearch: async (query) => {
    if (!query.trim()) {
      await get().loadImages();
      return;
    }
    set({ isSearching: true });
    try {
      const results = await api.searchByText(query) as { image_id: string; distance: number }[];
      if (results.length > 0) {
        const imageIds = results.map((r) => r.image_id);
        const images: ImageRecord[] = [];
        for (const id of imageIds) {
          const img = await api.getImage(id);
          if (img && !img.is_trashed) images.push(img);
        }
        set({ images, totalImages: images.length });
      } else {
        set({ images: [], totalImages: 0 });
      }
    } catch {
      set({ images: [], totalImages: 0 });
    } finally {
      set({ isSearching: false });
    }
  },
  setTheme: (theme) => set({ theme }),

  setGridThumbHeight: (px) => {
    const clamped = Math.min(GRID_THUMB_MAX, Math.max(GRID_THUMB_MIN, Math.round(px)));
    set({ gridThumbHeight: clamped });
    try {
      window.localStorage.setItem(GRID_THUMB_STORAGE_KEY, String(clamped));
    } catch {
      // Storage not available — accept session-only value.
    }
  },
  setSidebarWidth: (px) => {
    const clamped = Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(px)));
    set({ sidebarWidth: clamped });
    try {
      window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(clamped));
    } catch {
      // Storage not available — accept session-only value.
    }
  },
  setDraggingImage: (id) => set({ draggingImageId: id }),

  loadFolders: async () => {
    const folders = await api.getFolders();
    set({ folders });
  },

  loadImages: async () => {
    const state = get();
    const filter: Record<string, unknown> = {};

    switch (state.viewMode) {
      case 'all':
        filter.is_trashed = false;
        break;
      case 'uncategorized':
        filter.is_trashed = false;
        filter.folder_id = null;
        break;
      case 'trash':
        filter.is_trashed = true;
        break;
      case 'folder':
        filter.is_trashed = false;
        filter.folder_id = state.selectedFolderId;
        break;
      case 'tag':
        filter.is_trashed = false;
        if (state.selectedTagId) filter.tag_ids = [state.selectedTagId];
        break;
      case 'untagged':
        filter.is_trashed = false;
        filter.untagged = true;
        break;
    }

    const result = await api.queryImages(filter, 200, 0);
    set({ images: result.images, totalImages: result.total });
  },

  loadTags: async () => {
    const tags = await api.getTags();
    set({ tags });
  },

  loadCounts: async () => {
    const counts = await api.getImageCounts();
    set({ counts });
  },

  refreshAll: async () => {
    await Promise.all([get().loadFolders(), get().loadImages(), get().loadTags(), get().loadCounts()]);
  },

  loadSimilarityPrefs: async () => {
    if (get().similarityPrefsHydrated) return;
    if (similarityPrefsHydrateBusy) return;
    similarityPrefsHydrateBusy = true;
    const epochAtFetch = similarityPrefsHydrateEpoch;
    try {
      const prefs = await api.getSimilarityPrefs();
      const superseded = epochAtFetch !== similarityPrefsHydrateEpoch;
      const merged = coerceSimilarityPrefs(prefs, DEFAULT_SIMILARITY_PREFS);
      set((state) => ({
        similarityPrefs: superseded ? state.similarityPrefs : merged,
        similarityPrefsHydrated: true,
      }));
    } catch {
      const superseded = epochAtFetch !== similarityPrefsHydrateEpoch;
      set((state) => ({
        similarityPrefs: superseded ? state.similarityPrefs : { ...DEFAULT_SIMILARITY_PREFS },
        similarityPrefsHydrated: true,
      }));
    } finally {
      similarityPrefsHydrateBusy = false;
    }
  },

  saveSimilarityPrefsAndRefresh: async (incoming) => {
    similarityPrefsHydrateEpoch++;

    const patch = incoming as Partial<SimilarityPrefs> & Record<string, unknown>;
    const cur = get().similarityPrefs;

    let nextFloor = cur.similarityFloor;
    if (Object.prototype.hasOwnProperty.call(patch, 'similarityFloor')) {
      const v = patch.similarityFloor;
      nextFloor = v === undefined ? cur.similarityFloor : v;
    }

    let nextMax = cur.maxResults;
    if (Object.prototype.hasOwnProperty.call(patch, 'maxResults')) {
      const raw = Number(patch.maxResults);
      nextMax = Math.min(
        48,
        Math.max(4, Number.isFinite(raw) && Math.round(raw) > 0 ? Math.round(raw) : cur.maxResults),
      );
    }

    const optimistic: SimilarityPrefs = {
      similarityFloor: nextFloor,
      minCosine: nextFloor !== null ? MATCH_STRENGTH_TO_MIN_COSINE[nextFloor] : 0,
      maxResults: nextMax,
    };
    set({ similarityPrefs: optimistic });

    try {
      const mergedRaw = await api.setSimilarityPrefs(ipcSerializablePrefs(incoming));
      const reconcile = coerceSimilarityPrefs(mergedRaw, optimistic);
      set({ similarityPrefs: reconcile });
    } catch {
      set({ similarityPrefs: cur });
      return;
    }
    const sel = get().selectedImageId;
    if (sel) await get().fetchSimilarImages(sel);
  },

  fetchSimilarImages: async (imageId) => {
    if (!imageId) {
      set({
        similarImages: [],
        isFetchingSimilar: false,
        similarEmptyHint: null,
        similarFetchEmbedBaseline: null,
        similarMatchesMeta: null,
      });
      return;
    }
    const targetId = imageId;
    set({
      isFetchingSimilar: true,
      similarImages: [],
      similarEmptyHint: null,
      similarFetchEmbedBaseline: null,
      similarMatchesMeta: null,
    });

    try {
      let baseline: boolean | null = null;
      try {
        baseline = (await api.embeddingsHasForImage(targetId)) as boolean;
      } catch {
        baseline = null;
      }
      if (get().selectedImageId !== targetId) return;

      set({ similarFetchEmbedBaseline: baseline });

      type SimilarResp = {
        matches: SimilarImageEntry[];
        emptyHint?: SimilarImagesEmptyHint;
        meta?: SimilarMatchesMeta;
      };

      const mode = get().similarRefineMode;
      const payload = (await api.getSimilarImages(targetId, {
        refineModes: mode != null ? [mode] : [],
      })) as SimilarResp | SimilarImageEntry[];

      if (get().selectedImageId !== targetId) return;

      if (Array.isArray(payload)) {
        set({
          similarImages: payload,
          isFetchingSimilar: false,
          similarEmptyHint: null,
          similarMatchesMeta: null,
        });
        return;
      }

      const matches = payload.matches ?? [];
      set({
        similarImages: matches,
        isFetchingSimilar: false,
        similarEmptyHint: matches.length === 0 ? payload.emptyHint ?? null : null,
        similarMatchesMeta: payload.meta ?? null,
      });
    } catch {
      if (get().selectedImageId !== targetId) return;
      set({
        similarImages: [],
        isFetchingSimilar: false,
        similarEmptyHint: null,
        similarMatchesMeta: null,
      });
    }
  },

  setSimilarRefineMode: (mode) => {
    set({ similarRefineMode: mode });
    void get().fetchSimilarImages(get().selectedImageId);
  },

  importFiles: async (filePaths) => {
    set({ isImporting: true });
    const folderId = get().selectedFolderId;
    await api.importFiles(filePaths, folderId);
    set({ isImporting: false });
    await get().refreshAll();
  },

  createFolder: async (name, parentId = null) => {
    await api.createFolder(name, parentId ?? null);
    await get().loadFolders();
  },

  deleteFolder: async (id) => {
    await api.deleteFolder(id);
    if (get().selectedFolderId === id) {
      set({ viewMode: 'all', selectedFolderId: null });
    }
    await get().refreshAll();
  },

  trashImage: async (id) => {
    await api.trashImage(id);
    if (get().selectedImageId === id) set({ selectedImageId: null, similarNavStack: [] });
    await get().refreshAll();
  },

  restoreImage: async (id) => {
    await api.restoreImage(id);
    if (get().selectedImageId === id) set({ selectedImageId: null, similarNavStack: [] });
    await get().refreshAll();
  },

  deleteImage: async (id) => {
    await api.deleteImage(id);
    if (get().selectedImageId === id) set({ selectedImageId: null, similarNavStack: [] });
    await get().refreshAll();
  },

  updateImage: async (id, data) => {
    await api.updateImage(id, data);
    await get().loadImages();
  },

  bulkTrashImages: async (ids) => {
    for (const id of ids) await api.trashImage(id);
    set({ selectedImageIds: new Set<string>(), selectedImageId: null });
    await get().refreshAll();
  },

  bulkDeleteImages: async (ids) => {
    for (const id of ids) await api.deleteImage(id);
    set({ selectedImageIds: new Set<string>(), selectedImageId: null });
    await get().refreshAll();
  },

  bulkRestoreImages: async (ids) => {
    for (const id of ids) await api.restoreImage(id);
    set({ selectedImageIds: new Set<string>(), selectedImageId: null });
    await get().refreshAll();
  },

  bulkMoveToFolder: async (ids, folderId) => {
    for (const id of ids) await api.updateImage(id, { folder_id: folderId });
    set({ selectedImageIds: new Set<string>() });
    await get().refreshAll();
  },

  bulkAddTag: async (ids, tagId) => {
    for (const id of ids) await api.addTagToImage(id, tagId);
    set({ selectedImageIds: new Set<string>() });
    await get().refreshAll();
  },
}));
