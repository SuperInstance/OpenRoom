/**
 * Git-backed Session Data Plugin (Vite Middleware)
 *
 * Wraps every filesystem write under ~/.openroom/ with a git commit,
 * enabling time-travel, branching, and t-minus event awareness.
 *
 * API endpoints:
 *   GET    /api/git-session-data?path=...            – read file
 *   POST   /api/git-session-data?path=...            – write file + auto-commit
 *   DELETE /api/git-session-data?path=...            – delete file + auto-commit
 *   GET    /api/git-session-data?path=...&action=list – directory listing
 *   GET    /api/git/history?path=...&limit=N         – commit history for a file
 *   GET    /api/git/read-at?path=...&ref=...          – read file at a specific ref
 *   POST   /api/git/tag                              – tag HEAD with a t-minus cue
 *   POST   /api/git/init                             – ensure git repo is initialized
 */

import type { Plugin } from 'vite';
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { execSync } from 'child_process';

const SESSIONS_DIR = resolve(os.homedir(), '.openroom', 'sessions');
const OPENROOM_DIR = resolve(os.homedir(), '.openroom');

function resolve(...parts: string[]): string {
  return join(...parts);
}

/** Run a git command in the .openroom directory, returning stdout trimmed. */
function git(...args: string[]): string {
  try {
    const result = execSync(`git ${args.map(a => `"${a.replace(/"/g, '\\"')}"`).join(' ')}`, {
      cwd: OPENROOM_DIR,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return (result || '').trim();
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    throw new Error(`git ${args[0]} failed: ${err.stderr || err.message || 'unknown error'}`);
  }
}

/** Ensure the git repo is initialized at ~/.openroom/ */
function ensureGitRepo(): void {
  if (!fs.existsSync(OPENROOM_DIR)) {
    fs.mkdirSync(OPENROOM_DIR, { recursive: true });
  }
  const gitDir = join(OPENROOM_DIR, '.git');
  if (!fs.existsSync(gitDir)) {
    git('init');
    // Set user config if not already set
    try {
      git('config', 'user.name', 'OpenRoom Git Storage');
      git('config', 'user.email', 'openroom@localhost');
    } catch {
      // Ignore if already configured
    }
    // Create .gitignore for common patterns
    const gitignorePath = join(OPENROOM_DIR, '.gitignore');
    if (!fs.existsSync(gitignorePath)) {
      fs.writeFileSync(
        gitignorePath,
        [
          '# OpenRoom git storage .gitignore',
          '# Ignore large binary/cache files by convention',
          '*.log',
          '*.tmp',
          '.DS_Store',
          'thumbs.db',
          '',
        ].join('\n'),
        'utf-8',
      );
    }
  }
}

/** Sanitize a path to prevent directory traversal */
function sanitizePath(relPath: string): string {
  return relPath.replace(/[^a-zA-Z0-9_\-./]/g, '_').replace(/\.\./g, '');
}

/** Check if git is available */
function isGitAvailable(): boolean {
  try {
    execSync('git --version', { stdio: 'pipe', encoding: 'utf-8' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Create the git session data Vite plugin.
 * Call this instead of the plain sessionDataPlugin() when you want git wrapping.
 */
export function gitSessionPlugin(): Plugin {
  return {
    name: 'git-session-data',
    configureServer(server) {
      const gitAvailable = isGitAvailable();
      if (!gitAvailable) {
        console.warn('[gitSessionPlugin] git not found on system; falling back to plain file I/O (no commits)');
      } else {
        ensureGitRepo();
      }

      // --------------- Git-aware session data middleware ---------------
      server.middlewares.use('/api/git-session-data', (req, res) => {
        res.setHeader('Content-Type', 'application/json');

        const url = new URL(req.url || '', 'http://localhost');
        const relPath = url.searchParams.get('path') || '';
        const action = url.searchParams.get('action') || '';

        if (!relPath) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Missing path parameter' }));
          return;
        }

        const safePath = sanitizePath(relPath);
        const filePath = join(SESSIONS_DIR, safePath);
        const relFilePath = safePath.replace(/^sessions\//, '');
        const relativeGitPath = `sessions/${safePath}`;

        // Directory listing
        if (action === 'list' && req.method === 'GET') {
          try {
            if (!fs.existsSync(filePath) || !fs.statSync(filePath).isDirectory()) {
              res.writeHead(200);
              res.end(JSON.stringify({ files: [], not_exists: !fs.existsSync(filePath) }));
              return;
            }
            const entries = fs.readdirSync(filePath, { withFileTypes: true });
            const files = entries.map((e) => ({
              path: safePath === '' || safePath === '/' ? e.name : `${safePath}/${e.name}`,
              type: e.isDirectory() ? 1 : 0,
              size: e.isDirectory() ? 0 : fs.statSync(join(filePath, e.name)).size,
            }));
            res.writeHead(200);
            res.end(JSON.stringify({ files, not_exists: false }));
          } catch (err) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: String(err) }));
          }
          return;
        }

        // GET – read file
        if (req.method === 'GET') {
          try {
            if (fs.existsSync(filePath)) {
              const ext = filePath.split('.').pop()?.toLowerCase() || '';
              const binaryMimes: Record<string, string> = {
                png: 'image/png',
                jpg: 'image/jpeg',
                jpeg: 'image/jpeg',
                gif: 'image/gif',
                webp: 'image/webp',
                svg: 'image/svg+xml',
                mp4: 'video/mp4',
                webm: 'video/webm',
              };
              const mime = binaryMimes[ext];
              if (mime) {
                res.setHeader('Content-Type', mime);
                res.writeHead(200);
                res.end(fs.readFileSync(filePath));
              } else {
                res.writeHead(200);
                res.end(fs.readFileSync(filePath, 'utf-8'));
              }
            } else {
              res.writeHead(200);
              res.end('{}');
            }
          } catch (err) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: String(err) }));
          }
          return;
        }

        // POST – write file + auto-commit
        if (req.method === 'POST') {
          const chunks: Buffer[] = [];
          req.on('data', (chunk: Buffer) => chunks.push(chunk));
          req.on('end', () => {
            try {
              const buf = Buffer.concat(chunks);
              const dir = filePath.substring(0, filePath.lastIndexOf('/'));
              fs.mkdirSync(dir, { recursive: true });
              const ct = (req.headers['content-type'] || '').toLowerCase();
              if (
                ct.startsWith('image/') ||
                ct.startsWith('video/') ||
                ct === 'application/octet-stream'
              ) {
                fs.writeFileSync(filePath, buf);
              } else {
                fs.writeFileSync(filePath, buf.toString(), 'utf-8');
              }

              // Git operations — try to commit, swallow errors gracefully
              if (gitAvailable) {
                try {
                  git('add', relativeGitPath);
                  const ts = new Date().toISOString();
                  git('commit', '-m', `state: ${relativeGitPath} @ ${ts}`, '--no-verify');
                } catch (gitErr) {
                  console.warn('[gitSessionPlugin] git commit failed:', (gitErr as Error).message);
                }
              }

              res.writeHead(200);
              res.end(JSON.stringify({ ok: true, git: gitAvailable }));
            } catch (err) {
              res.writeHead(500);
              res.end(JSON.stringify({ error: String(err) }));
            }
          });
          return;
        }

        // DELETE – delete file + auto-commit
        if (req.method === 'DELETE') {
          try {
            if (fs.existsSync(filePath)) {
              fs.unlinkSync(filePath);

              if (gitAvailable) {
                try {
                  git('add', relativeGitPath);
                  const ts = new Date().toISOString();
                  git('commit', '-m', `state: ${relativeGitPath} (deleted) @ ${ts}`, '--no-verify');
                } catch (gitErr) {
                  console.warn('[gitSessionPlugin] git commit (delete) failed:', (gitErr as Error).message);
                }
              }
            }
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true, git: gitAvailable }));
          } catch (err) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: String(err) }));
          }
          return;
        }

        res.writeHead(405);
        res.end(JSON.stringify({ error: 'Method not allowed' }));
      });

      // --------------- Git history endpoint ---------------
      server.middlewares.use('/api/git/history', (req, res) => {
        res.setHeader('Content-Type', 'application/json');

        if (req.method !== 'GET') {
          res.writeHead(405);
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        if (!gitAvailable) {
          res.writeHead(200);
          res.end(JSON.stringify({ commits: [], git: false }));
          return;
        }

        const url = new URL(req.url || '', 'http://localhost');
        const relPath = url.searchParams.get('path') || '';
        const limit = parseInt(url.searchParams.get('limit') || '10', 10);
        const safePath = sanitizePath(relPath);
        const relativeGitPath = `sessions/${safePath}`;

        try {
          // Use git log to get commit history for the file
          const logOutput = git(
            'log',
            `--max-count=${limit}`,
            '--format=%H|%ai|%an|%s',
            '--follow',
            '--',
            relativeGitPath,
          );

          if (!logOutput) {
            res.writeHead(200);
            res.end(JSON.stringify({ commits: [], git: true }));
            return;
          }

          const commits = logOutput.split('\n').filter(Boolean).map((line) => {
            const parts = line.split('|');
            return {
              hash: parts[0] || '',
              date: parts[1] || '',
              author: parts[2] || '',
              message: parts.slice(3).join('|') || '',
            };
          });

          res.writeHead(200);
          res.end(JSON.stringify({ commits, git: true }));
        } catch (err) {
          // If the file has no history yet
          res.writeHead(200);
          res.end(JSON.stringify({ commits: [], git: true, error: String(err) }));
        }
      });

      // --------------- Read file at specific ref ---------------
      server.middlewares.use('/api/git/read-at', (req, res) => {
        res.setHeader('Content-Type', 'application/json');

        if (req.method !== 'GET') {
          res.writeHead(405);
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        if (!gitAvailable) {
          res.writeHead(200);
          res.end(JSON.stringify({ content: null, git: false }));
          return;
        }

        const url = new URL(req.url || '', 'http://localhost');
        const relPath = url.searchParams.get('path') || '';
        const ref = url.searchParams.get('ref') || 'HEAD';
        const safePath = sanitizePath(relPath);
        const relativeGitPath = `sessions/${safePath}`;

        try {
          const content = git('show', `${ref}:${relativeGitPath}`);
          res.writeHead(200);
          res.end(JSON.stringify({ content, exists: true, ref, git: true }));
        } catch {
          // File might not exist at that ref
          res.writeHead(200);
          res.end(JSON.stringify({ content: null, exists: false, ref, git: true }));
        }
      });

      // --------------- Tag with t-minus cue ---------------
      server.middlewares.use('/api/git/tag', (req, res) => {
        res.setHeader('Content-Type', 'application/json');

        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        if (!gitAvailable) {
          res.writeHead(200);
          res.end(JSON.stringify({ ok: false, git: false }));
          return;
        }

        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString());
            const cue: string = body.cue || '';
            if (!cue) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: 'Missing cue parameter' }));
              return;
            }

            // Generate a unique tag name from the cue + timestamp
            const safeCue = cue.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
            const ts = Date.now();
            const tagName = `tminus-${safeCue}-${ts}`;
            git('tag', '-a', tagName, '-m', `t-minus: ${cue}`);
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true, tag: tagName, cue, git: true }));
          } catch (err) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: String(err) }));
          }
        });
      });

      // --------------- Git init endpoint ---------------
      server.middlewares.use('/api/git/init', (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (!gitAvailable) {
          res.writeHead(200);
          res.end(JSON.stringify({ ok: false, git: false, message: 'git not available on system' }));
          return;
        }
        try {
          ensureGitRepo();
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true, git: true, repo: OPENROOM_DIR }));
        } catch (err) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
    },
  };
}
