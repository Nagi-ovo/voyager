const UNSUPPORTED_DEFAULT_VERSION = '1.1.3';
const UNSUPPORTED_DEFAULT_VERSION_COMMENT =
  '⚠️ 你填写的可能是错误的版本号，1.1.3 已经不再支持，请及时更正。';

// Feature requests go to Discussions, so `[Bug]` is the only template prefix that can reach Issues.
const EMPTY_TITLE_PATTERNS = [/^\[Bug\]\s*$/i];

function extractSection(text, headerPattern) {
  const match = text.match(new RegExp(`${headerPattern}\\s+([\\s\\S]*?)(?=\\n###|$)`));
  return match ? match[1].trim() : '';
}

function normalizeSubmittedVersion(version) {
  const firstLine = version
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && line !== '_No response_');

  if (!firstLine) return '';

  return firstLine.replace(/^`|`$/g, '').replace(/^v/i, '').trim();
}

function extractExtensionVersion(body) {
  return extractSection(body, '### 📦 扩展版本 \\| Extension Version');
}

function usesUnsupportedDefaultVersion(body) {
  return normalizeSubmittedVersion(extractExtensionVersion(body)) === UNSUPPORTED_DEFAULT_VERSION;
}

function getTitlePrefix(title) {
  return title.match(/^\[(\w+)\]/)?.[0] || '';
}

function generateIssueTitle(title, body) {
  const prefix = getTitlePrefix(title);
  const description = extractSection(body, '### 🐛 问题描述 \\| Bug Description');

  if (!description) return '';

  const generated = description
    .split(/[\n。.!！？?]/)[0]
    .trim()
    .slice(0, 80);

  return generated ? `${prefix} ${generated}` : '';
}

async function validateIssue({ github, context }) {
  const issue = context.payload.issue;
  const title = issue.title.trim();
  const body = issue.body || '';

  if (usesUnsupportedDefaultVersion(body)) {
    await github.rest.issues.createComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: issue.number,
      body: UNSUPPORTED_DEFAULT_VERSION_COMMENT,
    });
  }

  const isEmptyTitle = EMPTY_TITLE_PATTERNS.some((pattern) => pattern.test(title));
  if (!isEmptyTitle) return;

  const newTitle = generateIssueTitle(title, body);

  await github.rest.issues.addLabels({
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: issue.number,
    labels: ['missing-title'],
  });

  if (newTitle) {
    await github.rest.issues.update({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: issue.number,
      title: newTitle,
    });

    await github.rest.issues.createComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: issue.number,
      body: `📝 Your issue title was empty — auto-generated from the description. Feel free to edit it if needed.`,
    });
    return;
  }

  await github.rest.issues.createComment({
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: issue.number,
    body: `📝 Your issue title appears to be empty. Please edit it to add a brief summary — it helps with triage and search.`,
  });
}

module.exports = {
  UNSUPPORTED_DEFAULT_VERSION_COMMENT,
  extractExtensionVersion,
  generateIssueTitle,
  normalizeSubmittedVersion,
  usesUnsupportedDefaultVersion,
  validateIssue,
};
