const COMMUNITY_ONLY_LABEL = 'community-only';
const ENHANCEMENT_LABEL = 'enhancement';
// Issues carrying one of these labels cannot be self-claimed: a maintainer confirms scope
// with `/approve @user` first. Order matters — the first match picks the explanation text.
const APPROVAL_REQUIRED_LABELS = [COMMUNITY_ONLY_LABEL, ENHANCEMENT_LABEL];
const CLAIMED_LABEL = '👷 Claimed';
const PUBLIC_DISCOVERY_LABELS = ['good first issue', 'help wanted'];
const COMMUNITY_NOTICE_MARKER = '<!-- voyager-community-only-policy -->';
const MODERATOR_PERMISSIONS = new Set(['admin', 'maintain', 'write']);

const COMMUNITY_NOTICE = `${COMMUNITY_NOTICE_MARKER}
🏠 **Community-only issue / 社群专属 Issue**

This issue is reserved for verified members of the Voyager community. It is not open for drive-by implementation PRs.

这个 Issue 由 Voyager 社群成员优先认领，不接受未经确认直接提交的实现 PR。

- 社群成员请评论 \`/claim\`；维护者确认身份后会使用 \`/approve @username\` 完成认领。
- 请在被分配前不要开始实现或提交 PR。
- 尚未加入社群？欢迎加入 [Voyager Discord](https://discord.gg/TEUFxdMbGb)。

- Community members: comment \`/claim\`; a maintainer will verify membership and confirm with \`/approve @username\`.
- Do not start implementation or open a PR until you are assigned.
- Not a member yet? Join the [Voyager Discord](https://discord.gg/TEUFxdMbGb).`;

function getLabelName(label) {
  return typeof label === 'string' ? label : label?.name;
}

function issueHasLabel(issue, labelName) {
  return (issue.labels || []).some((label) => getLabelName(label) === labelName);
}

function parseCommand(body = '') {
  const command = body.trim();

  if (/^\/claim$/i.test(command)) return { name: 'claim' };
  if (/^\/unclaim$/i.test(command)) return { name: 'unclaim' };

  const approval = command.match(/^\/approve\s+@([a-z\d](?:[a-z\d-]{0,37}[a-z\d])?)$/i);
  if (approval) return { name: 'approve', username: approval[1] };

  return null;
}

function findApprovalRequiredLabel(issue) {
  return APPROVAL_REQUIRED_LABELS.find((label) => issueHasLabel(issue, label)) || null;
}

function approvalRequestBody(commenter, label) {
  if (label === COMMUNITY_ONLY_LABEL) {
    return `🏠 **@${commenter}**, this is a community-only issue. / 这是一个社群专属 Issue。\n\nA maintainer must verify your community membership before assignment. Maintainers: comment \`/approve @${commenter}\` to approve this claim.\n\n维护者确认社群身份后，请评论 \`/approve @${commenter}\` 完成认领。`;
  }

  return `🌠 **@${commenter}**, this is a feature-level work item. / 这是一个功能级工作项。\n\nFeature work needs scope alignment with a maintainer before it is assigned. Describe what you plan to build here first. Maintainers: comment \`/approve @${commenter}\` to approve this claim.\n\n功能级改动需要先和维护者对齐范围，请先在这里说明你打算怎么做。维护者确认后会评论 \`/approve @${commenter}\` 完成认领。`;
}

function canModerate(permission) {
  return MODERATOR_PERMISSIONS.has(permission);
}

async function getUserPermission({ github, context, username }) {
  try {
    const { data } = await github.rest.repos.getCollaboratorPermissionLevel({
      owner: context.repo.owner,
      repo: context.repo.repo,
      username,
    });
    return data.permission;
  } catch (error) {
    if (error.status === 404) return 'read';
    throw error;
  }
}

function issueParams(context) {
  return {
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: context.payload.issue.number,
  };
}

async function comment({ github, context, body }) {
  await github.rest.issues.createComment({
    ...issueParams(context),
    body,
  });
}

async function addClaimedLabel({ github, context }) {
  try {
    await github.rest.issues.addLabels({
      ...issueParams(context),
      labels: [CLAIMED_LABEL],
    });
  } catch (error) {
    console.log(`Could not add ${CLAIMED_LABEL}: ${error.message}`);
  }
}

async function assignIssue({ github, context, username, approvedBy }) {
  try {
    await github.rest.issues.addAssignees({
      ...issueParams(context),
      assignees: [username],
    });
  } catch {
    await comment({
      github,
      context,
      body: `❌ Failed to assign **@${username}**. / 无法分配给 **@${username}**。\n\nA maintainer can assign them manually if appropriate.`,
    });
    return { status: 'assignment_failed', username };
  }

  await addClaimedLabel({ github, context });

  const approvalLine = approvedBy
    ? `\n\nCommunity membership verified by **@${approvedBy}**. / 社群身份已由 **@${approvedBy}** 确认。`
    : '';

  await comment({
    github,
    context,
    body: `🎉 **@${username}** has claimed this issue! / 已认领此 Issue！${approvalLine}\n\nPlease read the [Contributing Guide](https://github.com/${context.repo.owner}/${context.repo.repo}/blob/main/.github/CONTRIBUTING.md), reference this issue in your PR, and comment \`/unclaim\` if you can no longer continue.`,
  });
  return { status: 'assigned', username };
}

async function rejectIfAssigned({ github, context }) {
  const assignees = context.payload.issue.assignees || [];
  if (assignees.length === 0) return false;

  const assigneeNames = assignees.map((assignee) => assignee.login).join(', ');
  await comment({
    github,
    context,
    body: `❌ This issue is already assigned to: **${assigneeNames}**. / 此 Issue 已被认领。`,
  });
  return true;
}

async function handleClaim({ github, context }) {
  if (await rejectIfAssigned({ github, context })) return { status: 'already_assigned' };

  const commenter = context.payload.comment.user.login;
  const approvalLabel = findApprovalRequiredLabel(context.payload.issue);

  if (approvalLabel) {
    const permission = await getUserPermission({ github, context, username: commenter });
    if (!canModerate(permission)) {
      await comment({
        github,
        context,
        body: approvalRequestBody(commenter, approvalLabel),
      });
      return { status: 'awaiting_approval', username: commenter };
    }
  }

  return assignIssue({ github, context, username: commenter });
}

async function handleApprove({ github, context, username }) {
  if (!findApprovalRequiredLabel(context.payload.issue)) {
    await comment({
      github,
      context,
      body: 'ℹ️ `/approve` is only used for issues labeled `community-only` or `enhancement`. / `/approve` 仅用于带有 `community-only` 或 `enhancement` 标签的 Issue。',
    });
    return { status: 'not_approval_required' };
  }

  const approver = context.payload.comment.user.login;
  const permission = await getUserPermission({ github, context, username: approver });
  if (!canModerate(permission)) {
    await comment({
      github,
      context,
      body: `❌ **@${approver}** does not have permission to approve community claims. / 你没有确认社群认领的权限。`,
    });
    return { status: 'forbidden' };
  }

  if (await rejectIfAssigned({ github, context })) return { status: 'already_assigned' };

  return assignIssue({ github, context, username, approvedBy: approver });
}

async function handleUnclaim({ github, context }) {
  const commenter = context.payload.comment.user.login;
  const isAssigned = (context.payload.issue.assignees || []).some(
    (assignee) => assignee.login === commenter,
  );

  if (!isAssigned) {
    await comment({
      github,
      context,
      body: `❌ **@${commenter}** is not currently assigned to this issue. / 你目前没有认领此 Issue。`,
    });
    return { status: 'not_assigned' };
  }

  await github.rest.issues.removeAssignees({
    ...issueParams(context),
    assignees: [commenter],
  });

  try {
    await github.rest.issues.removeLabel({
      ...issueParams(context),
      name: CLAIMED_LABEL,
    });
  } catch (error) {
    if (error.status !== 404) throw error;
  }

  await comment({
    github,
    context,
    body: `👋 **@${commenter}** has unclaimed this issue. / 已取消认领。\n\nComment \`/claim\` if you would like to work on it.`,
  });
  return { status: 'unclaimed' };
}

async function handleCommunityLabel({ github, context }) {
  const removedLabels = [];

  for (const label of PUBLIC_DISCOVERY_LABELS) {
    if (!issueHasLabel(context.payload.issue, label)) continue;

    try {
      await github.rest.issues.removeLabel({
        ...issueParams(context),
        name: label,
      });
      removedLabels.push(label);
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }

  const { data: comments } = await github.rest.issues.listComments({
    ...issueParams(context),
    per_page: 100,
  });
  const alreadyExplained = comments.some((existingComment) =>
    existingComment.body?.includes(COMMUNITY_NOTICE_MARKER),
  );

  if (!alreadyExplained) {
    await comment({ github, context, body: COMMUNITY_NOTICE });
  }

  return { status: alreadyExplained ? 'already_explained' : 'explained', removedLabels };
}

async function handleIssuePolicy({ github, context }) {
  if (context.eventName === 'issues') {
    if (context.payload.label?.name !== COMMUNITY_ONLY_LABEL) return { status: 'ignored' };
    return handleCommunityLabel({ github, context });
  }

  if (context.eventName !== 'issue_comment' || context.payload.issue.pull_request) {
    return { status: 'ignored' };
  }

  const command = parseCommand(context.payload.comment.body);
  if (!command) return { status: 'ignored' };

  if (command.name === 'claim') return handleClaim({ github, context });
  if (command.name === 'unclaim') return handleUnclaim({ github, context });
  return handleApprove({ github, context, username: command.username });
}

module.exports = {
  APPROVAL_REQUIRED_LABELS,
  CLAIMED_LABEL,
  COMMUNITY_NOTICE,
  COMMUNITY_NOTICE_MARKER,
  COMMUNITY_ONLY_LABEL,
  ENHANCEMENT_LABEL,
  PUBLIC_DISCOVERY_LABELS,
  canModerate,
  findApprovalRequiredLabel,
  handleApprove,
  handleClaim,
  handleCommunityLabel,
  handleIssuePolicy,
  handleUnclaim,
  issueHasLabel,
  parseCommand,
};
