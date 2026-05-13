import { useState, useEffect, useRef, useLayoutEffect } from 'react';
import { Images, Tag, Trash2, FolderOpen, Plus, ChevronRight, ChevronDown, Inbox, Pencil, Trash } from 'lucide-react';
import { useAppStore, type Folder, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX } from '../../stores/app-store';
import { api } from '../../lib/ipc';

export function Sidebar() {
  const { folders, tags, counts, viewMode, selectedFolderId, selectedTagId, setViewMode, createFolder, deleteFolder, refreshAll, draggingImageId, selectedImageIds, bulkMoveToFolder, sidebarWidth, setSidebarWidth } = useAppStore();
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  // Section-level collapse for the Folders / Tags groups. Persisted so the layout sticks across launches.
  const [foldersCollapsed, setFoldersCollapsed] = useState<boolean>(() => {
    try { return window.localStorage.getItem('muse:foldersCollapsed') === '1'; } catch { return false; }
  });
  const [tagsCollapsed, setTagsCollapsed] = useState<boolean>(() => {
    try { return window.localStorage.getItem('muse:tagsCollapsed') === '1'; } catch { return false; }
  });
  const persistCollapsed = (key: 'muse:foldersCollapsed' | 'muse:tagsCollapsed', v: boolean) => {
    try { window.localStorage.setItem(key, v ? '1' : '0'); } catch { /* ignore storage errors */ }
  };

  /** Count of folders currently rendered in the tree (top-level + expanded descendants).
      Drives the cascade-out timeout so the collapse waits long enough for every row to fade. */
  const visibleFolderCount = (): number => {
    const walk = (parentId: string | null): number => {
      const siblings = folders.filter((f) => f.parent_id === parentId);
      let count = siblings.length;
      for (const s of siblings) if (expandedFolders.has(s.id)) count += walk(s.id);
      return count;
    };
    return walk(null);
  };

  /** Per-row animation duration baked into the CSS keyframes. Keep in sync with `index.css`. */
  const CASCADE_ROW_DURATION = 160;
  /** Target total duration so short and long sections feel similar. */
  const CASCADE_TARGET_TOTAL = 360;
  const cascadeStagger = (rowCount: number): number => {
    if (rowCount <= 1) return 0;
    const ideal = (CASCADE_TARGET_TOTAL - CASCADE_ROW_DURATION) / (rowCount - 1);
    return Math.max(4, Math.min(28, ideal));
  };

  // Expand cascades top-down via cascade-in; collapse is instant (no exit animation).
  const toggleFolders = () => {
    const next = !foldersCollapsed;
    setFoldersCollapsed(next);
    persistCollapsed('muse:foldersCollapsed', next);
  };

  const toggleTags = () => {
    const next = !tagsCollapsed;
    setTagsCollapsed(next);
    persistCollapsed('muse:tagsCollapsed', next);
  };

  // FLIP animation: capture each folder row's bounding box before the render that changes order,
  // then on layout effect compute deltas and animate from old position → new position. Runs every
  // render so it stays in sync with previewOrder updates during a drag.
  useLayoutEffect(() => {
    const next = new Map<string, DOMRect>();
    rowRefs.current.forEach((el, id) => {
      next.set(id, el.getBoundingClientRect());
    });

    // Only animate while a folder drag is actively shifting the preview order. Other re-renders
    // (folder selection, count updates, etc.) just refresh the cached rects so the next real
    // reorder has accurate "previous" positions to FLIP from.
    if (!draggingFolderId) {
      prevRectsRef.current = next;
      return;
    }

    const prev = prevRectsRef.current;
    let animatedAny = false;
    rowRefs.current.forEach((el, id) => {
      const oldRect = prev.get(id);
      const newRect = next.get(id);
      if (!oldRect || !newRect) return;
      const dy = oldRect.top - newRect.top;
      if (Math.abs(dy) < 0.5) return;
      // Skip animating the row currently being dragged — the browser owns its visual position.
      if (id === draggingFolderId) return;
      el.style.transition = 'none';
      el.style.transform = `translateY(${dy}px)`;
      // Force reflow so the next frame's transition kicks in.
      void el.offsetHeight;
      el.style.transition = 'transform 200ms cubic-bezier(0.2, 0.9, 0.3, 1)';
      el.style.transform = '';
      animatedAny = true;
    });
    if (animatedAny) {
      isAnimatingRef.current = true;
      window.setTimeout(() => { isAnimatingRef.current = false; }, 200);
    }
    prevRectsRef.current = next;
  });
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ folderId: string; x: number; y: number } | null>(null);
  const [trashContextMenu, setTrashContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  /** Active folder reorder drag — id of the folder being dragged. */
  const [draggingFolderId, setDraggingFolderId] = useState<string | null>(null);
  /** Live preview ordering during a drag: maps parent_id → ordered child ids.
      Null when no drag is active; rendering falls back to folders[].sort_order. */
  const [previewOrder, setPreviewOrder] = useState<Map<string | null, string[]> | null>(null);
  /** Refs to each folder row for FLIP animation (record positions before reorder, then animate). */
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const prevRectsRef = useRef<Map<string, DOMRect>>(new Map());
  /** Tracks whether a FLIP animation is in progress so we can skip new preview updates until it
      finishes. Without this, fast cursor moves trigger overlapping animations that visually clash. */
  const isAnimatingRef = useRef(false);
  /** Last (target id, edge) committed to preview — used to dedupe redundant dragover events. */
  const lastPreviewKeyRef = useRef<string | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const trashContextMenuRef = useRef<HTMLDivElement>(null);
  const isResizingRef = useRef(false);

  // Drag-to-resize: while the user holds the right edge handle, mousemove updates width and
  // the body cursor stays as col-resize even if the pointer briefly leaves the handle.
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!isResizingRef.current) return;
      const next = Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, e.clientX));
      setSidebarWidth(next);
    };
    const onUp = () => {
      if (!isResizingRef.current) return;
      isResizingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [setSidebarWidth]);

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    isResizingRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  useEffect(() => {
    if (!contextMenu && !trashContextMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
      if (trashContextMenuRef.current && !trashContextMenuRef.current.contains(e.target as Node)) {
        setTrashContextMenu(null);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [contextMenu, trashContextMenu]);

  const handleRenameFolder = async () => {
    if (renamingFolderId && renameValue.trim()) {
      await api.updateFolder(renamingFolderId, { name: renameValue.trim() });
      await refreshAll();
    }
    setRenamingFolderId(null);
    setRenameValue('');
  };

  /** Apply previewOrder if active, otherwise fall back to the canonical sort_order. */
  const orderedSiblings = (parentId: string | null): Folder[] => {
    const all = folders.filter((f) => f.parent_id === parentId);
    const overridden = previewOrder?.get(parentId);
    if (!overridden) return all.sort((a, b) => a.sort_order - b.sort_order);
    const byId = new Map(all.map((f) => [f.id, f] as const));
    return overridden.map((id) => byId.get(id)).filter((f): f is Folder => Boolean(f));
  };

  const rootFolders = orderedSiblings(null);

  const toggleExpand = (id: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleCreateFolder = () => {
    if (newFolderName.trim()) {
      createFolder(newFolderName.trim());
      setNewFolderName('');
      setIsCreatingFolder(false);
    }
  };

  const getChildren = (parentId: string): Folder[] => orderedSiblings(parentId);

  const handleFolderDrop = async (e: React.DragEvent, folderId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDropTargetId(null);
    if (!draggingImageId) return;

    // If the dragged image is part of an active bulk selection, move them all.
    if (selectedImageIds.size > 1 && selectedImageIds.has(draggingImageId)) {
      await bulkMoveToFolder(Array.from(selectedImageIds), folderId);
    } else {
      await api.updateImage(draggingImageId, { folder_id: folderId });
      refreshAll();
    }
  };

  const handleFolderDragOver = (e: React.DragEvent, folderId: string) => {
    if (draggingImageId) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setDropTargetId(folderId);
    }
  };

  const handleFolderDragLeave = () => {
    setDropTargetId(null);
  };

  /** Live-update the preview order so siblings shift around the dragged row as the cursor moves.
      Throttled by an "is animating" flag and a dedupe key so fast drags don't queue overlapping
      reorders mid-animation. */
  const previewReorder = (draggedId: string, targetId: string, edge: 'before' | 'after') => {
    if (draggedId === targetId) return;
    if (isAnimatingRef.current) return;
    const key = `${targetId}:${edge}`;
    if (lastPreviewKeyRef.current === key) return;

    const dragged = folders.find((f) => f.id === draggedId);
    const target = folders.find((f) => f.id === targetId);
    if (!dragged || !target) return;
    if (dragged.parent_id !== target.parent_id) return;

    const parentId = dragged.parent_id;
    const current = orderedSiblings(parentId).map((f) => f.id);
    const without = current.filter((id) => id !== draggedId);
    const targetIdx = without.indexOf(targetId);
    if (targetIdx === -1) return;
    const insertAt = edge === 'before' ? targetIdx : targetIdx + 1;
    const next = [...without.slice(0, insertAt), draggedId, ...without.slice(insertAt)];

    setPreviewOrder((prev) => {
      const map = new Map(prev ?? []);
      const existing = map.get(parentId);
      if (existing && existing.length === next.length && existing.every((id, i) => id === next[i])) return prev;
      map.set(parentId, next);
      return map;
    });
    lastPreviewKeyRef.current = key;
  };

  /** Persist the preview order on drop. Writes only the rows whose index changed. */
  const commitFolderReorder = async () => {
    const order = previewOrder;
    setPreviewOrder(null);
    if (!order) return;
    await Promise.all(
      Array.from(order.entries()).flatMap(([, ids]) =>
        ids.map((id, i) => {
          const f = folders.find((x) => x.id === id);
          if (!f || f.sort_order === i) return Promise.resolve();
          return api.updateFolder(id, { sort_order: i });
        }),
      ),
    );
    await refreshAll();
  };

  const renderFolder = (folder: Folder, depth = 0, rowIndex?: number) => {
    const hasChildren = orderedSiblings(folder.id).length > 0;
    const isExpanded = expandedFolders.has(folder.id);
    const isSelected = viewMode === 'folder' && selectedFolderId === folder.id;
    const isDropTarget = dropTargetId === folder.id;
    const isRenaming = renamingFolderId === folder.id;

    return (
      <div
        key={folder.id}
        ref={(el) => {
          if (el) rowRefs.current.set(folder.id, el);
          else rowRefs.current.delete(folder.id);
        }}
        className="relative cascade-row"
        style={rowIndex !== undefined ? { ['--row-index' as string]: rowIndex } : undefined}
        draggable={!isRenaming}
        onDragStart={(e) => {
          e.dataTransfer.setData('application/x-muse-folder', folder.id);
          e.dataTransfer.effectAllowed = 'move';
          setDraggingFolderId(folder.id);
          lastPreviewKeyRef.current = null;
          isAnimatingRef.current = false;
          setPreviewOrder(new Map([[folder.parent_id, orderedSiblings(folder.parent_id).map((f) => f.id)]]));
        }}
        onDragEnd={() => {
          setDraggingFolderId(null);
          lastPreviewKeyRef.current = null;
          isAnimatingRef.current = false;
          void commitFolderReorder();
        }}
        onDragOver={(e) => {
          const types = e.dataTransfer.types;
          const isFolderDrag = types.includes('application/x-muse-folder');
          if (isFolderDrag && draggingFolderId) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            const rect = e.currentTarget.getBoundingClientRect();
            const edge: 'before' | 'after' = e.clientY - rect.top < rect.height / 2 ? 'before' : 'after';
            previewReorder(draggingFolderId, folder.id, edge);
            setDropTargetId(null);
          } else {
            handleFolderDragOver(e, folder.id);
          }
        }}
        onDragLeave={() => handleFolderDragLeave()}
        onDrop={(e) => {
          const folderDragId = e.dataTransfer.getData('application/x-muse-folder');
          if (folderDragId) {
            e.preventDefault();
            e.stopPropagation();
            // commitFolderReorder runs from onDragEnd; nothing extra needed here.
          } else {
            handleFolderDrop(e, folder.id);
          }
        }}
      >
        <button
          className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm rounded-md transition-colors
            ${isDropTarget ? 'bg-blue-600/30 text-blue-300 ring-1 ring-blue-500' : isSelected ? 'bg-blue-600/20 text-blue-400' : 'text-gray-300 hover:bg-white/5'}
            ${draggingFolderId === folder.id ? 'opacity-50' : ''}`}
          style={{ paddingLeft: `${12 + depth * 16}px` }}
          onClick={() => setViewMode('folder', folder.id)}
          onContextMenu={(e) => {
            e.preventDefault();
            setContextMenu({ folderId: folder.id, x: e.clientX, y: e.clientY });
          }}
        >
          <FolderOpen size={14} className="shrink-0 text-yellow-500" />
          {isRenaming ? (
            <input
              type="text"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleRenameFolder();
                if (e.key === 'Escape') { setRenamingFolderId(null); setRenameValue(''); }
              }}
              onBlur={handleRenameFolder}
              onClick={(e) => e.stopPropagation()}
              autoFocus
              className="flex-1 min-w-0 px-1 py-0 text-sm bg-gray-800 border border-gray-700 rounded text-gray-200 focus:outline-none focus:border-blue-500"
            />
          ) : (
            <span className="truncate flex-1 text-left">{folder.name}</span>
          )}
          {!isRenaming && <span className="text-xs text-gray-500">{folder.image_count ?? 0}</span>}
          {hasChildren && !isRenaming && (
            <button
              onClick={(e) => { e.stopPropagation(); toggleExpand(folder.id); }}
              className="p-0.5 -mr-0.5 hover:bg-white/10 rounded shrink-0 text-gray-500"
              aria-label={isExpanded ? 'Collapse' : 'Expand'}
            >
              {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
          )}
        </button>
      </div>
    );
  };

  return (
    <aside
      className="shrink-0 bg-gray-900 border-r border-gray-800 flex flex-col h-full overflow-hidden relative"
      style={{ width: sidebarWidth }}
    >
      <div className="px-3 py-2">
        <h1 className="text-sm font-semibold text-gray-200 px-2">Muse</h1>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-2 space-y-0.5">
        {/* Quick filters */}
        <button
          className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm rounded-md transition-colors
            ${viewMode === 'all' ? 'bg-blue-600/20 text-blue-400' : 'text-gray-300 hover:bg-white/5'}`}
          onClick={() => setViewMode('all')}
        >
          <Images size={14} />
          <span className="flex-1 text-left">All</span>
          <span className="text-xs text-gray-500">{counts.total}</span>
        </button>

        <button
          className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm rounded-md transition-colors
            ${viewMode === 'uncategorized' ? 'bg-blue-600/20 text-blue-400' : 'text-gray-300 hover:bg-white/5'}`}
          onClick={() => setViewMode('uncategorized')}
        >
          <Inbox size={14} />
          <span className="flex-1 text-left">Uncategorized</span>
          <span className="text-xs text-gray-500">{counts.uncategorized}</span>
        </button>

        <button
          className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm rounded-md transition-colors
            ${viewMode === 'untagged' ? 'bg-blue-600/20 text-blue-400' : 'text-gray-300 hover:bg-white/5'}`}
          onClick={() => setViewMode('untagged')}
        >
          <Tag size={14} />
          <span className="flex-1 text-left">Untagged</span>
          <span className="text-xs text-gray-500">{counts.untagged}</span>
        </button>

        <button
          className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm rounded-md transition-colors
            ${viewMode === 'trash' ? 'bg-blue-600/20 text-blue-400' : 'text-gray-300 hover:bg-white/5'}`}
          onClick={() => setViewMode('trash')}
          onContextMenu={(e) => {
            e.preventDefault();
            setTrashContextMenu({ x: e.clientX, y: e.clientY });
          }}
        >
          <Trash2 size={14} />
          <span className="flex-1 text-left">Trash</span>
          <span className="text-xs text-gray-500">{counts.trashed}</span>
        </button>

        {/* Folders */}
        <div className="pt-4">
          <div className="flex items-center justify-between px-3 pb-1">
            <button
              onClick={toggleFolders}
              className="flex items-center gap-1 text-xs font-medium text-gray-500 uppercase tracking-wider hover:text-gray-300"
            >
              Folders
              <ChevronDown
                size={12}
                className="transition-transform duration-200 ease-out"
                style={{ transform: foldersCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}
              />
            </button>
            <button
              onClick={() => setIsCreatingFolder(true)}
              className="p-0.5 -mr-1.5 text-gray-500 hover:text-gray-300 rounded"
            >
              <Plus size={14} />
            </button>
          </div>

          {!foldersCollapsed && (
            <div
              className="cascade-in"
              style={{
                ['--total-rows' as string]: visibleFolderCount(),
                ['--cascade-stagger' as string]: `${cascadeStagger(visibleFolderCount())}ms`,
              }}
            >
              {isCreatingFolder && (
                <div className="px-3 py-1">
                  <input
                    type="text"
                    value={newFolderName}
                    onChange={(e) => setNewFolderName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleCreateFolder();
                      if (e.key === 'Escape') setIsCreatingFolder(false);
                    }}
                    onBlur={handleCreateFolder}
                    autoFocus
                    placeholder="Folder name..."
                    className="w-full px-2 py-1 text-sm bg-gray-800 border border-gray-700 rounded text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500"
                  />
                </div>
              )}

              {(() => {
                // Flatten the folder tree to a render list with stable cascade indices so nested
                // expanded children stagger after their parents.
                const flat: Array<{ folder: Folder; depth: number }> = [];
                const walk = (parentId: string | null, depth: number) => {
                  for (const f of orderedSiblings(parentId)) {
                    flat.push({ folder: f, depth });
                    if (expandedFolders.has(f.id)) walk(f.id, depth + 1);
                  }
                };
                walk(null, 0);
                return flat.map(({ folder, depth }, i) => renderFolder(folder, depth, i));
              })()}
            </div>
          )}
        </div>

        {/* Tags */}
        <div className="pt-4">
          <div className="px-3 pb-1">
            <button
              onClick={toggleTags}
              className="flex items-center gap-1 text-xs font-medium text-gray-500 uppercase tracking-wider hover:text-gray-300"
            >
              Tags
              <ChevronDown
                size={12}
                className="transition-transform duration-200 ease-out"
                style={{ transform: tagsCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}
              />
            </button>
          </div>
          {!tagsCollapsed && (
            <div
              className="cascade-in"
              style={{
                ['--total-rows' as string]: tags.length,
                // Match the folders section's per-row stagger so the two sections feel identical.
                ['--cascade-stagger' as string]: `${cascadeStagger(visibleFolderCount())}ms`,
              }}
            >
              {tags.map((tag, i) => (
                <button
                  key={tag.id}
                  className={`cascade-row w-full flex items-center gap-2 px-3 py-1.5 text-sm rounded-md transition-colors
                    ${viewMode === 'tag' && selectedTagId === tag.id ? 'bg-blue-600/20 text-blue-400' : 'text-gray-300 hover:bg-white/5'}`}
                  style={{ ['--row-index' as string]: i }}
                  onClick={() => setViewMode('tag', tag.id)}
                >
                  <span
                    className="w-2.5 h-2.5 rounded-full shrink-0"
                    style={{ backgroundColor: tag.color ?? '#6b7280' }}
                  />
                  <span className="truncate flex-1 text-left">{tag.name}</span>
                  <span className="text-xs text-gray-500">{tag.image_count ?? 0}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </nav>

      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-50 bg-gray-800 border border-gray-700 rounded-lg shadow-xl py-1 min-w-[140px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left text-gray-300 hover:bg-gray-700 transition-colors"
            onClick={() => {
              const folder = folders.find((f) => f.id === contextMenu.folderId);
              if (folder) {
                setRenamingFolderId(folder.id);
                setRenameValue(folder.name);
              }
              setContextMenu(null);
            }}
          >
            <Pencil size={12} className="shrink-0" />
            <span className="flex-1">Rename</span>
          </button>
          <button
            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left text-red-400 hover:bg-gray-700 transition-colors"
            onClick={() => {
              deleteFolder(contextMenu.folderId);
              setContextMenu(null);
            }}
          >
            <Trash size={12} className="shrink-0" />
            <span className="flex-1">Delete</span>
          </button>
        </div>
      )}
      {trashContextMenu && (
        <div
          ref={trashContextMenuRef}
          className="fixed z-50 bg-gray-800 border border-gray-700 rounded-lg shadow-xl py-1 min-w-[160px]"
          style={{ left: trashContextMenu.x, top: trashContextMenu.y }}
        >
          <button
            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left text-gray-300 hover:bg-gray-700 transition-colors"
            onClick={async () => {
              await api.restoreAllTrashed();
              refreshAll();
              setTrashContextMenu(null);
            }}
          >
            <span className="flex-1">Restore All</span>
          </button>
          <button
            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left text-red-400 hover:bg-gray-700 transition-colors"
            onClick={async () => {
              await api.emptyTrash();
              refreshAll();
              setTrashContextMenu(null);
            }}
          >
            <span className="flex-1">Empty Trash</span>
          </button>
        </div>
      )}
      {/* Resize handle: 4px-wide invisible strip on the right edge that becomes a 1px hairline
          highlight on hover. Captures mousedown to start drag-to-resize. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        onMouseDown={startResize}
        className="absolute top-0 right-0 h-full w-1 cursor-col-resize hover:bg-blue-500/40 active:bg-blue-500/60 z-10"
      />
    </aside>
  );
}
