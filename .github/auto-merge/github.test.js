import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import { createGitHub, ownApproval, setStatus, STATUS_CONTEXT } from './github.js';

const github = createGitHub({ token: 'token', repository: 'owner/repository' });

function answerWith(...responses) {
  const queue = [...responses];

  return mock.method(globalThis, 'fetch', async () => new Response(...queue.shift()));
}

describe('github', () => {
  afterEach(() => mock.restoreAll());

  describe('requests', () => {
    it('does not send a POST again after a server error, since it may have been applied', async () => {
      const fetch = answerWith([ 'bad gateway', { status: 502 } ], [ '{}', { status: 200 } ]);

      await assert.rejects(github.post('/repos/{repository}/pulls/1/reviews', { event: 'APPROVE' }), { status: 502 });
      assert.equal(fetch.mock.callCount(), 1);
    });
  });

  describe('statuses', () => {
    const status = { state: 'failure', description: 'a declaration changes while its history file does not', targetUrl: 'https://github.com/owner/repository/actions/runs/2' };

    function fakeGitHub(statuses) {
      return { get: mock.fn(async () => statuses), post: mock.fn(async () => ({})) };
    }

    it('posts a status that differs from the last one', async () => {
      const fake = fakeGitHub([{ context: STATUS_CONTEXT, state: 'pending', description: 'waiting for validation' }]);

      await setStatus(fake, 'sha', status);

      assert.deepEqual(fake.post.mock.calls[0].arguments, [ '/repos/{repository}/statuses/sha', { context: STATUS_CONTEXT, state: 'failure', description: status.description, target_url: status.targetUrl }]);
    });

    // GitHub refuses more than 1000 statuses per commit and context, which hourly runs reach in about 42 days
    it('does not post again the last status', async () => {
      const fake = fakeGitHub([{ context: STATUS_CONTEXT, state: 'failure', description: status.description }]);

      await setStatus(fake, 'sha', status);

      assert.equal(fake.post.mock.callCount(), 0);
    });

    it('only compares with the statuses of its own context', async () => {
      const fake = fakeGitHub([{ context: 'other', state: 'failure', description: status.description }]);

      await setStatus(fake, 'sha', status);

      assert.equal(fake.post.mock.callCount(), 1);
    });
  });

  describe('approvals of the merging application', () => {
    const own = { login: 'ota-auto-merge[bot]', sha: 'head' };
    const review = (state, { login = own.login, sha = own.sha } = {}) => ({ id: state, state, user: { login }, commit_id: sha });

    it('finds no approval on a commit never approved', () => {
      assert.deepEqual(ownApproval([], own), { failedBefore: false, approval: undefined });
    });

    it('reuses an approval that is still there, so as not to approve twice', () => {
      assert.deepEqual(ownApproval([review('APPROVED')], own), { failedBefore: false, approval: review('APPROVED') });
    });

    it('tells that merging the commit already failed when its approval was dismissed', () => {
      assert.equal(ownApproval([review('DISMISSED')], own).failedBefore, true);
    });

    it('ignores the reviews of others and those of other commits', () => {
      assert.deepEqual(ownApproval([ review('DISMISSED', { login: 'maintainer' }), review('DISMISSED', { sha: 'previous' }) ], own), { failedBefore: false, approval: undefined });
    });
  });
});
