import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const {
  CLAIMED_LABEL,
  COMMUNITY_NOTICE_MARKER,
  handleApprove,
  handleClaim,
  handleCommunityLabel,
  parseCommand,
} = require('./community-issue-policy.cjs');

function makeContext({ labels = [], assignees = [], commenter = 'contributor' } = {}) {
  return {
    repo: { owner: 'Nagi-ovo', repo: 'voyager' },
    payload: {
      issue: { number: 42, labels, assignees },
      comment: { body: '/claim', user: { login: commenter } },
    },
  };
}

function makeGithub({ permission = 'read', comments = [] } = {}) {
  return {
    rest: {
      issues: {
        addAssignees: vi.fn().mockResolvedValue({}),
        addLabels: vi.fn().mockResolvedValue({}),
        createComment: vi.fn().mockResolvedValue({}),
        listComments: vi.fn().mockResolvedValue({ data: comments }),
        removeAssignees: vi.fn().mockResolvedValue({}),
        removeLabel: vi.fn().mockResolvedValue({}),
      },
      repos: {
        getCollaboratorPermissionLevel: vi.fn().mockResolvedValue({
          data: { permission },
        }),
      },
    },
  };
}

describe('community issue policy', () => {
  it('only accepts exact claim commands and a valid approval target', () => {
    expect(parseCommand(' /claim ')).toEqual({ name: 'claim' });
    expect(parseCommand('/unclaim')).toEqual({ name: 'unclaim' });
    expect(parseCommand('/approve @valid-user')).toEqual({
      name: 'approve',
      username: 'valid-user',
    });
    expect(parseCommand('please /claim this')).toBeNull();
    expect(parseCommand('/approve @-invalid')).toBeNull();
  });

  it('explains community-only rules and removes public discovery labels', async () => {
    const github = makeGithub();
    const context = makeContext({
      labels: ['community-only', 'help wanted', { name: 'good first issue' }],
    });

    const result = await handleCommunityLabel({ github, context });

    expect(result).toEqual({
      status: 'explained',
      removedLabels: ['good first issue', 'help wanted'],
    });
    expect(github.rest.issues.removeLabel).toHaveBeenCalledTimes(2);
    expect(github.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining(COMMUNITY_NOTICE_MARKER) }),
    );
  });

  it('does not post the community notice twice', async () => {
    const github = makeGithub({ comments: [{ body: COMMUNITY_NOTICE_MARKER }] });
    const context = makeContext({ labels: ['community-only'] });

    await expect(handleCommunityLabel({ github, context })).resolves.toEqual({
      status: 'already_explained',
      removedLabels: [],
    });
    expect(github.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it('requires maintainer approval for a community-only claim', async () => {
    const github = makeGithub({ permission: 'read' });
    const context = makeContext({ labels: ['community-only'], commenter: 'new-member' });

    await expect(handleClaim({ github, context })).resolves.toEqual({
      status: 'awaiting_approval',
      username: 'new-member',
    });
    expect(github.rest.issues.addAssignees).not.toHaveBeenCalled();
    expect(github.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('/approve @new-member') }),
    );
  });

  it('requires maintainer approval for a feature-level claim', async () => {
    const github = makeGithub({ permission: 'read' });
    const context = makeContext({ labels: ['enhancement'], commenter: 'drive-by' });

    await expect(handleClaim({ github, context })).resolves.toEqual({
      status: 'awaiting_approval',
      username: 'drive-by',
    });
    expect(github.rest.issues.addAssignees).not.toHaveBeenCalled();
    expect(github.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('feature-level work item') }),
    );
  });

  it('lets a maintainer approve a feature-level claim', async () => {
    const github = makeGithub({ permission: 'write' });
    const context = makeContext({ labels: ['enhancement'], commenter: 'maintainer' });

    await expect(handleApprove({ github, context, username: 'contributor' })).resolves.toEqual({
      status: 'assigned',
      username: 'contributor',
    });
    expect(github.rest.issues.addAssignees).toHaveBeenCalledWith(
      expect.objectContaining({ assignees: ['contributor'] }),
    );
  });

  it('rejects /approve on issues that do not gate claims', async () => {
    const github = makeGithub({ permission: 'admin' });
    const context = makeContext({ labels: ['bug'], commenter: 'maintainer' });

    await expect(handleApprove({ github, context, username: 'contributor' })).resolves.toEqual({
      status: 'not_approval_required',
    });
    expect(github.rest.issues.addAssignees).not.toHaveBeenCalled();
  });

  it('lets a maintainer claim a feature-level issue directly', async () => {
    const github = makeGithub({ permission: 'admin' });
    const context = makeContext({ labels: ['enhancement'], commenter: 'maintainer' });

    await expect(handleClaim({ github, context })).resolves.toEqual({
      status: 'assigned',
      username: 'maintainer',
    });
  });

  it('keeps ordinary issues open to direct claims', async () => {
    const github = makeGithub();
    const context = makeContext({ commenter: 'outside-contributor' });

    await expect(handleClaim({ github, context })).resolves.toEqual({
      status: 'assigned',
      username: 'outside-contributor',
    });
    expect(github.rest.issues.addAssignees).toHaveBeenCalledWith(
      expect.objectContaining({ assignees: ['outside-contributor'] }),
    );
    expect(github.rest.issues.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: [CLAIMED_LABEL] }),
    );
  });

  it('lets a maintainer approve a community member', async () => {
    const github = makeGithub({ permission: 'admin' });
    const context = makeContext({ labels: ['community-only'], commenter: 'maintainer' });

    await expect(handleApprove({ github, context, username: 'community-member' })).resolves.toEqual(
      { status: 'assigned', username: 'community-member' },
    );
    expect(github.rest.issues.addAssignees).toHaveBeenCalledWith(
      expect.objectContaining({ assignees: ['community-member'] }),
    );
    expect(github.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('@maintainer') }),
    );
  });

  it('rejects approval commands from users without write permission', async () => {
    const github = makeGithub({ permission: 'read' });
    const context = makeContext({ labels: ['community-only'], commenter: 'outsider' });

    await expect(handleApprove({ github, context, username: 'friend' })).resolves.toEqual({
      status: 'forbidden',
    });
    expect(github.rest.issues.addAssignees).not.toHaveBeenCalled();
  });
});
