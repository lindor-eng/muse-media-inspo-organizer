/** What two Muse apps send each other. Bump PROTOCOL_VERSION for an incompatible change. */

export const PROTOCOL_VERSION = 1;
export const SERVICE_TYPE = 'muse-sync';

export type SyncTable = 'folders' | 'images' | 'image_tags';

export interface FolderData {
  id: string;
  name: string;
  parent_id: string | null;
  sort_order: number;
  color: string | null;
  created_at: string;
  updated_at: string;
}

export interface ColorData {
  hex_color: string;
  percentage: number | null;
  sort_order: number;
}

/** An `images` row, with its files named rather than placed, and what travels with it. */
export interface ImageData {
  id: string;
  filename: string;
  title: string;
  notes: string;
  alt_text: string;
  source_url: string;
  rating: number;
  width: number | null;
  height: number | null;
  file_size: number | null;
  file_type: string | null;
  hash: string | null;
  is_trashed: number;
  trashed_at: string | null;
  folder_id: string | null;
  created_at: string;
  updated_at: string;
  imported_at: string;
  file_created_at: string | null;
  file_modified_at: string | null;
  duration_ms: number | null;
  captions_version: number | null;
  indexed_chromatic: number | null;
  indexed_hue_bucket: number | null;
  indexed_hue_strength: number | null;
  indexed_hue_degrees: number | null;
  indexed_hue_bucket_2: number | null;
  indexed_hue_strength_2: number | null;
  /** base64 */
  phash: string | null;
  /** File names in `originals/` and `thumbnails/`; both are named by the original's hash. */
  original: string;
  thumbnail: string | null;
  colors: ColorData[];
  /** base64 Float32 caption embedding */
  embedding: string | null;
}

export interface LinkData {
  image_id: string;
  tag: string;
  tag_color: string | null;
  is_auto: number;
  confidence: number | null;
}

export interface ChangeRow {
  tbl: SyncTable;
  key: string;
  version: number;
  origin: string;
  deleted: boolean;
  data?: FolderData | ImageData | LinkData;
}

export interface ChangesPage {
  /** Changes when the sending library's log starts over; a cursor from another epoch is void. */
  epoch: string;
  rows: ChangeRow[];
  /** Ask for changes after this next time. */
  next: number;
  /** The newest change the sender has. */
  latest: number;
  more: boolean;
}

export interface RowRef {
  tbl: SyncTable;
  key: string;
}

/** The Bonjour TXT record. */
export interface Advertisement {
  id: string;
  name: string;
  /** Identifies the sync group without revealing anything about its key. Empty if unpaired. */
  tag: string;
  v: string;
}

/** Pairing: what the Mac being asked hands over once both people agree. */
export interface PairGrant {
  groupId: string;
  /** base64 */
  groupKey: string;
  device: string;
  name: string;
  members: Array<{ deviceId: string; name: string }>;
}

/** File names a peer may ask for: a sha256 with an optional short extension. */
export const FILE_NAME_PATTERN = /^[a-f0-9]{64}(\.[a-z0-9]{1,8})?$/;
