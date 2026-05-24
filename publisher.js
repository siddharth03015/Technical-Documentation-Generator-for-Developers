const { Octokit } = require('@octokit/rest');
require('dotenv').config();

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_OWNER = process.env.GITHUB_OWNER || '';

const octokit = new Octokit({ auth: GITHUB_TOKEN });

// ---------------------------------------------------------------------------
// publishDoc — commit directly to the default branch
// ---------------------------------------------------------------------------

/**
 * Publish a documentation file directly to the repo's default branch.
 *
 * - Creates or updates docs/{codeItemName}.md
 * - If the file already exists, passes the existing SHA for an update commit
 *
 * @param {string} repoName         — repository name (not full slug)
 * @param {string} codeItemName     — function / item name (used as filename)
 * @param {string} markdownContent  — the Markdown documentation body
 * @param {number} score            — overall quality score (shown in commit msg)
 * @returns {Promise<{success: boolean, url: string}>}
 */
async function publishDoc(repoName, codeItemName, markdownContent, score) {
  const filePath = `docs/${codeItemName}.md`;
  const owner = GITHUB_OWNER;

  // Check if file already exists (to get its SHA for an update)
  let existingSha = null;
  try {
    const { data } = await octokit.repos.getContent({
      owner,
      repo: repoName,
      path: filePath,
    });
    existingSha = data.sha;
  } catch (err) {
    // 404 is expected when the file doesn't exist yet
    if (err.status !== 404) {
      throw err;
    }
  }

  const commitMessage = `docs: auto-generate docs for ${codeItemName} [score: ${score}]`;
  const contentBase64 = Buffer.from(markdownContent, 'utf-8').toString('base64');

  const putParams = {
    owner,
    repo: repoName,
    path: filePath,
    message: commitMessage,
    content: contentBase64,
  };

  if (existingSha) {
    putParams.sha = existingSha;
  }

  const { data: commit } = await octokit.repos.createOrUpdateFileContents(putParams);

  return {
    success: true,
    url: commit.content?.html_url || commit.commit?.html_url || '',
  };
}

// ---------------------------------------------------------------------------
// publishAsPR — create a branch, commit the file, open a pull request
// ---------------------------------------------------------------------------

/**
 * Publish documentation as a pull request for human review.
 *
 * - Creates a new branch: docs/auto-{timestamp}
 * - Commits docs/{codeItemName}.md to that branch
 * - Opens a PR titled "docs: update {codeItemName} — needs review"
 *
 * @param {string} repoName         — repository name
 * @param {string} codeItemName     — function / item name
 * @param {string} markdownContent  — Markdown documentation
 * @param {object} [opts]           — optional extra context
 * @param {number} [opts.score]     — overall quality score
 * @param {string[]} [opts.missing] — list of missing sections
 * @returns {Promise<{success: boolean, prUrl: string}>}
 */
async function publishAsPR(repoName, codeItemName, markdownContent, opts = {}) {
  const owner = GITHUB_OWNER;
  const timestamp = Date.now();
  const branchName = `docs/auto-${timestamp}`;
  const filePath = `docs/${codeItemName}.md`;

  // 1. Get the default branch's latest commit SHA
  const { data: repoData } = await octokit.repos.get({ owner, repo: repoName });
  const defaultBranch = repoData.default_branch;

  const { data: refData } = await octokit.git.getRef({
    owner,
    repo: repoName,
    ref: `heads/${defaultBranch}`,
  });
  const baseSha = refData.object.sha;

  // 2. Create the new branch
  await octokit.git.createRef({
    owner,
    repo: repoName,
    ref: `refs/heads/${branchName}`,
    sha: baseSha,
  });

  // 3. Commit the documentation file to the new branch
  const contentBase64 = Buffer.from(markdownContent, 'utf-8').toString('base64');

  // Check if file exists on that branch (it's based on default, so same content)
  let existingSha = null;
  try {
    const { data } = await octokit.repos.getContent({
      owner,
      repo: repoName,
      path: filePath,
      ref: branchName,
    });
    existingSha = data.sha;
  } catch (err) {
    if (err.status !== 404) throw err;
  }

  const putParams = {
    owner,
    repo: repoName,
    path: filePath,
    message: `docs: auto-generate docs for ${codeItemName}`,
    content: contentBase64,
    branch: branchName,
  };

  if (existingSha) {
    putParams.sha = existingSha;
  }

  await octokit.repos.createOrUpdateFileContents(putParams);

  // 4. Open a pull request
  const score = opts.score != null ? opts.score : '—';
  const missing = Array.isArray(opts.missing) && opts.missing.length > 0
    ? opts.missing.map((m) => `- ${m}`).join('\n')
    : '_None detected_';

  const prBody = [
    `## Auto-generated Documentation`,
    '',
    `**Code item:** \`${codeItemName}\``,
    `**Completeness score:** ${score}/10`,
    '',
    `### Missing / Incomplete Sections`,
    missing,
    '',
    '---',
    '_This PR was created automatically by the documentation generator._',
  ].join('\n');

  const { data: pr } = await octokit.pulls.create({
    owner,
    repo: repoName,
    title: `docs: update ${codeItemName} — needs review`,
    body: prBody,
    head: branchName,
    base: defaultBranch,
  });

  return {
    success: true,
    prUrl: pr.html_url,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { publishDoc, publishAsPR };
