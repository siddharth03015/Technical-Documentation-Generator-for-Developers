const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ready, upsertItem, getItem } = require('./db');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Extensions to scan */
const SCANNABLE_EXTENSIONS = new Set(['.js', '.ts', '.py', '.java', '.go', '.rs', '.cs', '.tf', '.yaml', '.yml']);

/** Directories to always skip */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist']);

/** How many lines of context to capture around each match */
const CONTEXT_LINES = 40;

// ---------------------------------------------------------------------------
// Regex patterns — one array per language group
// ---------------------------------------------------------------------------

/**
 * JS / TS patterns.
 * Each regex captures the function NAME in group 1 and the full signature
 * (everything up to the opening brace or arrow) on the matched line.
 */
const JS_PATTERNS = [
  /^[ \t]*(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z_$][\w$]*)\s*\(/,
  /^[ \t]*(?:export\s+)?(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:async\s+)?\(/,
  /^[ \t]*(?:export\s+)?(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[a-zA-Z_$][\w$]*)\s*=>/,
  /^[ \t]*([a-zA-Z_$][\w$]*)\s*=\s*async\s*\(/,
];

/** Python patterns. */
const PY_PATTERNS = [
  /^[ \t]*(?:async\s+)?def\s+([a-zA-Z_][\w]*)\s*\(/,
];

/** Java patterns. */
const JAVA_PATTERNS = [
  /^[ \t]*(?:public|protected|private)?\s*(?:static\s+)?[\w<>[\]]+\s+([a-zA-Z_$][\w$]*)\s*\(/
];

/** Go patterns. */
const GO_PATTERNS = [
  /^[ \t]*func\s+(?:\[[^\]]*\]\s+)?(?:\([^)]+\)\s+)?([a-zA-Z_]\w*)\s*\(/
];

/** Rust patterns. */
const RUST_PATTERNS = [
  /^[ \t]*(?:pub\s+)?(?:async\s+)?fn\s+([a-zA-Z_]\w*)\s*(?:<[^>]+>)?\s*\(/
];

/** C# patterns. */
const CS_PATTERNS = [
  /^[ \t]*(?:public|protected|private|internal)?\s*(?:static|virtual|override|async)?\s+[\w<>[\]]+\s+([a-zA-Z_]\w*)\s*\(/
];

/** Terraform patterns. */
const TF_PATTERNS = [
  /^[ \t]*(?:resource|data|module)\s+"[^"]+"\s+"([^"]+)"/
];

/** YAML/K8s/Helm patterns. */
const YAML_PATTERNS = [
  /^[ \t]*name:\s*([a-zA-Z0-9.-]+)/,
  /^[ \t]*kind:\s*([a-zA-Z0-9.-]+)/
];

// ---------------------------------------------------------------------------
// File-system walker
// ---------------------------------------------------------------------------

/**
 * Recursively collect file paths under `dir` that match our scannable
 * extensions, skipping blacklisted directories.
 */
function walkDir(dir) {
  const results = [];

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // Permission denied or similar — skip silently
    return results;
  }

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      results.push(...walkDir(fullPath));
    } else if (entry.isFile() && SCANNABLE_EXTENSIONS.has(path.extname(entry.name))) {
      results.push(fullPath);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Source extraction helpers
// ---------------------------------------------------------------------------

/**
 * Given a file's lines and the index of the matched line, return up to
 * CONTEXT_LINES lines of surrounding source (20 above + the match + 19 below,
 * clamped to file boundaries).
 */
function extractContext(lines, matchIndex) {
  const halfWindow = Math.floor(CONTEXT_LINES / 2);
  const start = Math.max(0, matchIndex - halfWindow);
  const end = Math.min(lines.length - 1, matchIndex + halfWindow);
  return lines.slice(start, end + 1).join('\n');
}

/**
 * Compute an MD5 hex digest of a string.
 */
function md5(text) {
  return crypto.createHash('md5').update(text).digest('hex');
}

// ---------------------------------------------------------------------------
// Core scanner
// ---------------------------------------------------------------------------

/**
 * Scan a single file for function definitions.
 * Returns an array of raw match objects (not yet persisted).
 */
function scanFile(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  const ext = path.extname(filePath);
  let patterns, itemType;

  if (ext === '.py') { patterns = PY_PATTERNS; itemType = 'python_function'; }
  else if (ext === '.js' || ext === '.ts') { patterns = JS_PATTERNS; itemType = 'js_function'; }
  else if (ext === '.java') { patterns = JAVA_PATTERNS; itemType = 'java_method'; }
  else if (ext === '.go') { patterns = GO_PATTERNS; itemType = 'go_function'; }
  else if (ext === '.rs') { patterns = RUST_PATTERNS; itemType = 'rust_function'; }
  else if (ext === '.cs') { patterns = CS_PATTERNS; itemType = 'csharp_method'; }
  else if (ext === '.tf') { patterns = TF_PATTERNS; itemType = 'terraform_block'; }
  else if (ext === '.yaml' || ext === '.yml') { patterns = YAML_PATTERNS; itemType = 'yaml_config'; }
  else { return []; }

  const lines = content.split('\n');
  const matches = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    for (const pattern of patterns) {
      const m = pattern.exec(line);
      if (m) {
        const name = m[0].trim();  // full matched signature portion
        const funcName = m[1];     // captured function name
        const sourceText = extractContext(lines, i);
        const astHash = md5(sourceText);

        matches.push({
          name: funcName,
          file_path: filePath,
          signature: name,
          source_text: sourceText,
          ast_hash: astHash,
          item_type: itemType,
        });
        break; // one match per line is enough
      }
    }
  }

  return matches;
}

/**
 * Scan a directory tree for code items, upsert each into the database,
 * and return enriched results.
 *
 * NOTE: Requires `await ready()` to have been called before first use.
 *
 * @param {string} dirPath — root directory to scan
 * @returns {Array<{id, name, file_path, signature, source_text, isNew, changed}>}
 */
function scanDirectory(dirPath) {
  const resolvedDir = path.resolve(dirPath);
  const files = walkDir(resolvedDir);
  const results = [];

  for (const filePath of files) {
    const items = scanFile(filePath);

    for (const item of items) {
      const { id, isNew, changed } = upsertItem(item);

      // Re-read the full row so we always return the persisted state
      const persisted = getItem(id);

      results.push({
        id,
        name: persisted.name,
        file_path: persisted.file_path,
        signature: persisted.signature,
        source_text: persisted.source_text,
        isNew,
        changed,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// CLI — run when executed directly
// ---------------------------------------------------------------------------

if (require.main === module) {
  (async () => {
    await ready();

    const targetDir = process.argv[2] || '.';
    console.log(`Scanning "${path.resolve(targetDir)}" …\n`);

    const items = scanDirectory(targetDir);

    const newCount = items.filter((i) => i.isNew).length;
    const changedCount = items.filter((i) => i.changed).length;
    const unchangedCount = items.length - newCount - changedCount;

    console.log(`Found ${items.length} code item(s):`);
    console.log(`  • ${newCount} new`);
    console.log(`  • ${changedCount} changed`);
    console.log(`  • ${unchangedCount} unchanged`);
  })();
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { scanDirectory, scanFile, walkDir };
