import { memo, useRef, useState, useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { FolderOpen, Tag, Trash2, Plus, RotateCcw, Sparkles } from 'lucide-react';
import { useAppStore, type ImageRecord } from '../../stores/app-store';
import { api } from '../../lib/ipc';

interface Props {
  image: ImageRecord;
}

function ImageCardImpl({ image }: Props) {
  // Narrow, per-card subscription: selection is expressed as derived primitives so flipping
  // focus/selection re-renders only the affected cards, not the whole grid. Action functions
  // have stable identities in zustand, so selecting them never triggers a re-render. This
  // matters at scale — the grid now renders every image in the view, so a card that woke up
  // on every unrelated store change (search keystrokes, import toggles, similar-image fetches)
  // would make a large library crawl.
  const {
    isFocused, isBulkSelected, hasBulkSelection, isCmdHeld, folders, tags, gridThumbHeight,
    setSelectedImage, toggleImageSelection, setDraggingImage, trashImage, deleteImage,
    refreshAll, loadTags, bulkTrashImages, bulkDeleteImages, bulkRestoreImages,
    bulkMoveToFolder, bulkAddTag,
  } = useAppStore(
    useShallow((s) => ({
      isFocused: s.selectedImageId === image.id,
      isBulkSelected: s.selectedImageIds.has(image.id),
      hasBulkSelection: s.selectedImageIds.size > 0,
      isCmdHeld: s.isCmdHeld,
      folders: s.folders,
      tags: s.tags,
      gridThumbHeight: s.gridThumbHeight,
      setSelectedImage: s.setSelectedImage,
      toggleImageSelection: s.toggleImageSelection,
      setDraggingImage: s.setDraggingImage,
      trashImage: s.trashImage,
      deleteImage: s.deleteImage,
      refreshAll: s.refreshAll,
      loadTags: s.loadTags,
      bulkTrashImages: s.bulkTrashImages,
      bulkDeleteImages: s.bulkDeleteImages,
      bulkRestoreImages: s.bulkRestoreImages,
      bulkMoveToFolder: s.bulkMoveToFolder,
      bulkAddTag: s.bulkAddTag,
    })),
  );
  const cardRef = useRef<HTMLDivElement>(null);
  const isSelected = isFocused || isBulkSelected;

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [subMenu, setSubMenu] = useState<'tags' | 'folders' | null>(null);
  const [tagInput, setTagInput] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);
  const tagInputRef = useRef<HTMLInputElement>(null);

  const imageSrc = image.thumbnail_path
    ? `local-file://${image.thumbnail_path}`
    : `local-file://${image.original_path}`;

  // If this image is part of a bulk selection, actions apply to all selected. The full Set is
  // read non-reactively (getState) so this card doesn't re-render whenever another card's
  // selection toggles — hasBulkSelection/isBulkSelected in the slice above already tell it
  // whether it participates, which is all it needs to decide between "all selected" and "just me".
  const targetIds: string[] = hasBulkSelection && isBulkSelected
    ? Array.from(useAppStore.getState().selectedImageIds)
    : [image.id];

  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData('application/x-muse-image', image.id);
    e.dataTransfer.effectAllowed = 'all';
    setDraggingImage(image.id);
  };

  const handleDragEnd = () => {
    setTimeout(() => setDraggingImage(null), 0);
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    // If right-clicking on a non-selected image while bulk selection exists, add it
    if (hasBulkSelection && !isBulkSelected) {
      toggleImageSelection(image.id);
    }
    setContextMenu({ x: e.clientX, y: e.clientY });
    setSubMenu(null);
    setTagInput('');
  };

  useEffect(() => {
    if (!contextMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
        setSubMenu(null);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [contextMenu]);

  useEffect(() => {
    if (subMenu === 'tags' && tagInputRef.current) {
      tagInputRef.current.focus();
    }
  }, [subMenu]);

  const handleAddTag = async (tagName: string) => {
    const name = tagName.trim();
    if (!name) return;
    let tag = tags.find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (!tag) {
      tag = await api.createTag(name);
    }
    if (targetIds.length > 1) {
      await bulkAddTag(targetIds, tag!.id);
    } else {
      await api.addTagToImage(image.id, tag!.id);
      loadTags();
    }
    setContextMenu(null);
    setSubMenu(null);
  };

  const handleMoveToFolder = async (folderId: string) => {
    if (targetIds.length > 1) {
      await bulkMoveToFolder(targetIds, folderId);
    } else {
      await api.updateImage(image.id, { folder_id: folderId });
      refreshAll();
    }
    setContextMenu(null);
    setSubMenu(null);
  };

  const handleTrashOrDelete = () => {
    setContextMenu(null);
    setSubMenu(null);
    if (image.is_trashed) {
      targetIds.length > 1 ? bulkDeleteImages(targetIds) : deleteImage(image.id);
    } else {
      targetIds.length > 1 ? bulkTrashImages(targetIds) : trashImage(image.id);
    }
  };

  const handleRestore = () => {
    setContextMenu(null);
    setSubMenu(null);
    targetIds.length > 1 ? bulkRestoreImages(targetIds) : useAppStore.getState().restoreImage(image.id);
  };

  const handleReanalyze = async () => {
    setContextMenu(null);
    setSubMenu(null);
    const ids = targetIds;
    await api.reanalyzeImages(ids);
    if (ids.length > 1) {
      useAppStore.setState({ selectedImageIds: new Set<string>() });
    }
    await refreshAll();
    await loadTags();
    useAppStore.setState((s) => ({ detailRefreshNonce: s.detailRefreshNonce + 1 }));
  };

  const handleClick = (e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey) {
      toggleImageSelection(image.id);
    } else {
      const rect = cardRef.current?.getBoundingClientRect();
      setSelectedImage(image.id, rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null);
    }
  };

  const selectionCount = targetIds.length;
  const showBulkLabel = selectionCount > 1;

  // Estimated rendered width from the image's real aspect ratio (square fallback when the DB
  // has no dimensions). Feeds contain-intrinsic-size so off-screen cards reserve the correct
  // footprint — the browser can skip their layout/paint (content-visibility) with zero scroll
  // jump when they come into view.
  const aspect = image.width && image.height ? image.width / image.height : 1;
  const intrinsicWidth = Math.round(gridThumbHeight * aspect);

  return (
    <>
      <div
        ref={cardRef}
        data-image-id={image.id}
        draggable
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onContextMenu={handleContextMenu}
        className={`cursor-pointer rounded-lg overflow-hidden border-2 relative
          ${isBulkSelected ? 'border-blue-500 ring-2 ring-blue-500/30' : isSelected ? 'border-blue-500 ring-2 ring-blue-500/30' : 'border-transparent hover:border-gray-700'}`}
        style={{
          height: gridThumbHeight,
          contentVisibility: 'auto',
          containIntrinsicSize: `${gridThumbHeight}px ${intrinsicWidth}px`,
        }}
        onClick={handleClick}
      >
        <img
          src={imageSrc}
          alt={image.alt_text || image.title || image.filename}
          className="h-full w-auto block bg-gray-800 pointer-events-none"
          loading="lazy"
        />
        {isBulkSelected ? (
          // White halo + softer dark outer ring (#333) keep the blue chip visible across light
          // and dark thumbnails alike.
          <div
            className="absolute top-1.5 left-1.5 w-5 h-5 bg-blue-500 rounded-full flex items-center justify-center"
            style={{ boxShadow: '0 0 0 1.5px rgba(255,255,255,0.9), 0 0 0 2.25px #666666' }}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className="text-white">
              <path d="M2 5L4 7L8 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        ) : isCmdHeld && (
          <div
            className="absolute top-1.5 left-1.5 w-5 h-5 rounded-full border-[1.5px] border-white/95 bg-white/10"
            style={{ boxShadow: '0 0 0 0.75px #666666' }}
          />
        )}
      </div>

      {contextMenu && (
        <div
          ref={menuRef}
          className="fixed z-50 bg-gray-800 border border-gray-700 rounded-lg shadow-xl py-1 min-w-[180px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {showBulkLabel && (
            <div className="px-3 py-1.5 text-xs text-gray-500 border-b border-gray-700">
              {selectionCount} images selected
            </div>
          )}

          <button
            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left text-gray-300 hover:bg-gray-700 transition-colors"
            onClick={() => setSubMenu(subMenu === 'tags' ? null : 'tags')}
          >
            <Tag size={12} className="shrink-0" />
            <span className="flex-1">Add Tag</span>
          </button>
          {subMenu === 'tags' && (
            <div className="px-2 py-1 border-t border-gray-700">
              <input
                ref={tagInputRef}
                type="text"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleAddTag(tagInput);
                  if (e.key === 'Escape') { setSubMenu(null); setTagInput(''); }
                }}
                placeholder="Tag name..."
                className="w-full px-2 py-1 text-xs bg-gray-900 border border-gray-600 rounded text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500"
              />
              {tagInput && (
                <div className="mt-1 max-h-24 overflow-y-auto">
                  {tags
                    .filter((t) => t.name.toLowerCase().includes(tagInput.toLowerCase()))
                    .slice(0, 6)
                    .map((t) => (
                      <button
                        key={t.id}
                        className="w-full px-2 py-1 text-xs text-left text-gray-300 hover:bg-gray-700 rounded"
                        onClick={() => handleAddTag(t.name)}
                      >
                        {t.name}
                      </button>
                    ))}
                </div>
              )}
              {tagInput && !tags.find((t) => t.name.toLowerCase() === tagInput.toLowerCase()) && (
                <button
                  className="w-full px-2 py-1 mt-1 text-xs text-left text-blue-400 hover:bg-gray-700 rounded flex items-center gap-1"
                  onClick={() => handleAddTag(tagInput)}
                >
                  <Plus size={10} /> Create "{tagInput}"
                </button>
              )}
            </div>
          )}

          <button
            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left text-gray-300 hover:bg-gray-700 transition-colors"
            onClick={() => setSubMenu(subMenu === 'folders' ? null : 'folders')}
          >
            <FolderOpen size={12} className="shrink-0" />
            <span className="flex-1">Move to Folder</span>
          </button>
          {subMenu === 'folders' && (
            <div className="px-2 py-1 border-t border-gray-700 max-h-32 overflow-y-auto">
              {folders.length === 0 ? (
                <p className="text-xs text-gray-500 px-2 py-1">No folders created</p>
              ) : (
                folders.map((folder) => (
                  <button
                    key={folder.id}
                    className={`w-full px-2 py-1 text-xs text-left rounded flex items-center gap-1.5 ${image.folder_id === folder.id ? 'text-blue-400 bg-blue-900/20' : 'text-gray-300 hover:bg-gray-700'}`}
                    onClick={() => handleMoveToFolder(folder.id)}
                  >
                    <FolderOpen size={10} className="text-yellow-500" />
                    {folder.name}
                  </button>
                ))
              )}
            </div>
          )}

          {!image.is_trashed && (
            <button
              className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left text-gray-300 hover:bg-gray-700 transition-colors"
              onClick={handleReanalyze}
            >
              <Sparkles size={12} className="shrink-0" />
              <span className="flex-1">{showBulkLabel ? `Re-analyze ${selectionCount} images` : 'Re-analyze'}</span>
            </button>
          )}

          <div className="border-t border-gray-700 mt-1 pt-1">
            {!!image.is_trashed && (
              <button
                className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left text-green-400 hover:bg-gray-700 transition-colors"
                onClick={handleRestore}
              >
                <RotateCcw size={12} className="shrink-0" />
                <span className="flex-1">Restore</span>
              </button>
            )}
            <button
              className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left text-red-400 hover:bg-gray-700 transition-colors"
              onClick={handleTrashOrDelete}
            >
              <Trash2 size={12} className="shrink-0" />
              <span className="flex-1">{image.is_trashed ? 'Delete permanently' : 'Move to Trash'}</span>
            </button>
          </div>
        </div>
      )}
    </>
  );
}

// Memoized so that when ContentGrid re-renders without a new images array (its own state or
// props changing), the whole card list is skipped by referential equality on `image`. Combined
// with the narrow useShallow slice above — which stops unrelated store changes (search input,
// cmd-held, another card's selection) from waking this card at all — this keeps a fully-rendered
// large view responsive. (A genuine data refresh does hand every card a fresh object and re-renders;
// that's the intended path for reflecting edits.)
export const ImageCard = memo(ImageCardImpl);
