const chokidar = require('chokidar');
const path = require('path');
require('dotenv').config();

const { ready, insertEvent } = require('./db');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Extensions to watch (same as scanner.js) */
const WATCH_EXTENSIONS = /\.(js|ts|py)$/;

/** Directories to ignore */
const IGNORE_PATTERNS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/docs_generator.db',
];

/** Debounce window — accumulate changes before creating an event (ms) */
const DEBOUNCE_MS = 2000;

// ---------------------------------------------------------------------------
// Watcher state
// ---------------------------------------------------------------------------

let watcher = null;
let pendingFiles = new Set();
let debounceTimer = null;

// ---------------------------------------------------------------------------
// Debounced event creator
// ---------------------------------------------------------------------------

/**
 * Flush accumulated file changes into a single DB event.
 */
function flushChanges() {
  if (pendingFiles.size === 0) return;

  const changedFiles = [...pendingFiles];
  pendingFiles = new Set();

  console.log(`[watcher] ${changedFiles.length} file(s) changed → creating event`);
  changedFiles.forEach((f) => console.log(`  • ${f}`));

  try {
    insertEvent({
      event_type: 'file_change',
      payload: JSON.stringify({
        event_type: 'file_change',
        changed_files: changedFiles,
      }),
      status: 'pending',
    });
  } catch (err) {
    console.error('[watcher] Failed to insert event:', err.message);
  }
}

/**
 * Queue a file change — accumulates until debounce fires.
 */
function queueChange(filePath) {
  pendingFiles.add(filePath);

  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(flushChanges, DEBOUNCE_MS);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start watching a directory for code file changes.
 * Changes are debounced and inserted as events for the worker to process.
 *
 * @param {string} dirPath — directory to watch
 * @returns {object} chokidar watcher instance
 */
function startWatcher(dirPath) {
  const resolvedDir = path.resolve(dirPath);

  if (watcher) {
    console.log('[watcher] Already watching — stopping previous watcher first');
    stopWatcher();
  }

  console.log(`[watcher] Watching "${resolvedDir}" for changes…`);

  watcher = chokidar.watch(resolvedDir, {
    ignored: IGNORE_PATTERNS,
    persistent: true,
    ignoreInitial: true,         // don't fire for existing files
    awaitWriteFinish: {          // wait for writes to complete
      stabilityThreshold: 500,
      pollInterval: 100,
    },
  });

  watcher
    .on('add', (fp) => {
      if (WATCH_EXTENSIONS.test(fp)) {
        console.log(`[watcher] File added: ${fp}`);
        queueChange(fp);
      }
    })
    .on('change', (fp) => {
      if (WATCH_EXTENSIONS.test(fp)) {
        console.log(`[watcher] File changed: ${fp}`);
        queueChange(fp);
      }
    })
    .on('error', (err) => {
      console.error('[watcher] Error:', err.message);
    });

  return watcher;
}

/**
 * Stop the file watcher and flush any pending changes.
 */
function stopWatcher() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  // Flush any remaining
  flushChanges();

  if (watcher) {
    watcher.close();
    watcher = null;
    console.log('[watcher] Stopped.');
  }
}

/**
 * Check if the watcher is currently active.
 */
function isWatching() {
  return watcher !== null;
}

// ---------------------------------------------------------------------------
// CLI — run standalone
// ---------------------------------------------------------------------------

if (require.main === module) {
  const targetDir = process.argv[2] || process.env.WATCH_DIR || '.';

  ready().then(() => {
    startWatcher(targetDir);
    console.log('[watcher] Press Ctrl+C to stop.\n');

    process.on('SIGINT', () => {
      stopWatcher();
      process.exit(0);
    });
    process.on('SIGTERM', () => {
      stopWatcher();
      process.exit(0);
    });
  });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { startWatcher, stopWatcher, isWatching };
