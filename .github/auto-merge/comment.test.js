import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { COMMENT_AUTHOR, COMMENT_MARKER, commentFor, setComment } from './comment.js';

const refused = reason => ({ number: 1, eligible: false, reason });
const eligible = validation => ({ number: 1, eligible: true, withinScope: true, validation });
const commentOn = (decision, { validation = null, hasComment = false } = {}) => commentFor(decision, { validation, hasComment });

describe('comment', () => {
  describe('content', () => {
    it('explains a refusal the contributor can fix', () => {
      const text = commentOn(refused('a changed file has also changed on main since the pull request branched off: rebase it'));

      assert.ok(text.startsWith(COMMENT_MARKER));
      assert.match(text, /not merged automatically: a changed file has also changed on main since the pull request branched off: rebase it\./);
      assert.match(text, /evaluated again within the hour/);
    });

    it('says that a maintainer reviews a pull request outside what merges on its own', () => {
      const text = commentOn(refused('the pull request changes something else than JSON files in the declarations directory'));

      assert.match(text, /A maintainer has to review it\./);
      assert.doesNotMatch(text, /will review/);
      assert.doesNotMatch(text, /evaluated again/);
    });

    for (const reason of [
      'the pull request adds a new service',
      'the pull request adds or removes terms types',
      'the pull request changes more than the terms of a service, such as its name',
      'the pull request changes more than the selectors of a document or its address on the same website',
    ]) {
      it(`leaves to a maintainer a pull request that ${reason.replace('the pull request ', '')}`, () => {
        assert.match(commentOn(refused(reason)), /A maintainer has to review it\./);
      });
    }

    it('sends to a maintainer a new address on a host where anyone can publish', () => {
      assert.match(commentOn(refused('a fetch location changes on a host where anyone can publish')), /A maintainer has to review it\./);
    });

    it('points to the check when the validation fails', () => {
      assert.match(commentOn(eligible('selected'), { validation: 'failure' }), /does not pass validation.*`auto-merge` check/);
    });

    for (const reason of [ 'the pull request is a draft', 'the pull request is on hold', 'the pull request changed while it was being evaluated', 'the evaluation could not be completed' ]) {
      it(`does not comment when ${reason}`, () => {
        assert.equal(commentOn(refused(reason), { hasComment: true }), null);
      });
    }

    it('says the same on later runs as on the run where the validation failed', () => {
      const failed = commentOn(eligible('selected'), { validation: 'failure' });

      assert.equal(commentOn(eligible('failed-before'), { hasComment: true }), failed);
    });

    it('replaces the reason of an earlier refusal once the validation failed', () => {
      assert.match(commentOn(eligible('failed-before'), { hasComment: true }), /does not pass validation/);
    });

    it('does not comment a pull request that passes, unless a comment has to be corrected', () => {
      assert.equal(commentOn(eligible('selected'), { validation: 'success' }), null);
      assert.match(commentOn(eligible('selected'), { validation: 'success', hasComment: true }), /will be merged automatically/);
    });

    it('does not comment a pull request waiting for validation, unless a comment has to be corrected', () => {
      assert.equal(commentOn(eligible('deferred')), null);
      assert.match(commentOn(eligible('deferred'), { hasComment: true }), /waiting for its validation/);
    });
  });

  describe('publication', () => {
    const own = (id, body) => ({ id, body, user: { login: COMMENT_AUTHOR } });

    function fakeGitHub(comments) {
      return { list: mock.fn(async () => comments), post: mock.fn(async () => ({})), patch: mock.fn(async () => ({})) };
    }

    it('posts a comment when there is none', async () => {
      const github = fakeGitHub([]);

      await setComment(github, 7, () => `${COMMENT_MARKER}\n\nnew`);

      assert.equal(github.post.mock.callCount(), 1);
      assert.equal(github.post.mock.calls[0].arguments[0], '/repos/{repository}/issues/7/comments');
      assert.equal(github.patch.mock.callCount(), 0);
    });

    it('edits its own comment in place instead of posting another one', async () => {
      const github = fakeGitHub([ own(3, `${COMMENT_MARKER}\n\nold`) ]);

      await setComment(github, 7, () => `${COMMENT_MARKER}\n\nnew`);

      assert.equal(github.post.mock.callCount(), 0);
      assert.equal(github.patch.mock.calls[0].arguments[0], '/repos/{repository}/issues/comments/3');
    });

    it('does nothing when its comment already says the same', async () => {
      const github = fakeGitHub([own(3, `${COMMENT_MARKER}\n\nsame`)]);

      await setComment(github, 7, () => `${COMMENT_MARKER}\n\nsame`);

      assert.equal(github.post.mock.callCount() + github.patch.mock.callCount(), 0);
    });

    it('ignores the same marker in a comment written by someone else', async () => {
      const github = fakeGitHub([{ id: 4, body: `${COMMENT_MARKER}\n\nforged`, user: { login: 'someone' } }]);
      let hasComment;

      await setComment(github, 7, context => { ({ hasComment } = context); return null; });

      assert.equal(hasComment, false);
    });

    it('leaves the pull request as it is when there is nothing to say', async () => {
      const github = fakeGitHub([own(3, `${COMMENT_MARKER}\n\nold`)]);

      await setComment(github, 7, () => null);

      assert.equal(github.post.mock.callCount() + github.patch.mock.callCount(), 0);
    });
  });
});
