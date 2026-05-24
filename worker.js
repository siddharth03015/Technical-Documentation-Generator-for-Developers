const path = require('path');
require('dotenv').config();

const {
  ready,
  getPendingEvents,
  updateEventStatus,
  getDocForItem,
  saveDoc,
  getItem,
} = require('./db');
const { scanDirectory, scanFile } = require('./scanner');
const { generateDocs, updateDocs, scoreDocs } = require('./agent');
const { publishDoc, publishAsPR } = require('./publisher');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 5000;
const BATCH_LIMIT = 5;

// ---------------------------------------------------------------------------
// Score-based status thresholds
// ---------------------------------------------------------------------------

/**
 * Determine the documentation status based on the overall quality score.
 *   >= 8  → 'ready'
 *   5–7   → 'review'
 *   < 5   → needs regeneration (returns null to signal retry)
 */
function statusFromScore(overall) {
  if (overall >= 8) return 'ready';
  if (overall >= 5) return 'review';
  return null; // signals that a retry is needed
}

// ---------------------------------------------------------------------------
// Process a single code item (generate or update docs, then score)
// ---------------------------------------------------------------------------

/**
 * Handle documentation generation/updating for one code item.
 *
 * @param {object}      codeItem — full row from code_items
 * @param {string|null} prDiff   — PR diff text (if available)
 * @param {string|null} repoName — repository name for publishing
 */
async function processCodeItem(codeItem, prDiff, repoName) {
  const existingDoc = getDocForItem(codeItem.id);

  let docContent;

  if (existingDoc && prDiff) {
    // Existing doc + PR diff → update
    docContent = await updateDocs(codeItem, existingDoc.content, prDiff);
  } else {
    // No existing doc (or no diff) → generate fresh
    docContent = await generateDocs(codeItem);
  }

  // Score the documentation
  let scores = await scoreDocs(codeItem, docContent);
  let status = statusFromScore(scores.overall);

  // If score < 5, regenerate once and re-score
  if (status === null) {
    console.log(
      `  ↻ Score too low (${scores.overall}) for "${codeItem.name}" — regenerating…`
    );
    docContent = await generateDocs(codeItem);
    scores = await scoreDocs(codeItem, docContent);
    status = statusFromScore(scores.overall) || 'review'; // fallback to 'review'
  }

  // Persist the documentation
  saveDoc({
    code_item_id: codeItem.id,
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

  console.log(
    `  ✓ "${codeItem.name}" — score: ${scores.overall}, status: ${status}`
  );

  // Publish based on status
  await publishByStatus(codeItem, docContent, scores, status, repoName);
}

/**
 * Publish documentation to GitHub based on its quality status.
 *
 * @param {object} codeItem        — code_items row
 * @param {string} docContent      — generated Markdown
 * @param {object} scores          — score breakdown
 * @param {string} status          — 'ready' | 'review' | 'draft'
 * @param {string|null} repoName   — repository name (from event payload)
 */
async function publishByStatus(codeItem, docContent, scores, status, repoName) {
  if (!repoName) {
    console.log('    ⊘ No repo name in payload — skipping publish');
    return;
  }

  try {
    if (status === 'ready') {
      console.log(`    ↑ Publishing "${codeItem.name}" directly (score ≥ 8)…`);
      const result = await publishDoc(repoName, codeItem.name, docContent, scores.overall);
      console.log(`    ✓ Published: ${result.url}`);
    } else if (status === 'review') {
      console.log(`    ↑ Opening PR for "${codeItem.name}" (needs review)…`);
      const result = await publishAsPR(repoName, codeItem.name, docContent, {
        score: scores.overall,
        missing: scores.missing,
      });
      console.log(`    ✓ PR created: ${result.prUrl}`);
    }
  } catch (err) {
    // Publish failures are non-fatal — log and continue
    console.error(`    ⚠ Publish failed for "${codeItem.name}":`, err.message);
  }
}

// ---------------------------------------------------------------------------
// Process a single event
// ---------------------------------------------------------------------------

/**
 * Process one event from the events table.
 *
 * @param {object} event — row from events table
 */
async function processEvent(event) {
  console.log(`\nProcessing event #${event.id} (${event.event_type})…`);

  // Mark as processing
  updateEventStatus(event.id, 'processing');

  try {
    const payload =
      typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;

    // ---- generate_request — single item from dashboard ------------------
    if (event.event_type === 'generate_request' || payload.event_type === 'generate_request') {
      const itemId = payload.code_item_id;
      const item = getItem(itemId);
      if (!item) throw new Error(`Code item ${itemId} not found`);

      await processCodeItem(item, null, payload.repo || null);

      updateEventStatus(event.id, 'done');
      console.log(`  ✓ Event #${event.id} completed.`);
      return;
    }

    // ---- file_change / push / pull_request — scan changed files ---------
    const changedFiles = payload.changed_files || [];
    const prDiff = payload.pr_diff || null;

    // Scan changed files to detect code items
    const codeItems = [];

    for (const filePath of changedFiles) {
      // Resolve relative paths against current working directory
      const resolved = path.resolve(filePath);

      const fileItems = scanFile(resolved);

      for (const item of fileItems) {
        const { upsertItem } = require('./db');
        const { id, isNew, changed } = upsertItem(item);
        const persisted = getItem(id);

        if (persisted && (isNew || changed)) {
          codeItems.push(persisted);
        }
      }
    }

    // If no individual files resolved, try scanning the repo root
    if (codeItems.length === 0 && payload.repo) {
      console.log(`  No individual files resolved — scanning repo root…`);
      const repoItems = scanDirectory(payload.repo);
      for (const ri of repoItems) {
        if (ri.isNew || ri.changed) {
          const persisted = getItem(ri.id);
          if (persisted) codeItems.push(persisted);
        }
      }
    }

    console.log(`  Found ${codeItems.length} new/changed code item(s)`);

    // Determine repo name for publishing
    const repoName = payload.repo || null;

    // Process each code item
    for (const codeItem of codeItems) {
      await processCodeItem(codeItem, prDiff, repoName);
    }

    // Mark event as done
    updateEventStatus(event.id, 'done');
    console.log(`  ✓ Event #${event.id} completed.`);
  } catch (err) {
    console.error(`  ✗ Event #${event.id} failed:`, err.message);
    updateEventStatus(event.id, 'failed', err.message);
  }
}

// ---------------------------------------------------------------------------
// Polling loop
// ---------------------------------------------------------------------------

async function pollEvents() {
  try {
    const events = getPendingEvents(BATCH_LIMIT);
    if (events.length === 0) return;

    console.log(`\n--- Worker tick: ${events.length} pending event(s) ---`);

    for (const event of events) {
      await processEvent(event);
    }
  } catch (err) {
    console.error('Worker poll error:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Start worker when run directly
// ---------------------------------------------------------------------------

if (require.main === module) {
  ready().then(() => {
    console.log('Worker started. Polling every', POLL_INTERVAL_MS, 'ms…');
    console.log('Press Ctrl+C to stop.\n');

    // Run immediately on start, then at interval
    pollEvents();
    setInterval(pollEvents, POLL_INTERVAL_MS);
  });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { processEvent, processCodeItem };
