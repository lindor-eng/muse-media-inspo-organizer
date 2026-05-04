import { create } from 'zustand';
import { api } from '../lib/ipc';

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
  source_url: string;
  rating: number;
  width: number | null;
  height: number | null;
  file_size: number | null;
  file_type: string | null;
  is_trashed: number;
  folder_id: string | null;
  imported_at: string;
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

type ViewMode = 'all' | 'uncategorized' | 'untagged' | 'trash' | 'folder' | 'tag';

interface AppState {
  // Navigation
  viewMode: ViewMode;
  selectedFolderId: string | null;
  selectedTagId: string | null;
  selectedImageId: string | null;

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
  draggingImageId: string | null;
  focusOriginRect: { x: number; y: number; width: number; height: number } | null;
  isClosingFocus: boolean;

  // Actions
  setViewMode: (mode: ViewMode, id?: string | null) => void;
  setSelectedImage: (id: string | null, originRect?: { x: number; y: number; width: number; height: number } | null) => void;
  setClosingFocus: (closing: boolean) => void;
  setSearchQuery: (query: string) => void;
  executeSearch: (query: string) => Promise<void>;
  setTheme: (theme: 'light' | 'dark') => void;
  setDraggingImage: (id: string | null) => void;

  loadFolders: () => Promise<void>;
  loadImages: () => Promise<void>;
  loadTags: () => Promise<void>;
  loadCounts: () => Promise<void>;
  refreshAll: () => Promise<void>;

  importFiles: (filePaths: string[]) => Promise<void>;
  createFolder: (name: string, parentId?: string | null) => Promise<void>;
  deleteFolder: (id: string) => Promise<void>;
  trashImage: (id: string) => Promise<void>;
  restoreImage: (id: string) => Promise<void>;
  deleteImage: (id: string) => Promise<void>;
  updateImage: (id: string, data: Partial<ImageRecord>) => Promise<void>;
}

export const useAppStore = create<AppState>((set, get) => ({
  viewMode: 'all',
  selectedFolderId: null,
  selectedTagId: null,
  selectedImageId: null,
  folders: [],
  images: [],
  tags: [],
  totalImages: 0,
  counts: { total: 0, uncategorized: 0, untagged: 0, trashed: 0 },
  theme: 'dark',
  isImporting: false,
  searchQuery: '',
  isSearching: false,
  draggingImageId: null,
  focusOriginRect: null,
  isClosingFocus: false,

  setViewMode: (mode, id = null) => {
    const folderId = mode === 'folder' ? id : null;
    set({ viewMode: mode, selectedFolderId: folderId, selectedTagId: mode === 'tag' ? id : null, selectedImageId: null });
    window.electronAPI.setCurrentFolder(folderId ?? null);
    get().loadImages();
  },

  setSelectedImage: (id, originRect = null) => set({ selectedImageId: id, focusOriginRect: originRect ?? null, isClosingFocus: false }),
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
    if (get().selectedImageId === id) set({ selectedImageId: null });
    await get().refreshAll();
  },

  restoreImage: async (id) => {
    await api.restoreImage(id);
    if (get().selectedImageId === id) set({ selectedImageId: null });
    await get().refreshAll();
  },

  deleteImage: async (id) => {
    await api.deleteImage(id);
    if (get().selectedImageId === id) set({ selectedImageId: null });
    await get().refreshAll();
  },

  updateImage: async (id, data) => {
    await api.updateImage(id, data);
    await get().loadImages();
  },
}));
