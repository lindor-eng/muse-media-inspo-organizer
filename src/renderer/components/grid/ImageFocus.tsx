import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import { ArrowLeft, ZoomIn, ZoomOut } from 'lucide-react';
import { useAppStore, type ImageRecord } from '../../stores/app-store';
import { api } from '../../lib/ipc';
import { SimilarImagesStrip } from '../detail/SimilarImagesStrip';
import { SimilarityInspectorPopover } from '../detail/SimilarityInspectorPopover';

type Phase = 'measure' | 'initial' | 'animating' | 'done' | 'exit-start' | 'exiting';

export function ImageFocus() {
  const {
    selectedImageId,
    setSelectedImage,
    focusOriginRect,
    setClosingFocus,
    images,
    similarImages,
    isFetchingSimilar,
    similarEmptyHint,
    similarFetchEmbedBaseline,
    similarMatchesMeta,
    similarityPrefs,
    saveSimilarityPrefsAndRefresh,
    similarNavStack,
    similarNavGoBack,
    similarRefineMode,
    setSimilarRefineMode,
  } = useAppStore();
  const [clipSidecar, setClipSidecar] = useState<boolean | null>(null);
  const [image, setImage] = useState<ImageRecord | null>(null);
  const [phase, setPhase] = useState<Phase>('measure');
  const containerRef = useRef<HTMLDivElement>(null);
  const [targetRect, setTargetRect] = useState<{ x: number; y: number; width: number; height: number } | null>(null);

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const stripAnchorRef = useRef<HTMLDivElement>(null);
  const [similarInspectorOpen, setSimilarInspectorOpen] = useState(false);
  const [toast, setToast] = useState(false);

  const isZoomed = zoom > 1;
  const similarNavBackPeek = similarNavStack[similarNavStack.length - 1] ?? null;

  useEffect(() => {
    if (selectedImageId) {
      api.getImage(selectedImageId).then(setImage);
    }
  }, [selectedImageId]);

  useEffect(() => {
    if (!selectedImageId) {
      setClipSidecar(null);
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const s = (await api.getAIStatus()) as { sidecar?: boolean };
        if (!cancelled) setClipSidecar(Boolean(s?.sidecar));
      } catch {
        if (!cancelled) setClipSidecar(null);
      }
    };
    poll();
    const tid = window.setInterval(poll, 9000);
    return () => {
      cancelled = true;
      window.clearInterval(tid);
    };
  }, [selectedImageId]);

  useEffect(() => {
    if (!similarInspectorOpen) return;
    const handleDown = (e: MouseEvent) => {
      if (stripAnchorRef.current?.contains(e.target as Node)) return;
      setSimilarInspectorOpen(false);
    };
    document.addEventListener('mousedown', handleDown);
    return () => document.removeEventListener('mousedown', handleDown);
  }, [similarInspectorOpen]);

  useEffect(() => {
    setSimilarInspectorOpen(false);
  }, [selectedImageId]);

  const computeTargetRect = useCallback((containerEl: HTMLElement, imgW: number, imgH: number, panelOffset = 0, stripOffset = 0) => {
    const container = containerEl.getBoundingClientRect();
    const padding = 16;
    const w = container.width - panelOffset;
    const h = container.height - stripOffset;
    const availW = w - padding * 2;
    const availH = h - padding * 2;
    const scale = Math.min(availW / imgW, availH / imgH);
    const finalW = imgW * scale;
    const finalH = imgH * scale;
    const x = container.x + (w - finalW) / 2;
    const y = container.y + (availH - finalH) / 2 + padding;
    return { x, y, width: finalW, height: finalH };
  }, []);

  useLayoutEffect(() => {
    if (!image || phase !== 'measure') return;
    if (containerRef.current && focusOriginRect && image.width && image.height) {
      // Panel uses -mr-72 when hidden so container is 288px wider than final state
      // Strip has h-[130px] so it already takes layout space — no height offset needed
      setTargetRect(computeTargetRect(containerRef.current, image.width, image.height, 288));
      setPhase('initial');
    } else if (containerRef.current && focusOriginRect) {
      const container = containerRef.current.getBoundingClientRect();
      const w = container.width - 288;
      setTargetRect({ x: container.x + 16, y: container.y + 16, width: w - 32, height: container.height - 32 });
      setPhase('initial');
    } else {
      setPhase('done');
    }
  }, [image, phase, focusOriginRect, computeTargetRect]);

  useEffect(() => {
    if (phase !== 'done' || !image?.width || !image?.height) return;
    const recalc = () => {
      if (!containerRef.current) return;
      setTargetRect(computeTargetRect(containerRef.current, image.width!, image.height!));
    };
    window.addEventListener('resize', recalc);
    return () => window.removeEventListener('resize', recalc);
  }, [phase, image, computeTargetRect]);

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
    if (!targetRect) return { display: 'none' };

    const base: React.CSSProperties = {
      position: 'fixed',
      left: targetRect.x,
      top: targetRect.y,
      width: targetRect.width,
      height: targetRect.height,
      borderRadius: '8px',
      objectFit: 'contain',
      zIndex: 70,
      pointerEvents: 'none',
    };

    if (phase === 'initial' && focusOriginRect) {
      const scaleX = focusOriginRect.width / targetRect.width;
      const scaleY = focusOriginRect.height / targetRect.height;
      const originCX = focusOriginRect.x + focusOriginRect.width / 2;
      const originCY = focusOriginRect.y + focusOriginRect.height / 2;
      const targetCX = targetRect.x + targetRect.width / 2;
      const targetCY = targetRect.y + targetRect.height / 2;
      return { ...base, transform: `translate(${originCX - targetCX}px, ${originCY - targetCY}px) scale(${scaleX}, ${scaleY})`, opacity: 0.9 };
    }
    if (phase === 'animating') {
      return {
        ...base,
        transform: 'translate(0, 0) scale(1)',
        transition: 'transform 350ms cubic-bezier(0.2, 0.9, 0.3, 1), opacity 350ms cubic-bezier(0.2, 0.9, 0.3, 1)',
        opacity: 1,
      };
    }
    if (phase === 'done') {
      return {
        ...base,
        transform: `scale(${zoom}) translate(${pan.x / zoom}px, ${pan.y / zoom}px)`,
        transition: isPanning ? 'none' : 'transform 150ms ease-out',
        opacity: 1,
        pointerEvents: 'auto',
      };
    }
    if (phase === 'exit-start') {
      return { ...base, transform: 'translate(0, 0) scale(1)', opacity: 1 };
    }
    if (phase === 'exiting' && focusOriginRect) {
      const scaleX = focusOriginRect.width / targetRect.width;
      const scaleY = focusOriginRect.height / targetRect.height;
      const originCX = focusOriginRect.x + focusOriginRect.width / 2;
      const originCY = focusOriginRect.y + focusOriginRect.height / 2;
      const targetCX = targetRect.x + targetRect.width / 2;
      const targetCY = targetRect.y + targetRect.height / 2;
      return {
        ...base,
        transform: `translate(${originCX - targetCX}px, ${originCY - targetCY}px) scale(${scaleX}, ${scaleY})`,
        transition: 'transform 350ms cubic-bezier(0.2, 0.9, 0.3, 1), opacity 350ms cubic-bezier(0.2, 0.9, 0.3, 1)',
        opacity: 0,
      };
    }
    return { display: 'none' };
  };

  const isExiting = phase === 'exit-start' || phase === 'exiting';
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
        className={`flex-1 overflow-hidden relative ${isZoomed ? (isPanning ? 'cursor-grabbing' : 'cursor-grab') : ''}`}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onWheel={handleWheel}
      />

      <footer
        ref={stripAnchorRef}
        className={`shrink-0 h-[130px] border-t border-gray-800 px-4 py-2 bg-gray-950 overflow-hidden transition-all ${phase === 'animating' || phase === 'done' ? 'translate-y-0 opacity-100' : 'translate-y-full opacity-0'}`}
        style={{ transitionTimingFunction: 'cubic-bezier(0.2, 0.9, 0.3, 1)', transitionDuration: '350ms' }}
      >
        {(phase === 'done' || phase === 'animating') && (
          <SimilarImagesStrip
            similarityPreset={similarityPrefs}
            onSimilarityLensChange={saveSimilarityPrefsAndRefresh}
            entries={similarImages}
            loading={isFetchingSimilar}
            currentImageId={image.id}
            emptyHint={similarEmptyHint}
            onPick={(nextId, rect) =>
              setSelectedImage(nextId, rect ?? focusOriginRect ?? null, { similarityAnchorSnapshot: image })
            }
            similarNavBackThumb={similarNavBackPeek}
            onSimilarNavBack={similarNavGoBack}
            size="md"
            similarFetchEmbedBaseline={similarFetchEmbedBaseline}
            similarMatchesMeta={similarMatchesMeta}
            clipSidecarRunning={clipSidecar}
            showInspectorGear
            inspectorSettingsOpen={similarInspectorOpen}
            inspectorSettingsPopover={
              similarInspectorOpen ? (
                <SimilarityInspectorPopover
                  prefs={similarityPrefs}
                  peerCandidatesIndexed={similarMatchesMeta?.peerCandidatesWithEmbedding ?? undefined}
                  onCancel={() => setSimilarInspectorOpen(false)}
                  onSave={async (next) => {
                    await saveSimilarityPrefsAndRefresh(next);
                    setSimilarInspectorOpen(false);
                  }}
                />
              ) : undefined
            }
            onInspectorGearClick={() => setSimilarInspectorOpen((o) => !o)}
            similarRefineMode={similarRefineMode}
            onSimilarRefineModeChange={setSimilarRefineMode}
          />
        )}
      </footer>
      <img
        src={src}
        alt={image.title || image.filename}
        className="select-none"
        draggable={false}
        style={getImgStyle()}
      />
      {toast && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg shadow-xl text-sm text-gray-200 animate-fade-in">
          Copied to clipboard
        </div>
      )}
    </main>
  );
}
