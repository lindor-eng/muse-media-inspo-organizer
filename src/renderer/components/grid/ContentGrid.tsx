import { useCallback, useEffect } from 'react';
import { Search, Plus, Import, Loader2, Grid2x2, Grid3x3 } from 'lucide-react';
import { useAppStore, GRID_THUMB_MIN, GRID_THUMB_MAX } from '../../stores/app-store';
import { ImageCard } from './ImageCard';

export function ContentGrid() {
  const { images, totalImages, viewMode, selectedFolderId, folders, isImporting, importFiles, searchQuery, setSearchQuery, executeSearch, isSearching, selectedImageId, isClosingFocus, selectedImageIds, clearSelection, gridThumbHeight, setGridThumbHeight } = useAppStore();
  const showToolbar = !selectedImageId || isClosingFocus;

  useEffect(() => {
    const setState = useAppStore.setState;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && selectedImageIds.size > 0) {
        clearSelection();
      }
      if (e.key === 'Meta' || e.key === 'Control') {
        setState({ isCmdHeld: true });
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Meta' || e.key === 'Control') {
        setState({ isCmdHeld: false });
      }
    };
    const handleBlur = () => setState({ isCmdHeld: false });
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, [selectedImageIds, clearSelection]);

  const currentFolderName = viewMode === 'folder'
    ? folders.find((f) => f.id === selectedFolderId)?.name ?? 'Folder'
    : viewMode === 'all' ? 'All Images'
    : viewMode === 'uncategorized' ? 'Uncategorized'
    : viewMode === 'untagged' ? 'Untagged'
    : viewMode === 'trash' ? 'Trash'
    : 'Images';

  const handleImportClick = useCallback(async () => {
    const filePaths = await window.electronAPI.openFileDialog();
    if (filePaths.length > 0) importFiles(filePaths);
  }, [importFiles]);

  return (
    <main className="absolute inset-0 flex flex-col bg-gray-950">
      {/* Toolbar */}
      <header className="h-12 shrink-0 flex items-center gap-3 px-4 border-b border-gray-800">
        <h2 className="text-sm font-medium text-gray-200">{currentFolderName}</h2>
        <span className="text-xs text-gray-500">{totalImages} items</span>
        {selectedImageIds.size > 0 && (
          <span className="text-xs text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded-full">
            {selectedImageIds.size} selected
          </span>
        )}
      </header>

      {/* Fixed top-right controls */}
      <div
        className={`fixed top-0 right-0 z-50 flex items-center gap-3 px-4 h-12 border-b border-gray-800 transition-opacity ${showToolbar ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        style={{ transitionTimingFunction: 'cubic-bezier(0.2, 0.9, 0.3, 1)', transitionDuration: '350ms' }}
      >
        <div className="flex items-center gap-2">
          <Grid3x3 size={14} className="text-gray-500" />
          <input
            type="range"
            aria-label="Thumbnail size"
            title={`Thumbnail size: ${gridThumbHeight}px`}
            min={GRID_THUMB_MIN}
            max={GRID_THUMB_MAX}
            step={4}
            value={gridThumbHeight}
            onChange={(e) => setGridThumbHeight(Number(e.target.value))}
            className="w-24 h-1 accent-blue-500 cursor-pointer"
          />
          <Grid2x2 size={14} className="text-gray-500" />
        </div>

        <div className="relative">
          {isSearching ? (
            <Loader2 size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-blue-400 animate-spin" />
          ) : (
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
          )}
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && searchQuery.trim()) {
                executeSearch(searchQuery.trim());
              }
            }}
            placeholder="Search images..."
            className="pl-8 pr-3 py-1.5 text-sm bg-gray-800 border border-gray-700 rounded-md text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500 w-48"
          />
        </div>

        <button
          onClick={handleImportClick}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-md transition-colors"
        >
          <Plus size={14} />
          Import
        </button>
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-y-auto p-4">
        {isImporting && (
          <div className="mb-4 px-4 py-3 bg-blue-900/30 border border-blue-800 rounded-lg text-sm text-blue-300 flex items-center gap-2">
            <Import size={14} className="animate-pulse" />
            Importing files...
          </div>
        )}

        {images.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-500">
            <Images size={48} className="mb-4 opacity-50" />
            <p className="text-sm">No images here yet</p>
            <p className="text-xs mt-1">Drag and drop files or click Import</p>
          </div>
        ) : (
          <div className="flex flex-wrap gap-3 items-start">
            {images.map((image) => (
              <ImageCard key={image.id} image={image} />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

// Re-export for tree-shaking
const Images = ({ size, className }: { size: number; className?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
    <circle cx="9" cy="9" r="2" />
    <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
  </svg>
);
