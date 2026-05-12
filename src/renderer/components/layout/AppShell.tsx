import { useEffect, useState } from 'react';
import { Sidebar } from '../sidebar/Sidebar';
import { ContentGrid } from '../grid/ContentGrid';
import { DetailPanel } from '../detail/DetailPanel';
import { ImageFocus } from '../grid/ImageFocus';
import { useAppStore } from '../../stores/app-store';
import { api } from '../../lib/ipc';

export function AppShell() {
  const { selectedImageId, theme, refreshAll, fetchSimilarImages } = useAppStore();
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    let dragCounter = 0;

    const isExternalDrag = (e: DragEvent) => {
      const types = e.dataTransfer?.types;
      if (!types) return false;
      if (types.includes('application/x-muse-image')) return false;
      // Local file drag, browser image drag (uri-list / html / x-moz-url), or pasted URL string.
      return (
        types.includes('Files') ||
        types.includes('text/uri-list') ||
        types.includes('text/x-moz-url') ||
        types.includes('text/html')
      );
    };

    const handleDragEnter = (e: DragEvent) => {
      e.preventDefault();
      if (!isExternalDrag(e)) return;
      dragCounter++;
      setIsDragging(true);
    };

    const handleDragLeave = (e: DragEvent) => {
      e.preventDefault();
      if (!isDragging) return;
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        setIsDragging(false);
      }
    };

    const handleDragOver = (e: DragEvent) => {
      e.preventDefault();
    };

    const handleDrop = (e: DragEvent) => {
      e.preventDefault();
      dragCounter = 0;
      setIsDragging(false);
    };

    const isEditableTarget = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
      return target.isContentEditable;
    };

    const handlePaste = async (e: ClipboardEvent) => {
      if (isEditableTarget(e.target)) return;
      const cd = e.clipboardData;
      if (!cd) return;

      // 1) Image bytes on the clipboard (e.g. screenshot, "Copy Image" from browser).
      const items = Array.from(cd.items);
      const imageItem = items.find((it) => it.kind === 'file' && it.type.startsWith('image/'));
      if (imageItem) {
        const file = imageItem.getAsFile();
        if (file) {
          e.preventDefault();
          const buffer = await file.arrayBuffer();
          const filename = file.name && file.name !== 'image.png'
            ? file.name
            : `clipboard-${Date.now()}.${file.type.split('/')[1] || 'png'}`;
          await window.electronAPI.importBuffer(buffer, filename, null);
          refreshAll();
          return;
        }
      }

      // 2) URL on the clipboard.
      const text = cd.getData('text/plain').trim();
      if (text && (/^https?:\/\//i.test(text) || text.startsWith('data:'))) {
        e.preventDefault();
        await window.electronAPI.importUrl(text, null);
        refreshAll();
      }
    };

    document.addEventListener('dragenter', handleDragEnter);
    document.addEventListener('dragleave', handleDragLeave);
    document.addEventListener('dragover', handleDragOver);
    document.addEventListener('drop', handleDrop);
    document.addEventListener('paste', handlePaste);

    const cleanup = api.onFilesImported(() => {
      refreshAll();
    });

    return () => {
      document.removeEventListener('dragenter', handleDragEnter);
      document.removeEventListener('dragleave', handleDragLeave);
      document.removeEventListener('dragover', handleDragOver);
      document.removeEventListener('drop', handleDrop);
      document.removeEventListener('paste', handlePaste);
      cleanup();
    };
  }, [refreshAll]);

  useEffect(() => {
    fetchSimilarImages(selectedImageId ?? null);
  }, [selectedImageId, fetchSimilarImages]);

  return (
    <div className={`h-screen flex overflow-hidden ${theme === 'dark' ? 'dark' : ''}`}>
      <Sidebar />
      <div className="flex-1 relative min-w-0 overflow-hidden">
        <ContentGrid />
        {selectedImageId && <ImageFocus />}
      </div>
      <DetailPanel />
      {isDragging && (
        <div className="fixed inset-0 bg-blue-500/10 border-2 border-dashed border-blue-500 z-50 flex items-center justify-center pointer-events-none">
          <div className="bg-gray-900 px-6 py-4 rounded-xl border border-blue-500 shadow-2xl">
            <p className="text-blue-400 text-sm font-medium">Drop images to import</p>
          </div>
        </div>
      )}
    </div>
  );
}
