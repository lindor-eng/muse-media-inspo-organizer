/** Live state of a drop/picker import, broadcast from main on `import:progress`.
    Shared so main, preload, and the renderer banner agree on the shape and the copy. */
export type ImportStatus =
  | { phase: 'scan' }
  | { phase: 'import'; current: number; total: number }
  | {
      phase: 'done';
      imported: number;
      duplicates: number;
      failed: number;
      /** Muse folders created to mirror dropped directory/zip structure. */
      foldersCreated: number;
      /** Dropped sources that held nothing importable (empty folder, zip without media). */
      emptySources: number;
    };

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** One-line banner copy for a status tick. */
export function describeImportStatus(status: ImportStatus): string {
  if (status.phase === 'scan') return 'Looking for media...';
  if (status.phase === 'import') {
    return status.total > 0 ? `Importing ${status.current} of ${status.total}...` : 'Importing...';
  }

  const { imported, duplicates, failed, foldersCreated, emptySources } = status;

  if (imported === 0 && duplicates === 0 && failed === 0) {
    return emptySources > 0 ? 'No media found to import' : 'Nothing to import';
  }

  // "item" rather than "image": a drop can be any mix of stills and video clips.
  let headline = imported > 0 ? `Imported ${plural(imported, 'item')}` : 'No new items';
  if (imported > 0 && foldersCreated > 0) headline += ` into ${plural(foldersCreated, 'new folder')}`;

  const notes: string[] = [];
  if (duplicates > 0) notes.push(`${duplicates} already in your library`);
  if (failed > 0) notes.push(`${plural(failed, 'file')} couldn't be read`);

  return notes.length > 0 ? `${headline} · ${notes.join(' · ')}` : headline;
}
