import { useEffect, useState } from 'react';
import { Sidebar } from '../sidebar/Sidebar';
import { ContentGrid } from '../grid/ContentGrid';
import { DetailPanel } from '../detail/DetailPanel';
import { ImageFocus } from '../grid/ImageFocus';
import { LibraryExport } from './LibraryExport';
import { LibraryImportDialog } from './LibraryImportDialog';
import { useAppStore } from '../../stores/app-store';
import { api } from '../../lib/ipc';

export function AppShell() {
  const { selectedImageId, theme, refreshAll, fetchSimilarImages, importFiles } = useAppStore();
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
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

    // Use a timeout watchdog instead of an enter/leave counter. dragover fires continuously while
    // a drag hovers anywhere over the window; if it stops firing for >180ms we know the drag has
    // ended (released outside the window, switched apps, etc.) and we can safely hide the overlay.
    // The counter approach got stuck whenever a dragleave was dropped — common when releasing over
    // window chrome or other apps.
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    const armWatchdog = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        setIsDragging(false);
        watchdog = null;
      }, 180);
    };
    const clearOverlay = () => {
      if (watchdog) { clearTimeout(watchdog); watchdog = null; }
      setIsDragging(false);
    };

    const handleDragEnter = (e: DragEvent) => {
      e.preventDefault();
      if (!isExternalDrag(e)) return;
      setIsDragging(true);
      armWatchdog();
    };

    const handleDragOver = (e: DragEvent) => {
      e.preventDefault();
      if (!isExternalDrag(e)) return;
      setIsDragging(true);
      armWatchdog();
    };

    const handleDragLeave = (e: DragEvent) => {
      e.preventDefault();
      // Only treat dragleave as a real exit when it happens at the window's edge — child-to-child
      // transitions inside the document also fire dragleave but the watchdog will keep the overlay up.
      if (e.relatedTarget === null) clearOverlay();
    };

    const handleDrop = (e: DragEvent) => {
      e.preventDefault();
      clearOverlay();
    };

    // Belt-and-suspenders: window-level cleanup for cases where dragend bubbles up.
    const handleWindowDragEnd = () => clearOverlay();
    const handleWindowBlur = () => clearOverlay();

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

    // Manual escape hatch — pressing Escape always clears the overlay even if the watchdog missed it.
    // Also: +/- adjust the grid thumbnail size when no input is focused and ImageFocus isn't open
    // (in focus mode +/- belong to the zoom slider).
    const THUMB_KEY_STEP = 24;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') clearOverlay();
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isEditableTarget(e.target)) return;
      if (useAppStore.getState().selectedImageId) return;

      // Both '+' (Shift+=) and the bare '=' bump up; '-' bumps down.
      const isPlus = e.key === '+' || e.key === '=';
      const isMinus = e.key === '-' || e.key === '_';
      if (!isPlus && !isMinus) return;
      e.preventDefault();
      const { gridThumbHeight, setGridThumbHeight } = useAppStore.getState();
      setGridThumbHeight(gridThumbHeight + (isPlus ? THUMB_KEY_STEP : -THUMB_KEY_STEP));
    };

    document.addEventListener('dragenter', handleDragEnter);
    document.addEventListener('dragleave', handleDragLeave);
    document.addEventListener('dragover', handleDragOver);
    document.addEventListener('drop', handleDrop);
    document.addEventListener('paste', handlePaste);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('dragend', handleWindowDragEnd);
    window.addEventListener('blur', handleWindowBlur);

    const cleanup = api.onFilesImported(() => {
      refreshAll();
    });

    return () => {
      document.removeEventListener('dragenter', handleDragEnter);
      document.removeEventListener('dragleave', handleDragLeave);
      document.removeEventListener('dragover', handleDragOver);
      document.removeEventListener('drop', handleDrop);
      document.removeEventListener('paste', handlePaste);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('dragend', handleWindowDragEnd);
      window.removeEventListener('blur', handleWindowBlur);
      if (watchdog) clearTimeout(watchdog);
      cleanup();
    };
  }, [refreshAll]);

  useEffect(() => {
    fetchSimilarImages(selectedImageId ?? null);
  }, [selectedImageId, fetchSimilarImages]);

  // File → Import Files… opens the existing system file picker and feeds importFiles.
  useEffect(() => {
    return api.onMenuEvent('menu:importFiles', async () => {
      const filePaths = await window.electronAPI.openFileDialog();
      if (filePaths.length > 0) await importFiles(filePaths);
    });
  }, [importFiles]);

  return (
    <div className={`h-screen flex overflow-hidden ${theme === 'dark' ? 'dark' : ''}`}>
      <Sidebar />
      <div className="flex-1 relative min-w-0 overflow-hidden">
        <ContentGrid />
        {selectedImageId && <ImageFocus />}
      </div>
      <DetailPanel />
      <LibraryExport />
      <LibraryImportDialog />
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
