const Groq = require('groq-sdk');
require('dotenv').config();

// ---------------------------------------------------------------------------
// Client setup (lazy — avoids crash if GROQ_API_KEY is not set at startup)
// ---------------------------------------------------------------------------

let _client = null;

function getClient() {
  if (!_client) {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      throw new Error('GROQ_API_KEY is not set. Add it to your .env file.');
    }
    _client = new Groq({ apiKey });
  }
  return _client;
}

// Use the lighter model for everything to bypass Groq free-tier rate limits!
const MODEL_HEAVY = 'llama-3.1-8b-instant';  // generate + update
const MODEL_LIGHT = 'llama-3.1-8b-instant';  // score (JSON only, faster)
const MAX_TOKENS = 4096;

// ---------------------------------------------------------------------------
// Helper — call Groq with a system + user prompt, with retry on 429
// ---------------------------------------------------------------------------

async function callGroq(systemPrompt, userPrompt, model = MODEL_HEAVY, maxTokens = MAX_TOKENS) {
  const params = {
    model,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  };

  // Retry up to 5 times on rate-limit, network, or server errors
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const response = await getClient().chat.completions.create(params);
      return response.choices[0]?.message?.content ?? '';
    } catch (err) {
      const isRateLimit = err.status === 429;
      const isTransient = !err.status || err.status >= 500; // Network error or server error
      
      if ((isRateLimit || isTransient) && attempt < 5) {
        let waitMs = 5000;
        if (isRateLimit) {
          const match = err.message && err.message.match(/try again in ([0-9.]+)s/i);
          if (match) {
            waitMs = (parseFloat(match[1]) + 2) * 1000; // Add 2 seconds buffer
          } else {
            waitMs = (err.headers?.['retry-after'] || 10) * 1000 * attempt;
          }
        } else {
          waitMs = 5000 * attempt;
        }
        console.warn(`callGroq: ${isRateLimit ? 'rate limited' : 'connection/server error'}. Retrying in ${waitMs}ms (attempt ${attempt}/5)...`);
        await new Promise((r) => setTimeout(r, waitMs));
      } else {
        throw err;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Security: Secrets & PII Redaction
// ---------------------------------------------------------------------------

function redactSensitiveInfo(text) {
  if (!text) return text;
  // Redact potential API keys/secrets
  let redacted = text.replace(/(?:api_key|secret|password|token)\s*[:=]\s*["'][A-Za-z0-9-_]{16,}["']/gi, '"***REDACTED_SECRET***"');
  // Redact potential IP addresses
  redacted = redacted.replace(/\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/g, '***REDACTED_IP***');
  // Redact email addresses
  redacted = redacted.replace(/[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/g, '***REDACTED_EMAIL***');
  return redacted;
}

// ---------------------------------------------------------------------------
// generateDocs
// ---------------------------------------------------------------------------

/**
 * Generate fresh documentation for a code item.
 *
 * @param {object} codeItem — row from code_items (must have .signature, .source_text)
 * @returns {Promise<string>} Markdown documentation
 */
async function generateDocs(codeItem) {
  const systemPrompt =
    'You are a senior technical writer. Generate documentation for code.';

  const safeSignature = redactSensitiveInfo(codeItem.signature);
  const safeSource = redactSensitiveInfo(codeItem.source_text);

  const userPrompt = `Generate comprehensive Markdown documentation for the following code item.

## Function Signature
\`\`\`
${safeSignature}
\`\`\`

## Source Code
\`\`\`
${safeSource}
\`\`\`

Please include the following sections in your documentation:

1. **Description** — A clear, concise explanation of what this function does, its purpose, and any important behavior.
2. **Parameters** — A Markdown table with columns: Name, Type, Required, Description.
3. **Return Value** — What the function returns, including type and possible values.
4. **Exceptions & Edge Cases** — Document any errors thrown, potential failure states, and boundary conditions.
5. **Complexity Notes** — Time and space complexity, or performance considerations.
6. **Usage Example** — A realistic code example showing how to call and use this function.

Output ONLY valid Markdown. Do not wrap the entire response in a code fence.`;

  return callGroq(systemPrompt, userPrompt, MODEL_HEAVY);
}

// ---------------------------------------------------------------------------
// updateDocs
// ---------------------------------------------------------------------------

/**
 * Update existing documentation based on a PR diff.
 *
 * @param {object}  codeItem        — row from code_items
 * @param {string}  existingContent — current Markdown documentation
 * @param {string}  prDiff          — unified diff from the pull request
 * @returns {Promise<string>} Updated Markdown documentation
 */
async function updateDocs(codeItem, existingContent, prDiff) {
  const systemPrompt = 'You are a documentation maintainer.';

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  const safeSignature = redactSensitiveInfo(codeItem.signature);
  const safeSource = redactSensitiveInfo(codeItem.source_text);

  const userPrompt = `Below is the existing documentation for a code item, followed by the PR diff that changed it.
Your task: update ONLY the sections affected by the diff. Do NOT rewrite unchanged sections.
After your updates, append a \`## Changelog\` section (or add an entry if it already exists) with today's date (${today}) and a one-sentence summary of what changed.

## Function Signature
\`\`\`
${safeSignature}
\`\`\`

## Current Source Code
\`\`\`
${safeSource}
\`\`\`

## Existing Documentation
${existingContent}

## PR Diff
\`\`\`diff
${prDiff}
\`\`\`

Output ONLY the full updated Markdown documentation (including unchanged sections).`;

  return callGroq(systemPrompt, userPrompt, MODEL_HEAVY);
}

// ---------------------------------------------------------------------------
// scoreDocs
// ---------------------------------------------------------------------------

/**
 * Score documentation quality. Returns a structured object with per-category
 * scores (0-10), a weighted overall score, and a list of missing fields.
 *
 * Weights:
 *   description 30%, params 25%, return_value 20%, examples 15%, edge_cases 10%
 *
 * @param {object} codeItem   — row from code_items
 * @param {string} docContent — Markdown documentation to evaluate
 * @returns {Promise<object>}  { description, params, return_value, examples,
 *                               edge_cases, missing, overall }
 */
async function scoreDocs(codeItem, docContent) {
  const systemPrompt =
    'You are a documentation quality auditor. Reply ONLY with valid JSON. No markdown fences, no explanation, no extra text.';

  const safeSignature = redactSensitiveInfo(codeItem.signature);
  const safeSource = redactSensitiveInfo(codeItem.source_text);

  const userPrompt = `Score the following documentation for the code item described below.

## Function Signature
\`\`\`
${safeSignature}
\`\`\`

## Source Code
\`\`\`
${safeSource}
\`\`\`

## Documentation to Score
${docContent}

Rate each category from 0 to 10:
- description: Clarity and completeness of the description.
- params: Whether all parameters are documented with types and descriptions.
- return_value: Whether the return value is documented with type and meaning.
- edge_cases: Whether edge cases, exceptions, errors, and boundary conditions are covered.
- complexity: Whether performance, time, and space complexity considerations are discussed.
- examples: Quality and realism of usage examples.

Also provide:
- missing: a JSON array of strings listing any missing or incomplete fields.
- overall: a weighted float calculated as:
    description × 0.25 + params × 0.20 + return_value × 0.15 + edge_cases × 0.15 + complexity × 0.10 + examples × 0.15

Respond with ONLY a JSON object in this exact shape:
{
  "description": <number>,
  "params": <number>,
  "return_value": <number>,
  "edge_cases": <number>,
  "complexity": <number>,
  "examples": <number>,
  "missing": [<string>, ...],
  "overall": <number>
}`;

  // Use the lighter/faster model — scoring is a simple structured task
  const raw = await callGroq(systemPrompt, userPrompt, MODEL_LIGHT, 512);

  try {
    // Groq models occasionally wrap output in fences despite instructions
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    const parsed = JSON.parse(cleaned);

    const scores = {
      description: Number(parsed.description) || 0,
      params: Number(parsed.params) || 0,
      return_value: Number(parsed.return_value) || 0,
      edge_cases: Number(parsed.edge_cases) || 0,
      complexity: Number(parsed.complexity) || 0,
      examples: Number(parsed.examples) || 0,
      missing: Array.isArray(parsed.missing) ? parsed.missing : [],
      overall: Number(parsed.overall) || 0,
    };

    // Recalculate overall to guarantee correct weighting regardless of model output
    scores.overall = parseFloat(
      (
        scores.description * 0.25 +
        scores.params * 0.20 +
        scores.return_value * 0.15 +
        scores.edge_cases * 0.15 +
        scores.complexity * 0.10 +
        scores.examples * 0.15
      ).toFixed(2)
    );

    return scores;
  } catch (err) {
    console.error('scoreDocs: failed to parse Groq response as JSON:', err.message);
    console.error('Raw response:', raw);

    return {
      description: 0,
      params: 0,
      return_value: 0,
      edge_cases: 0,
      complexity: 0,
      examples: 0,
      missing: ['parse_error'],
      overall: 0,
    };
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { generateDocs, updateDocs, scoreDocs };