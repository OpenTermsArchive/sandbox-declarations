import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import { createGitHub } from './github.js';

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
});
