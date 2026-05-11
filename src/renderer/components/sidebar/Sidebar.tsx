import { useState, useEffect, useRef } from 'react';
import { Images, Tag, Trash2, FolderOpen, Plus, ChevronRight, ChevronDown, Inbox, Pencil, Trash } from 'lucide-react';
import { useAppStore, type Folder } from '../../stores/app-store';
import { api } from '../../lib/ipc';

export function Sidebar() {
  const { folders, tags, counts, viewMode, selectedFolderId, selectedTagId, setViewMode, createFolder, deleteFolder, refreshAll, draggingImageId, selectedImageIds, bulkMoveToFolder } = useAppStore();
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ folderId: string; x: number; y: number } | null>(null);
  const [trashContextMenu, setTrashContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const trashContextMenuRef = useRef<HTMLDivElement>(null);

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

  const rootFolders = folders.filter((f) => f.parent_id === null);

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

  const getChildren = (parentId: string): Folder[] =>
    folders.filter((f) => f.parent_id === parentId);

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

  const renderFolder = (folder: Folder, depth = 0) => {
    const children = getChildren(folder.id);
    const hasChildren = children.length > 0;
    const isExpanded = expandedFolders.has(folder.id);
    const isSelected = viewMode === 'folder' && selectedFolderId === folder.id;
    const isDropTarget = dropTargetId === folder.id;
    const isRenaming = renamingFolderId === folder.id;

    return (
      <div
        key={folder.id}
        onDrop={(e) => handleFolderDrop(e, folder.id)}
        onDragOver={(e) => handleFolderDragOver(e, folder.id)}
        onDragLeave={handleFolderDragLeave}
      >
        <button
          className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm rounded-md transition-colors
            ${isDropTarget ? 'bg-blue-600/30 text-blue-300 ring-1 ring-blue-500' : isSelected ? 'bg-blue-600/20 text-blue-400' : 'text-gray-300 hover:bg-white/5'}`}
          style={{ paddingLeft: `${12 + depth * 16}px` }}
          onClick={() => setViewMode('folder', folder.id)}
          onContextMenu={(e) => {
            e.preventDefault();
            setContextMenu({ folderId: folder.id, x: e.clientX, y: e.clientY });
          }}
        >
          {hasChildren ? (
            <button
              onClick={(e) => { e.stopPropagation(); toggleExpand(folder.id); }}
              className="p-0.5 hover:bg-white/10 rounded"
            >
              {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
          ) : (
            <span className="w-4" />
          )}
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
        </button>
        {isExpanded && children.map((child) => renderFolder(child, depth + 1))}
      </div>
    );
  };

  return (
    <aside className="w-60 shrink-0 bg-gray-900 border-r border-gray-800 flex flex-col h-full overflow-hidden">
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
            <span className="text-xs font-medium text-gray-500 uppercase tracking-wider">Folders</span>
            <button
              onClick={() => setIsCreatingFolder(true)}
              className="p-0.5 text-gray-500 hover:text-gray-300 rounded"
            >
              <Plus size={14} />
            </button>
          </div>

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

          {rootFolders.map((folder) => renderFolder(folder))}
        </div>

        {/* Tags */}
        <div className="pt-4">
          <div className="px-3 pb-1">
            <span className="text-xs font-medium text-gray-500 uppercase tracking-wider">Tags</span>
          </div>
          {tags.map((tag) => (
            <button
              key={tag.id}
              className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm rounded-md transition-colors
                ${viewMode === 'tag' && selectedTagId === tag.id ? 'bg-blue-600/20 text-blue-400' : 'text-gray-300 hover:bg-white/5'}`}
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
    </aside>
  );
}
