/**
 * Git-backed File Storage
 *
 * Drop-in replacement for diskStorage.ts — all operations go through
 * the git-aware session-data API (Vite dev server middleware) which persists
 * to ~/.openroom/sessions/{charId}/{modId}/apps/... with automatic git commits.
 *
 * Adds time-travel capabilities:
 *   - readFileAt(path, ref)   → read file at a specific git ref/commit
 *   - getHistory(path, limit) → list commit snapshots for a file
 *   - tagWithTMinus(cue)      → tag HEAD with a t-minus cue for Ghost Track
 *
 * Usage:
 *   import { gitStorage } from '@/lib/gitStorage';
 *   await gitStorage.writeFile('/data/test.txt', 'hello world');
 *   const history = await gitStorage.getHistory('/data/test.txt');
 */

import { getSessionPath } from './sessionPath';

const API_PATH = '/api/git-session-data';
const GIT_API_PATH = '/api/git';

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

export interface CommitInfo {
  hash: string;
  date: string;
  author: string;
  message: string;
}

export interface ListFilesResult {
  files: Array<{ path: string; type: number; size?: number }>;
  not_exists: boolean;
}

export interface HistoryResult {
  commits: CommitInfo[];
  git: boolean;
  error?: string;
}

// ──────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────

/** Build the full API URL for a file path, scoped under current session's /apps/ directory */
function apiUrl(filePath: string, action?: string): string {
  const session = getSessionPath();
  // Strip leading slash for uniform handling
  const cleaned = filePath.startsWith('/') ? filePath.slice(1) : filePath;
  // If the path already starts with "apps/", don't add the prefix again
  const alreadyPrefixed = cleaned.startsWith('apps/') || cleaned === 'apps';
  const fullPath = session
    ? alreadyPrefixed
      ? `${session}/${cleaned}`
      : `${session}/apps/${cleaned}`
    : alreadyPrefixed
      ? cleaned
      : `apps/${cleaned}`;
  let url = `${API_PATH}?path=${encodeURIComponent(fullPath)}`;
  if (action) url += `&action=${encodeURIComponent(action)}`;
  return url;
}

// ──────────────────────────────────────────────
// Core API — drop-in replacement for diskStorage
// ──────────────────────────────────────────────

/**
 * List files in a directory.
 * Returns { files: [{ path, type, size }], not_exists: boolean }
 */
export async function listFiles(dirPath: string): Promise<ListFilesResult> {
  try {
    const res = await fetch(apiUrl(dirPath, 'list'));
    if (res.ok) {
      return await res.json();
    }
    return { files: [], not_exists: true };
  } catch (e) {
    console.warn('[gitStorage] listFiles failed:', e);
    return { files: [], not_exists: true };
  }
}

/**
 * Read a file. Returns parsed JSON (if JSON file) or string content, or null if not found.
 */
export async function getFile(filePath: string): Promise<unknown> {
  try {
    const res = await fetch(apiUrl(filePath));
    if (!res.ok) return null;
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch (e) {
    console.warn('[gitStorage] getFile failed:', e);
    return null;
  }
}

/**
 * Write text/binary files. Compatible with the old putTextFilesByJSON signature.
 * files: [{ path: "directory", name: "filename", content: "..." }]
 *
 * Each write is automatically git-committed on the server side.
 */
export async function putTextFilesByJSON(data: {
  files: Array<{ path?: string; name?: string; content?: string }>;
}): Promise<void> {
  const promises = data.files.map(async (file) => {
    const fullPath = file.path ? `${file.path}/${file.name}` : file.name || '';
    if (!fullPath) return;
    try {
      await fetch(apiUrl(fullPath), {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: file.content || '',
      });
    } catch (e) {
      console.warn('[gitStorage] putTextFilesByJSON write failed:', e);
    }
  });
  await Promise.all(promises);
}

/**
 * Write a binary file (e.g. image) from base64 data.
 * Automatically git-committed on the server side.
 */
export async function putBinaryFile(
  filePath: string,
  base64: string,
  mimeType: string,
): Promise<void> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  await fetch(apiUrl(filePath), {
    method: 'POST',
    headers: { 'Content-Type': mimeType },
    body: bytes,
  });
}

/**
 * Delete files by paths. Each deletion is git-committed on the server side.
 */
export async function deleteFilesByPaths(data: { file_paths: string[] }): Promise<void> {
  const promises = data.file_paths.map(async (filePath) => {
    try {
      await fetch(apiUrl(filePath), { method: 'DELETE' });
    } catch {
      // silently ignore
    }
  });
  await Promise.all(promises);
}

/**
 * Search files by query string (filename match).
 */
export async function searchFiles(data: { query: string }): Promise<unknown[]> {
  try {
    const result = await listFiles('/');
    const q = data.query.toLowerCase();
    return result.files
      .filter((f) => f.path.toLowerCase().includes(q))
      .map((f) => ({
        id: '',
        name: f.path.split('/').pop() || '',
        path: '/' + f.path,
        type: f.type === 1 ? 'directory' : 'file',
        parentId: null,
        metadata: { size: f.size || 0 },
      }));
  } catch (e) {
    console.warn('[gitStorage] searchFiles failed:', e);
    return [];
  }
}

// ──────────────────────────────────────────────
// Git-aware extensions
// ──────────────────────────────────────────────

/**
 * Build a git API URL scoped under current session.
 */
function gitApiUrl(endpoint: string, params: Record<string, string>): string {
  const searchParams = new URLSearchParams(params);
  return `${GIT_API_PATH}/${endpoint}?${searchParams.toString()}`;
}

/**
 * Read a file at a specific git commit / ref.
 * Returns the file content as a string, or null if the file doesn't exist at that ref.
 *
 * @param path - File path (same format as readFile)
 * @param ref  - Git ref (commit hash, branch name, tag, or HEAD~N)
 */
export async function readFileAt(path: string, ref: string): Promise<string | null> {
  const session = getSessionPath();
  const cleaned = path.startsWith('/') ? path.slice(1) : path;
  const alreadyPrefixed = cleaned.startsWith('apps/') || cleaned === 'apps';
  const fullPath = session
    ? alreadyPrefixed
      ? `${session}/${cleaned}`
      : `${session}/apps/${cleaned}`
    : alreadyPrefixed
      ? cleaned
      : `apps/${cleaned}`;

  try {
    const res = await fetch(gitApiUrl('read-at', { path: fullPath, ref }));
    if (!res.ok) return null;
    const data = await res.json();
    if (data.exists && data.content !== null && data.content !== undefined) {
      return String(data.content);
    }
    return null;
  } catch (e) {
    console.warn('[gitStorage] readFileAt failed:', e);
    return null;
  }
}

/**
 * List available snapshots (commits) for a file.
 * Returns an array of CommitInfo objects, most recent first.
 *
 * @param path  - File path (same format as readFile)
 * @param limit - Maximum number of commits to return (default 10)
 */
export async function getHistory(path: string, limit: number = 10): Promise<CommitInfo[]> {
  const session = getSessionPath();
  const cleaned = path.startsWith('/') ? path.slice(1) : path;
  const alreadyPrefixed = cleaned.startsWith('apps/') || cleaned === 'apps';
  const fullPath = session
    ? alreadyPrefixed
      ? `${session}/${cleaned}`
      : `${session}/apps/${cleaned}`
    : alreadyPrefixed
      ? cleaned
      : `apps/${cleaned}`;

  try {
    const res = await fetch(gitApiUrl('history', { path: fullPath, limit: String(limit) }));
    if (!res.ok) return [];
    const data: HistoryResult = await res.json();
    return data.commits || [];
  } catch (e) {
    console.warn('[gitStorage] getHistory failed:', e);
    return [];
  }
}

/**
 * Tag HEAD with a t-minus cue for Ghost Track integration.
 * e.g. tagWithTMinus("character-greeting") → git tag "tminus-character-greeting-<ts>"
 *
 * @param cue - Short identifier for the t-minus marker (e.g. "greeting", "scene-1", "event-start")
 */
export async function tagWithTMinus(cue: string): Promise<string | null> {
  try {
    const res = await fetch(`${GIT_API_PATH}/tag`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cue }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.tag || null;
  } catch (e) {
    console.warn('[gitStorage] tagWithTMinus failed:', e);
    return null;
  }
}

/**
 * Ensure the git repo is initialized on the server side.
 * Returns the repo path if successful.
 */
export async function ensureGitInitialized(): Promise<{ ok: boolean; repo?: string; git?: boolean }> {
  try {
    const res = await fetch(`${GIT_API_PATH}/init`, { method: 'POST' });
    if (!res.ok) return { ok: false };
    return await res.json();
  } catch (e) {
    console.warn('[gitStorage] ensureGitInitialized failed:', e);
    return { ok: false };
  }
}

// ──────────────────────────────────────────────
// Unified adapter with both disk and git interfaces
// ──────────────────────────────────────────────

export type DiskStorageType = typeof import('./diskStorage');

/**
 * GitStorage object – matches the diskStorage API exactly so it can be
 * used as a drop-in replacement, with additional git-aware methods.
 */
export const gitStorage = {
  // === Disk-compatible API ===
  listFiles,
  getFile,
  putTextFilesByJSON,
  putBinaryFile,
  deleteFilesByPaths,
  searchFiles,

  // === Convenience aliases (matching the task's suggested API) ===
  readFile: getFile as (path: string) => Promise<unknown>,
  writeFile: (path: string, data: string): Promise<void> =>
    putTextFilesByJSON({ files: [{ path: '', name: path, content: data }] }),
  deleteFile: (path: string): Promise<void> =>
    deleteFilesByPaths({ file_paths: [path] }),

  // === Git extensions ===
  readFileAt,
  getHistory,
  tagWithTMinus,
  ensureGitInitialized,
};

export default gitStorage;
