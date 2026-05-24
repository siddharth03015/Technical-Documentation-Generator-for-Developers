const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { Octokit } = require('@octokit/rest');
require('dotenv').config();

const {
  ready,
  getDb,
  getAllItems,
  getItem,
  getDocForItem,
  saveDoc,
  insertEvent,
  getPendingEvents,
} = require('./db');
const { scanDirectory } = require('./scanner');
const { generateDocs, scoreDocs } = require('./agent');
const { startWatcher, stopWatcher, isWatching } = require('./watcher');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 3000;
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const app = express();

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

// We need the raw body for webhook signature verification, so we use a
// custom verify callback on the JSON parser.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      // Stash the raw body buffer so we can use it in signature validation
      req.rawBody = buf;
    },
  })
);

// Serve static files from public/
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// GitHub Webhook
// ---------------------------------------------------------------------------

/**
 * Validate the X-Hub-Signature-256 header against the raw request body.
 * Returns true when valid, false otherwise.
 */
function verifyGitHubSignature(req) {
  if (!GITHUB_WEBHOOK_SECRET) return false;

  const signature = req.headers['x-hub-signature-256'];
  if (!signature) return false;

  const hmac = crypto.createHmac('sha256', GITHUB_WEBHOOK_SECRET);
  hmac.update(req.rawBody);
  const expected = 'sha256=' + hmac.digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

app.post('/webhook/github', async (req, res) => {
  const event = req.headers['x-github-event'];
  console.log(`\n[WEBHOOK] Received '${event}' event from GitHub!`);

  // 1. Validate signature
  if (!verifyGitHubSignature(req)) {
    console.error(`[WEBHOOK ERROR] Signature validation failed! Check your GITHUB_WEBHOOK_SECRET.`);
    return res.status(401).json({ error: 'Invalid signature' });
  }
  
  console.log(`[WEBHOOK] Signature validated successfully.`);

  const payload = req.body;

  try {
    // ----- pull_request (merged only) ------------------------------------
    if (event === 'pull_request' && payload.action === 'closed' && payload.pull_request?.merged) {
      const pr = payload.pull_request;
      const owner = payload.repository.owner.login;
      const repo = payload.repository.name;
      const pullNumber = pr.number;

      // Fetch the diff from GitHub
      let diff = '';
      try {
        const { data } = await octokit.pulls.get({
          owner,
          repo,
          pull_number: pullNumber,
          mediaType: { format: 'diff' },
        });
        diff = data;
      } catch (err) {
        console.error('Failed to fetch PR diff:', err.message);
      }

      // Fetch changed files
      let changedFiles = [];
      try {
        const { data: files } = await octokit.pulls.listFiles({
          owner,
          repo,
          pull_number: pullNumber,
          per_page: 100,
        });
        changedFiles = files.map((f) => f.filename);
      } catch (err) {
        console.error('Failed to fetch PR changed files:', err.message);
      }

      // Insert event
      const eventPayload = {
        event_type: 'pull_request_merged',
        pr_number: pullNumber,
        pr_title: pr.title,
        pr_body: pr.body || '',
        changed_files: changedFiles,
        pr_diff: diff,
        owner,
        repo,
      };

      insertEvent({
        event_type: 'pull_request_merged',
        payload: JSON.stringify(eventPayload),
        status: 'pending',
      });

      return res.status(200).json({ received: true, type: 'pull_request_merged' });
    }

    // ----- push ----------------------------------------------------------
    if (event === 'push') {
      const commits = payload.commits || [];
      const changedFiles = [
        ...new Set(
          commits.flatMap((c) => [...(c.added || []), ...(c.modified || []), ...(c.removed || [])])
        ),
      ];

      const eventPayload = {
        event_type: 'push',
        ref: payload.ref,
        changed_files: changedFiles,
        owner: payload.repository.owner.login || payload.repository.owner.name,
        repo: payload.repository.name,
      };

      insertEvent({
        event_type: 'push',
        payload: JSON.stringify(eventPayload),
        status: 'pending',
      });

      return res.status(200).json({ received: true, type: 'push' });
    }

    // ----- unsupported event ---------------------------------------------
    return res.status(200).json({ received: true, type: 'ignored' });
  } catch (err) {
    console.error('Webhook processing error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// REST API — Code Items & Documentation
// ---------------------------------------------------------------------------

/**
 * GET /api/items
 * Returns all code_items with their latest documentation joined.
 */
app.get('/api/items', (_req, res) => {
  try {
    const items = getAllItems();
    const enriched = items.map((item) => {
      const doc = getDocForItem(item.id);
      return { ...item, documentation: doc || null };
    });
    res.json(enriched);
  } catch (err) {
    console.error('GET /api/items error:', err);
    res.status(500).json({ error: 'Failed to fetch items' });
  }
});

/**
 * GET /api/items/:id
 * Returns a single code_item with its latest documentation.
 */
app.get('/api/items/:id', (req, res) => {
  try {
    const item = getItem(Number(req.params.id));
    if (!item) return res.status(404).json({ error: 'Item not found' });

    const doc = getDocForItem(item.id);
    res.json({ ...item, documentation: doc || null });
  } catch (err) {
    console.error('GET /api/items/:id error:', err);
    res.status(500).json({ error: 'Failed to fetch item' });
  }
});

/**
 * POST /api/items/:id/approve
 * Sets the latest documentation status to 'published' and queues a publish event.
 */
app.post('/api/items/:id/approve', (req, res) => {
  try {
    const itemId = Number(req.params.id);
    const item = getItem(itemId);
    if (!item) return res.status(404).json({ error: 'Item not found' });

    const doc = getDocForItem(itemId);
    if (!doc) return res.status(404).json({ error: 'No documentation found for this item' });

    // Update doc status to published
    const db = getDb();
    db.run("UPDATE documentation SET status = 'published' WHERE id = ?", [doc.id]);

    // Persist change
    const { persist } = require('./db');
    if (persist) persist();

    // Queue a publish event
    insertEvent({
      event_type: 'doc_published',
      payload: JSON.stringify({
        code_item_id: itemId,
        documentation_id: doc.id,
        name: item.name,
        file_path: item.file_path,
      }),
      status: 'pending',
    });

    res.json({ success: true, doc_id: doc.id, status: 'published' });
  } catch (err) {
    console.error('POST /api/items/:id/approve error:', err);
    res.status(500).json({ error: 'Failed to approve documentation' });
  }
});

/**
 * POST /api/scan
 * Accepts { repo_path } and runs the scanner on that directory.
 */
app.post('/api/scan', (req, res) => {
  try {
    const { repo_path } = req.body;
    if (!repo_path) {
      return res.status(400).json({ error: 'repo_path is required' });
    }

    const items = scanDirectory(repo_path);
    res.json({
      count: items.length,
      new: items.filter((i) => i.isNew).length,
      changed: items.filter((i) => i.changed).length,
    });
  } catch (err) {
    console.error('POST /api/scan error:', err);
    res.status(500).json({ error: 'Scan failed: ' + err.message });
  }
});

// ---------------------------------------------------------------------------
// NEW API — Generate documentation
// ---------------------------------------------------------------------------

/**
 * POST /api/items/:id/generate
 * Manually trigger doc generation for a single item.
 */
app.post('/api/items/:id/generate', async (req, res) => {
  try {
    const itemId = Number(req.params.id);
    const item = getItem(itemId);
    if (!item) return res.status(404).json({ error: 'Item not found' });

    console.log(`Generating docs for "${item.name}"…`);

    // Generate documentation
    const docContent = await generateDocs(item);

    // Score it
    const scores = await scoreDocs(item, docContent);

    // Determine status
    let status = 'review';
    if (scores.overall >= 8) status = 'ready';
    if (scores.overall < 5) status = 'draft';

    // Save to DB
    saveDoc({
      code_item_id: item.id,
      content: docContent,
      overall_score: scores.overall,
      description_score: scores.description,
      params_score: scores.params,
      return_score: scores.return_value,
      examples_score: scores.examples,
      edge_cases_score: scores.edge_cases,
      missing_fields: scores.missing,
      status,
    });

    console.log(`  ✓ "${item.name}" — score: ${scores.overall}, status: ${status}`);

    res.json({
      success: true,
      name: item.name,
      score: scores.overall,
      status,
    });
  } catch (err) {
    console.error('POST /api/items/:id/generate error:', err);
    res.status(500).json({ error: 'Generation failed: ' + err.message });
  }
});

/**
 * POST /api/generate-all
 * Generate docs for ALL items that don't have documentation yet.
 * Runs synchronously in-request (may take time for large codebases).
 */
app.post('/api/generate-all', async (req, res) => {
  try {
    const { force } = req.body || {};
    const items = getAllItems();
    
    let targets;
    if (force) {
      targets = items;
    } else {
      targets = items.filter((item) => {
        const doc = getDocForItem(item.id);
        return !doc;
      });
    }

    if (targets.length === 0) {
      return res.json({ success: true, queued: 0, message: 'No items matching criteria to generate' });
    }

    // Insert an event for each target item so the worker picks them up
    for (const item of targets) {
      insertEvent({
        event_type: 'generate_request',
        payload: JSON.stringify({
          event_type: 'generate_request',
          code_item_id: item.id,
          name: item.name,
          file_path: item.file_path,
        }),
        status: 'pending',
      });
    }

    res.json({
      success: true,
      queued: targets.length,
      message: `Queued ${targets.length} items for generation` + (force ? ' (force overwrite)' : ''),
    });
  } catch (err) {
    console.error('POST /api/generate-all error:', err);
    res.status(500).json({ error: 'Batch generation failed: ' + err.message });
  }
});


// ---------------------------------------------------------------------------
// NEW API — Events & Stats
// ---------------------------------------------------------------------------

/**
 * GET /api/events
 * Return recent events (last 50).
 */
app.get('/api/events', (_req, res) => {
  try {
    const db = getDb();
    const stmt = db.prepare('SELECT * FROM events ORDER BY created_at DESC LIMIT 50');
    const rows = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    res.json(rows);
  } catch (err) {
    console.error('GET /api/events error:', err);
    res.status(500).json({ error: 'Failed to fetch events' });
  }
});

/**
 * GET /api/stats
 * Return dashboard statistics.
 */
app.get('/api/stats', (_req, res) => {
  try {
    const items = getAllItems();
    const total = items.length;

    let documented = 0;
    let totalScore = 0;
    let scoreCount = 0;
    const statusCounts = { draft: 0, review: 0, ready: 0, published: 0, none: 0 };

    for (const item of items) {
      const doc = getDocForItem(item.id);
      if (doc) {
        documented++;
        if (doc.overall_score != null) {
          totalScore += doc.overall_score;
          scoreCount++;
        }
        statusCounts[doc.status || 'draft']++;
      } else {
        statusCounts.none++;
      }
    }

    res.json({
      total,
      documented,
      documentedPct: total > 0 ? Math.round((documented / total) * 100) : 0,
      avgScore: scoreCount > 0 ? parseFloat((totalScore / scoreCount).toFixed(1)) : 0,
      statusCounts,
      watching: isWatching(),
    });
  } catch (err) {
    console.error('GET /api/stats error:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ---------------------------------------------------------------------------
// NEW API — Watcher control
// ---------------------------------------------------------------------------

/**
 * POST /api/watch/start
 * Start the file watcher on a given directory path.
 */
app.post('/api/watch/start', (req, res) => {
  try {
    const { dir_path } = req.body;
    if (!dir_path) return res.status(400).json({ error: 'dir_path is required' });

    startWatcher(dir_path);
    res.json({ success: true, watching: true, path: path.resolve(dir_path) });
  } catch (err) {
    console.error('POST /api/watch/start error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/watch/stop
 * Stop the file watcher.
 */
app.post('/api/watch/stop', (_req, res) => {
  try {
    stopWatcher();
    res.json({ success: true, watching: false });
  } catch (err) {
    console.error('POST /api/watch/stop error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Start server (standalone mode)
// ---------------------------------------------------------------------------

if (require.main === module) {
  ready().then(() => {
    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
      console.log(`Health check: http://localhost:${PORT}/health`);
    });
  });
}

module.exports = { app };
