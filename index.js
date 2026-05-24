const path = require('path');
require('dotenv').config();

const { ready } = require('./db');
const { app }   = require('./server');
const { processEvent } = require('./worker');
const { getPendingEvents, updateEventStatus } = require('./db');
const { startWatcher, stopWatcher } = require('./watcher');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT            = process.env.PORT || 3000;
const WATCH_DIR       = process.env.WATCH_DIR || '';
const POLL_INTERVAL   = 5000;  // ms

// ---------------------------------------------------------------------------
// Worker polling loop (embedded)
// ---------------------------------------------------------------------------

let pollTimer = null;

async function pollEvents() {
  try {
    const events = getPendingEvents(5);
    if (events.length === 0) return;

    console.log(`\n--- Worker: ${events.length} pending event(s) ---`);

    for (const event of events) {
      await processEvent(event);
    }
  } catch (err) {
    console.error('Worker poll error:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Startup banner
// ---------------------------------------------------------------------------

function printBanner() {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════════╗');
  console.log('  ║   📄  AI Documentation Generator                ║');
  console.log('  ╠══════════════════════════════════════════════════╣');
  console.log(`  ║   Server    → http://localhost:${String(PORT).padEnd(19)}║`);
  console.log(`  ║   Dashboard → http://localhost:${PORT}/              ║`);
  console.log(`  ║   Health    → http://localhost:${PORT}/health        ║`);
  console.log('  ║   Worker    → polling every 5s                  ║');
  if (WATCH_DIR) {
    const dir = WATCH_DIR.length > 33 ? '…' + WATCH_DIR.slice(-32) : WATCH_DIR;
    console.log(`  ║   Watcher   → ${dir.padEnd(35)}║`);
  } else {
    console.log('  ║   Watcher   → off (set WATCH_DIR in .env)      ║');
  }
  console.log('  ╚══════════════════════════════════════════════════╝');
  console.log('');
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function shutdown() {
  console.log('\n  Shutting down…');

  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  stopWatcher();

  console.log('  Goodbye.\n');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // 1. Initialize database
  await ready();
  console.log('  ✓ Database initialized');

  // 2. Start Express server
  await new Promise((resolve) => {
    app.listen(PORT, () => {
      console.log(`  ✓ Server listening on port ${PORT}`);
      resolve();
    });
  });

  // 3. Start worker polling
  pollTimer = setInterval(pollEvents, POLL_INTERVAL);
  pollEvents(); // immediate first run
  console.log('  ✓ Worker started (polling every 5s)');

  // 4. Optionally start file watcher
  if (WATCH_DIR) {
    startWatcher(WATCH_DIR);
    console.log(`  ✓ Watcher started on ${path.resolve(WATCH_DIR)}`);
  }

  // 5. Print banner
  printBanner();

  // 6. Graceful shutdown handlers
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
