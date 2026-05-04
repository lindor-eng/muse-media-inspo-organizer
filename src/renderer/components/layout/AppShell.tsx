import { useEffect, useState } from 'react';
import { Sidebar } from '../sidebar/Sidebar';
import { ContentGrid } from '../grid/ContentGrid';
import { DetailPanel } from '../detail/DetailPanel';
import { ImageFocus } from '../grid/ImageFocus';
import { EmbeddingProgress } from './EmbeddingProgress';
import { useAppStore } from '../../stores/app-store';
import { api } from '../../lib/ipc';

export function AppShell() {
  const { selectedImageId, theme, refreshAll } = useAppStore();
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    let dragCounter = 0;

    const isExternalDrag = (e: DragEvent) =>
      e.dataTransfer?.types.includes('Files') && !e.dataTransfer.types.includes('application/x-muse-image');

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

    document.addEventListener('dragenter', handleDragEnter);
    document.addEventListener('dragleave', handleDragLeave);
    document.addEventListener('dragover', handleDragOver);
    document.addEventListener('drop', handleDrop);

    const cleanup = api.onFilesImported(() => {
      refreshAll();
    });

    return () => {
      document.removeEventListener('dragenter', handleDragEnter);
      document.removeEventListener('dragleave', handleDragLeave);
      document.removeEventListener('dragover', handleDragOver);
      document.removeEventListener('drop', handleDrop);
      cleanup();
    };
  }, [refreshAll]);

  return (
    <div className={`h-screen flex overflow-hidden ${theme === 'dark' ? 'dark' : ''}`}>
      <Sidebar />
      <div className="flex-1 relative min-w-0 overflow-hidden">
        <ContentGrid />
        {selectedImageId && <ImageFocus />}
      </div>
      <DetailPanel />
      <EmbeddingProgress />
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
