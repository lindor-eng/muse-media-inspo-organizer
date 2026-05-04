import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import { ArrowLeft, ZoomIn, ZoomOut } from 'lucide-react';
import { useAppStore, type ImageRecord } from '../../stores/app-store';
import { api } from '../../lib/ipc';

type Phase = 'measure' | 'initial' | 'animating' | 'done' | 'exit-start' | 'exiting';

export function ImageFocus() {
  const { selectedImageId, setSelectedImage, focusOriginRect, setClosingFocus, images } = useAppStore();
  const [image, setImage] = useState<ImageRecord | null>(null);
  const [phase, setPhase] = useState<Phase>('measure');
  const containerRef = useRef<HTMLDivElement>(null);
  const [targetRect, setTargetRect] = useState<{ x: number; y: number; width: number; height: number } | null>(null);

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const [toast, setToast] = useState(false);

  const isZoomed = zoom > 1;

  useEffect(() => {
    if (selectedImageId) {
      api.getImage(selectedImageId).then(setImage);
    }
  }, [selectedImageId]);

  useLayoutEffect(() => {
    if (!image || phase !== 'measure') return;
    if (containerRef.current && focusOriginRect && image.width && image.height) {
      const container = containerRef.current.getBoundingClientRect();
      // Account for detail panel (w-72 = 288px) that will slide in simultaneously
      const panelWidth = 288;
      const adjustedWidth = container.width - panelWidth;
      const padding = 16;
      const availW = adjustedWidth - padding * 2;
      const availH = container.height - padding * 2;
      const scale = Math.min(availW / image.width, availH / image.height, 1);
      const imgW = image.width * scale;
      const imgH = image.height * scale;
      const imgX = container.x + (adjustedWidth - imgW) / 2;
      const imgY = container.y + (container.height - imgH) / 2;
      setTargetRect({ x: imgX, y: imgY, width: imgW, height: imgH });
      setPhase('initial');
    } else if (containerRef.current && focusOriginRect) {
      const rect = containerRef.current.getBoundingClientRect();
      const panelWidth = 288;
      const adjustedWidth = rect.width - panelWidth;
      setTargetRect({ x: rect.x + 16, y: rect.y + 16, width: adjustedWidth - 32, height: rect.height - 32 });
      setPhase('initial');
    } else {
      setPhase('done');
    }
  }, [image, phase, focusOriginRect]);

  useLayoutEffect(() => {
    if (phase !== 'initial') return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setPhase('animating'));
    });
  }, [phase]);

  useEffect(() => {
    if (phase === 'animating') {
      const timer = setTimeout(() => setPhase('done'), 380);
      return () => clearTimeout(timer);
    }
  }, [phase]);

  useLayoutEffect(() => {
    if (phase !== 'exit-start') return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setPhase('exiting'));
    });
  }, [phase]);

  useEffect(() => {
    if (phase === 'exiting') {
      const timer = setTimeout(() => setSelectedImage(null), 350);
      return () => clearTimeout(timer);
    }
  }, [phase, setSelectedImage]);

  const handleClose = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    if (phase === 'done' && focusOriginRect) {
      setClosingFocus(true);
      setPhase('exit-start');
    } else {
      setSelectedImage(null);
    }
  }, [phase, focusOriginRect, setSelectedImage, setClosingFocus]);

  const navigateImage = useCallback((direction: -1 | 1) => {
    if (!selectedImageId || images.length === 0) return;
    const currentIndex = images.findIndex((img) => img.id === selectedImageId);
    if (currentIndex === -1) return;
    const nextIndex = currentIndex + direction;
    if (nextIndex < 0 || nextIndex >= images.length) return;
    const nextImage = images[nextIndex];
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setSelectedImage(nextImage.id, focusOriginRect);
    setPhase('done');
  }, [selectedImageId, images, focusOriginRect, setSelectedImage]);

  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
      if (e.key === 'ArrowLeft') { e.preventDefault(); navigateImage(-1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); navigateImage(1); }
      if ((e.metaKey || e.ctrlKey) && e.key === 'c' && image) {
        e.preventDefault();
        const success = await window.electronAPI.copyImageToClipboard(image.original_path);
        if (success) {
          setToast(true);
          setTimeout(() => setToast(false), 2000);
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleClose, image, navigateImage]);

  const handleZoomChange = (newZoom: number) => {
    const clamped = Math.max(1, Math.min(5, newZoom));
    if (clamped === 1) setPan({ x: 0, y: 0 });
    setZoom(clamped);
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (!isZoomed) return;
    e.preventDefault();
    setIsPanning(true);
    panStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isPanning) return;
    const dx = e.clientX - panStart.current.x;
    const dy = e.clientY - panStart.current.y;
    setPan({ x: panStart.current.panX + dx, y: panStart.current.panY + dy });
  };

  const handleMouseUp = () => {
    setIsPanning(false);
  };

  useEffect(() => {
    if (!isPanning) return;
    const handleUp = () => setIsPanning(false);
    document.addEventListener('mouseup', handleUp);
    return () => document.removeEventListener('mouseup', handleUp);
  }, [isPanning]);

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const delta = -e.deltaY * 0.005;
    handleZoomChange(zoom + delta);
  };

  if (!image) return null;

  const src = `local-file://${image.original_path}`;

  const getImgStyle = (): React.CSSProperties => {
    if (phase === 'initial' && focusOriginRect) {
      return {
        position: 'fixed',
        left: focusOriginRect.x,
        top: focusOriginRect.y,
        width: focusOriginRect.width,
        height: focusOriginRect.height,
        borderRadius: '8px',
        objectFit: 'cover',
        zIndex: 70,
      };
    }
    if (phase === 'animating' && targetRect) {
      return {
        position: 'fixed',
        left: targetRect.x,
        top: targetRect.y,
        width: targetRect.width,
        height: targetRect.height,
        transition: 'all 350ms cubic-bezier(0.2, 0.9, 0.3, 1)',
        borderRadius: '8px',
        objectFit: 'contain',
        zIndex: 70,
      };
    }
    if (phase === 'exit-start' && targetRect) {
      return {
        position: 'fixed',
        left: targetRect.x,
        top: targetRect.y,
        width: targetRect.width,
        height: targetRect.height,
        borderRadius: '8px',
        objectFit: 'contain',
        zIndex: 70,
      };
    }
    if (phase === 'exiting' && focusOriginRect) {
      return {
        position: 'fixed',
        left: focusOriginRect.x,
        top: focusOriginRect.y,
        width: focusOriginRect.width,
        height: focusOriginRect.height,
        transition: 'all 350ms cubic-bezier(0.2, 0.9, 0.3, 1)',
        borderRadius: '8px',
        objectFit: 'cover',
        zIndex: 70,
      };
    }
    return {};
  };

  const isExiting = phase === 'exit-start' || phase === 'exiting';
  const showOverlay = phase === 'initial' || phase === 'animating' || isExiting;
  const showBg = !isExiting;

  return (
    <main className={`absolute inset-0 flex flex-col z-40 transition-opacity duration-200 ${isExiting ? 'opacity-0 pointer-events-none' : 'bg-gray-950'}`}>
      {showBg && (
        <header className={`h-12 shrink-0 flex items-center gap-3 px-4 border-b border-gray-800 transition-opacity duration-300 ${phase === 'done' || phase === 'animating' ? 'opacity-100' : 'opacity-0'}`}>
          <button
            onClick={handleClose}
            className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-200 transition-colors"
          >
            <ArrowLeft size={14} />
            Back
          </button>
          <span className="text-sm text-gray-300 truncate">{image.title || image.filename}</span>

          <div className="flex-1" />

          <div className="flex items-center gap-2">
            <ZoomOut size={14} className="text-gray-500" />
            <input
              type="range"
              min="1"
              max="5"
              step="0.1"
              value={zoom}
              onChange={(e) => handleZoomChange(parseFloat(e.target.value))}
              className="w-24 h-1 accent-blue-500 cursor-pointer"
            />
            <ZoomIn size={14} className="text-gray-500" />
            <span className="text-xs text-gray-500 w-10 text-right">{Math.round(zoom * 100)}%</span>
          </div>
        </header>
      )}
      <div
        ref={containerRef}
        className={`flex-1 flex items-center justify-center p-4 overflow-hidden ${isZoomed ? (isPanning ? 'cursor-grabbing' : 'cursor-grab') : ''}`}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onWheel={handleWheel}
      >
        {phase === 'done' && (
          <img
            src={src}
            alt={image.title || image.filename}
            className="max-w-full max-h-full object-contain rounded-lg select-none"
            draggable={false}
            style={{
              transform: `scale(${zoom}) translate(${pan.x / zoom}px, ${pan.y / zoom}px)`,
              transition: isPanning ? 'none' : 'transform 150ms ease-out',
            }}
          />
        )}
      </div>
      {showOverlay && (
        <img
          src={src}
          alt={image.title || image.filename}
          style={getImgStyle()}
        />
      )}
      {toast && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg shadow-xl text-sm text-gray-200 animate-fade-in">
          Copied to clipboard
        </div>
      )}
    </main>
  );
}
