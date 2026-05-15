import { useEffect, useState, useRef } from 'react';
import { X, Trash2, RotateCcw, Plus, Pencil } from 'lucide-react';
import { useAppStore, type ImageRecord, type ImageColor } from '../../stores/app-store';
import { api } from '../../lib/ipc';

interface TagWithMeta {
  id: string;
  name: string;
  color: string | null;
  is_auto: number;
}

export function DetailPanel() {
  const {
    selectedImageId,
    setSelectedImage,
    trashImage,
    restoreImage,
    deleteImage,
    updateImage,
    tags: allTags,
    loadTags,
    isClosingFocus,
    detailRefreshNonce,
  } = useAppStore();
  const [image, setImage] = useState<ImageRecord | null>(null);
  const [colors, setColors] = useState<ImageColor[]>([]);
  const [tags, setTags] = useState<TagWithMeta[]>([]);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleValue, setTitleValue] = useState('');
  const [editingAlt, setEditingAlt] = useState(false);
  const [altValue, setAltValue] = useState('');
  const [showTagInput, setShowTagInput] = useState(false);
  const [tagInputValue, setTagInputValue] = useState('');
  const tagInputRef = useRef<HTMLInputElement>(null);
  const [visible, setVisible] = useState(false);
  const [mounted, setMounted] = useState(false);
  const lastImageRef = useRef<ImageRecord | null>(null);
  const lastColorsRef = useRef<ImageColor[]>([]);
  const lastTagsRef = useRef<TagWithMeta[]>([]);

  useEffect(() => {
    if (selectedImageId && !isClosingFocus) {
      setMounted(true);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setVisible(true));
      });
    } else {
      setVisible(false);
    }
  }, [selectedImageId, isClosingFocus]);

  useEffect(() => {
    if (!selectedImageId) return;
    api.getImage(selectedImageId).then((img: ImageRecord | null) => {
      setImage(img);
      lastImageRef.current = img;
    });
    api.getColorsForImage(selectedImageId).then((c: ImageColor[]) => {
      setColors(c);
      lastColorsRef.current = c;
    });
    api.getTagsForImage(selectedImageId).then((t: TagWithMeta[]) => {
      setTags(t);
      lastTagsRef.current = t;
    });
  }, [selectedImageId, detailRefreshNonce]);

  const handleTransitionEnd = () => {
    if (!visible) setMounted(false);
  };

  const displayImage = image || lastImageRef.current;
  const displayColors = colors.length > 0 ? colors : lastColorsRef.current;
  const displayTags = tags.length > 0 || image ? tags : lastTagsRef.current;

  const handleTitleSave = () => {
    if (!displayImage) return;
    if (titleValue.trim() !== displayImage.title) {
      updateImage(displayImage.id, { title: titleValue.trim() });
      const updated = { ...displayImage, title: titleValue.trim() };
      setImage(updated);
      lastImageRef.current = updated;
    }
    setEditingTitle(false);
  };

  const handleAltSave = () => {
    if (!displayImage) return;
    if (altValue.trim() !== (displayImage.alt_text || '')) {
      updateImage(displayImage.id, { alt_text: altValue.trim() } as Partial<ImageRecord>);
      const updated = { ...displayImage, alt_text: altValue.trim() };
      setImage(updated);
      lastImageRef.current = updated;
    }
    setEditingAlt(false);
  };

  const formatFileSize = (bytes: number | null): string => {
    if (!bytes) return 'Unknown';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  if (!mounted || !displayImage) return null;

  return (
    <aside
      className={`shrink-0 w-72 bg-gray-900 border-l border-gray-800 flex flex-col h-full overflow-hidden transition-all ${visible ? 'translate-x-0' : 'translate-x-full -mr-72'}`}
      style={{ transitionTimingFunction: 'cubic-bezier(0.2, 0.9, 0.3, 1)', transitionDuration: '350ms' }}
      onTransitionEnd={handleTransitionEnd}
    >
      <div className="h-12 shrink-0 flex items-center justify-between px-4 border-b border-gray-800">
        <span className="text-xs text-gray-400 uppercase tracking-wider font-medium">Details</span>
        <button onClick={() => setSelectedImage(null)} className="text-gray-500 hover:text-gray-300">
          <X size={14} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto pt-3">
        {displayColors.length > 0 && (
          <div className="px-4 pb-3 flex items-center gap-1.5">
            {displayColors.map((color) => (
              <span
                key={color.id}
                className="w-5 h-5 rounded-full border border-gray-700"
                style={{ backgroundColor: color.hex_color }}
                title={color.hex_color}
              />
            ))}
          </div>
        )}

        <div className="px-4 pb-3">
          {editingTitle ? (
            <input
              type="text"
              value={titleValue}
              onChange={(e) => setTitleValue(e.target.value)}
              onBlur={handleTitleSave}
              onKeyDown={(e) => { if (e.key === 'Enter') handleTitleSave(); }}
              autoFocus
              className="w-full px-2 py-1 text-sm bg-gray-800 border border-gray-700 rounded text-gray-200 focus:outline-none focus:border-blue-500"
            />
          ) : (
            <p
              className="text-sm text-gray-200 cursor-pointer hover:text-white truncate"
              title={displayImage.title || 'Untitled'}
              onClick={() => { setEditingTitle(true); setTitleValue(displayImage.title); }}
            >
              {displayImage.title || 'Untitled'}
            </p>
          )}
        </div>

        <div className="px-4 pb-3">
          <div className="flex items-center justify-between mb-1">
            <p className="text-xs text-gray-500">Alt text</p>
            <button
              onClick={() => { setEditingAlt(true); setAltValue(displayImage.alt_text || ''); }}
              className="p-0.5 text-gray-500 hover:text-gray-300 rounded"
            >
              <Pencil size={12} />
            </button>
          </div>
          {editingAlt ? (
            <textarea
              value={altValue}
              onChange={(e) => setAltValue(e.target.value)}
              onBlur={handleAltSave}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAltSave(); } }}
              autoFocus
              rows={2}
              className="w-full px-2 py-1 text-xs bg-gray-800 border border-gray-700 rounded text-gray-200 focus:outline-none focus:border-blue-500 resize-none"
            />
          ) : (
            <p className="text-xs text-gray-400 italic">
              {displayImage.alt_text || 'No alt text'}
            </p>
          )}
        </div>

        <div className="px-4 pb-3">
          <div className="flex items-center justify-between mb-1.5">
            <p className="text-xs text-gray-500">Tags</p>
            <button
              onClick={() => { setShowTagInput(true); setTimeout(() => tagInputRef.current?.focus(), 0); }}
              className="p-0.5 text-gray-500 hover:text-gray-300 rounded"
            >
              <Plus size={12} />
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {displayTags.map((tag) => (
              <span
                key={tag.id}
                className="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-gray-800 text-gray-300 rounded-full border border-gray-700 group"
              >
                {tag.name}
                <button
                  onClick={async () => {
                    await api.removeTagFromImage(displayImage.id, tag.id);
                    const updated = tags.filter((t) => t.id !== tag.id);
                    setTags(updated);
                    lastTagsRef.current = updated;
                    loadTags();
                  }}
                  className="text-gray-600 hover:text-red-400 hidden group-hover:inline"
                >
                  <X size={10} />
                </button>
              </span>
            ))}
          </div>
          {showTagInput && (
            <div className="mt-2 relative">
              <input
                ref={tagInputRef}
                type="text"
                value={tagInputValue}
                onChange={(e) => setTagInputValue(e.target.value)}
                onKeyDown={async (e) => {
                  if (e.key === 'Enter' && tagInputValue.trim()) {
                    const name = tagInputValue.trim();
                    let tag = allTags.find((t) => t.name.toLowerCase() === name.toLowerCase());
                    if (!tag) {
                      tag = await api.createTag(name);
                    }
                    if (!tags.find((t) => t.id === tag!.id)) {
                      await api.addTagToImage(displayImage.id, tag!.id);
                      const updated = [...tags, { id: tag!.id, name: tag!.name, color: tag!.color, is_auto: 0 }];
                      setTags(updated);
                      lastTagsRef.current = updated;
                    }
                    setTagInputValue('');
                    loadTags();
                  }
                  if (e.key === 'Escape') {
                    setShowTagInput(false);
                    setTagInputValue('');
                  }
                }}
                onBlur={() => { setShowTagInput(false); setTagInputValue(''); }}
                placeholder="Add tag..."
                className="w-full px-2 py-1 text-xs bg-gray-800 border border-gray-700 rounded text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500"
              />
              {tagInputValue && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-gray-800 border border-gray-700 rounded-md shadow-lg z-10 max-h-32 overflow-y-auto">
                  {allTags
                    .filter((t) => t.name.toLowerCase().includes(tagInputValue.toLowerCase()) && !tags.find((et) => et.id === t.id))
                    .slice(0, 8)
                    .map((t) => (
                      <button
                        key={t.id}
                        className="w-full px-2 py-1 text-xs text-left text-gray-300 hover:bg-gray-700"
                        onMouseDown={async (e) => {
                          e.preventDefault();
                          await api.addTagToImage(displayImage.id, t.id);
                          const updated = [...tags, { id: t.id, name: t.name, color: t.color, is_auto: 0 }];
                          setTags(updated);
                          lastTagsRef.current = updated;
                          setTagInputValue('');
                          setShowTagInput(false);
                          loadTags();
                        }}
                      >
                        {t.name}
                      </button>
                    ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="px-4 pb-3">
          <p className="text-xs text-gray-500 mb-1.5">Properties</p>
          <div className="space-y-1 text-xs">
            {displayImage.width && displayImage.height && (
              <div className="flex justify-between text-gray-400">
                <span>Dimensions</span>
                <span className="text-gray-300">{displayImage.width} x {displayImage.height}</span>
              </div>
            )}
            <div className="flex justify-between text-gray-400">
              <span>Size</span>
              <span className="text-gray-300">{formatFileSize(displayImage.file_size)}</span>
            </div>
            <div className="flex justify-between text-gray-400">
              <span>Type</span>
              <span className="text-gray-300 uppercase">{displayImage.file_type}</span>
            </div>
            <div className="flex justify-between text-gray-400">
              <span>Imported</span>
              <span className="text-gray-300">{new Date(displayImage.imported_at).toLocaleDateString()}</span>
            </div>
          </div>
        </div>

        <div className="px-4 pb-4 space-y-2">
          {displayImage.is_trashed ? (
            <>
              <button
                onClick={() => restoreImage(displayImage.id)}
                className="flex items-center gap-2 px-3 py-1.5 text-xs bg-green-900/30 text-green-400 hover:bg-green-900/50 rounded-md w-full justify-center"
              >
                <RotateCcw size={12} /> Restore
              </button>
              <button
                onClick={() => deleteImage(displayImage.id)}
                className="flex items-center gap-2 px-3 py-1.5 text-xs bg-red-900/30 text-red-400 hover:bg-red-900/50 rounded-md w-full justify-center"
              >
                <Trash2 size={12} /> Delete permanently
              </button>
            </>
          ) : (
            <button
              onClick={() => trashImage(displayImage.id)}
              className="flex items-center gap-2 px-3 py-1.5 text-xs bg-red-900/30 text-red-400 hover:bg-red-900/50 rounded-md w-full justify-center"
            >
              <Trash2 size={12} /> Move to Trash
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}
