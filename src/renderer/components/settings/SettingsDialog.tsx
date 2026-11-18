import { useEffect } from 'react';
import { Bot, Keyboard, Library, Puzzle, RefreshCw, SlidersHorizontal, X } from 'lucide-react';
import { useAppStore, type SettingsSection } from '../../stores/app-store';
import { GeneralSettings } from './GeneralSettings';
import { SyncSettings } from './SyncSettings';
import { LibrarySettings } from './LibrarySettings';
import { AiSettings } from './AiSettings';
import { ExtensionSettings } from './ExtensionSettings';
import { ShortcutsSettings } from './ShortcutsSettings';

const SECTIONS: Array<{ id: SettingsSection; label: string; icon: typeof RefreshCw; view: () => React.ReactElement }> = [
  { id: 'general', label: 'General', icon: SlidersHorizontal, view: GeneralSettings },
  { id: 'sync', label: 'Sync', icon: RefreshCw, view: SyncSettings },
  { id: 'library', label: 'Library', icon: Library, view: LibrarySettings },
  { id: 'ai', label: 'AI', icon: Bot, view: AiSettings },
  { id: 'extension', label: 'Browser extension', icon: Puzzle, view: ExtensionSettings },
  { id: 'shortcuts', label: 'Shortcuts', icon: Keyboard, view: ShortcutsSettings },
];

/** Settings: the gear beside the username, or Muse › Settings… (⌘,). */
export function SettingsDialog() {
  const open = useAppStore((s) => s.settingsOpen);
  const setOpen = useAppStore((s) => s.setSettingsOpen);
  const section = useAppStore((s) => s.settingsSection);
  const setSection = useAppStore((s) => s.setSettingsSection);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  if (!open) return null;
  const View = (SECTIONS.find((s) => s.id === section) ?? SECTIONS[0]).view;

  return (
    <div
      className="fixed inset-0 z-[70] bg-black/55 backdrop-blur-sm flex items-center justify-center"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div
        role="dialog"
        aria-label="Settings"
        className="relative bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-[880px] max-w-[94vw] h-[640px] max-h-[90vh] flex overflow-hidden"
      >
        <nav className="w-[200px] shrink-0 bg-gray-950/40 border-r border-gray-800 px-2.5 py-4 flex flex-col gap-0.5">
          <h2 className="px-2.5 pb-3 text-[15px] font-semibold text-gray-100">Settings</h2>
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setSection(id)}
              aria-current={section === id ? 'page' : undefined}
              className={`flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-sm text-left transition-colors ${
                section === id ? 'bg-blue-500/15 text-blue-200' : 'text-gray-400 hover:bg-white/5 hover:text-gray-200'
              }`}
            >
              <Icon size={15} />
              {label}
            </button>
          ))}
        </nav>
        <div className="flex-1 min-w-0 overflow-y-auto">
          <View />
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="absolute top-3 right-3 text-gray-500 hover:text-gray-300 p-1 rounded"
          aria-label="Close settings"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}
