export const COMMENT_MARKER = '<!-- auto-merge -->';
export const COMMENT_AUTHOR = 'github-actions[bot]';

const HEADER = '**Automatic merge**';

// Refusals that no change to the pull request can lift: the pull request is outside what merges on its own
const LEFT_TO_A_MAINTAINER = [
  /adds a new service/,
  /adds or removes terms/,
  /changes more than/,
  /something else than JSON files/,
  /deletes a file/,
  /not a regular file/,
  /adds a file that is not the history/,
  /host where anyone can publish/,
];

// Refusals that say nothing about the content: the pull request is left without a comment
const NOT_COMMENTED = [
  /is a draft/,
  /is on hold/,
  /changed while it was being evaluated/,
  /could not be completed/,
];

function body(...paragraphs) {
  return [ COMMENT_MARKER, HEADER, ...paragraphs ].join('\n\n');
}

// Returns the body of the comment, or null to leave the pull request as it is. `hasComment` tells whether the pull request already has one, which then has to be kept up to date
export function commentFor(decision, { validation, hasComment }) {
  if (!decision.eligible) {
    if (NOT_COMMENTED.some(pattern => pattern.test(decision.reason))) {
      return null;
    }

    const nextStep = LEFT_TO_A_MAINTAINER.some(pattern => pattern.test(decision.reason))
      ? 'A maintainer has to review it.'
      : 'Once the pull request is updated, it is evaluated again within the hour. If the change cannot follow this rule, a maintainer has to review it.';

    return body(`This pull request is not merged automatically: ${decision.reason}.`, nextStep);
  }

  if (decision.validation === 'deferred') {
    return hasComment ? body('This pull request is waiting for its validation, which runs within the next hours.') : null;
  }

  if (validation === 'success') {
    return hasComment ? body('The tests pass: this pull request will be merged automatically.') : null;
  }

  // Also said on later runs, which skip a commit whose validation already failed: the comment then still holds the reason, whatever it said before. It points to the status rather than to a run, so that it reads the same on every run
  return body(
    'This pull request is not merged automatically: the declaration does not pass validation with the engine of the main branch. The details are behind the "Details" link of the `auto-merge` check.',
    'Once the pull request is updated, it is validated again within the hour. If the page cannot be reached from the servers of GitHub, a maintainer has to review it.',
  );
}

export async function findComment(github, pullRequestNumber) {
  const comments = await github.list(`/repos/{repository}/issues/${pullRequestNumber}/comments?per_page=100`);

  return comments.find(({ user, body: text }) => user?.login === COMMENT_AUTHOR && text?.startsWith(COMMENT_MARKER));
}

// A single comment per pull request, edited in place: the workflow runs every hour and would otherwise post the same explanation again each time
export async function setComment(github, pullRequestNumber, decide) {
  const existing = await findComment(github, pullRequestNumber);
  const text = decide({ hasComment: Boolean(existing) });

  if (!text || existing?.body === text) {
    return;
  }

  if (existing) {
    await github.patch(`/repos/{repository}/issues/comments/${existing.id}`, { body: text });
  } else {
    await github.post(`/repos/{repository}/issues/${pullRequestNumber}/comments`, { body: text });
  }
}
