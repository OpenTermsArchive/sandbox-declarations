#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { createGit, evaluate } from './gate.mjs';
import { createGitHub, validationConclusions, validationJobName } from './github.mjs';

const MERGED_LABEL = 'auto-merged';

const { values: options } = parseArgs({
  options: {
    decisions: { type: 'string' },
    config: { type: 'string', default: fileURLToPath(new URL('./config.json', import.meta.url)) },
    limit: { type: 'string', default: '2' },
    'dry-run': { type: 'boolean', default: false },
  },
});

const config = JSON.parse(fs.readFileSync(options.config));
const { decisions, enabledTiers } = JSON.parse(fs.readFileSync(options.decisions));
const limit = Number.parseInt(options.limit, 10) || 0;
const reader = createGitHub({ token: process.env.GITHUB_TOKEN, repository: process.env.GITHUB_REPOSITORY });
const merger = createGitHub({ token: process.env.MERGE_TOKEN, repository: process.env.GITHUB_REPOSITORY });
const conclusions = await validationConclusions(reader, process.env.GITHUB_RUN_ID);
const git = createGit('.');
let merged = 0;

// GitHub closes the issues a pull request fixes on behalf of whoever merges it, and the merging application has no right on issues: it is done here instead
async function closeLinkedIssues(pullRequestNumber) {
  const [ owner, name ] = process.env.GITHUB_REPOSITORY.split('/');
  const { data } = await reader.post('https://api.github.com/graphql', {
    query: 'query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { closingIssuesReferences(first: 50) { nodes { number state repository { nameWithOwner } } } } } }',
    variables: { owner, name, number: pullRequestNumber },
  });

  for (const issue of data.repository.pullRequest.closingIssuesReferences.nodes) {
    if (issue.state === 'OPEN' && issue.repository.nameWithOwner === process.env.GITHUB_REPOSITORY) {
      await reader.patch(`/repos/{repository}/issues/${issue.number}`, { state: 'closed', state_reason: 'completed' });
      console.log(`#${pullRequestNumber}: closed issue #${issue.number}`);
    }
  }
}

for (const decision of decisions.filter(({ eligible }) => eligible)) {
  if (conclusions.get(validationJobName(decision.number)) !== 'success') {
    console.log(`#${decision.number}: validation did not pass or did not run`);
    continue;
  }

  if (merged >= limit) {
    console.log(`#${decision.number}: left for the next run, the limit of ${limit} merges is reached`);
    continue;
  }

  // Earlier merges of this run moved main, and the pull request may have changed since it was evaluated: nothing decided before this point is taken for granted
  const pullRequest = await reader.get(`/repos/{repository}/pulls/${decision.number}`);

  execFileSync('git', [ 'fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main', `+refs/pull/${decision.number}/head:refs/pr/${decision.number}` ]);

  const current = evaluate({ pullRequest, git, config, enabledTiers });

  if (pullRequest.state !== 'open' || !current.eligible || current.headSha !== decision.headSha || JSON.stringify(current.files) !== JSON.stringify(decision.files)) {
    console.log(`#${decision.number}: no longer what was tested (${current.reason})`);
    continue;
  }

  const title = `Update ${decision.services.map(service => service.id).join(', ')} (#${decision.number})`;
  const message = `Merged automatically in tier ${decision.tier}: the tests of the auto-merge workflow pass on ${decision.headSha}.`;

  if (options['dry-run']) {
    console.log(`#${decision.number}: would merge as "${title}"`);
    merged++;
    continue;
  }

  let review;

  try {
    review = await merger.post(`/repos/{repository}/pulls/${decision.number}/reviews`, { commit_id: decision.headSha, event: 'APPROVE' });
    // The title and the message are written here because those of the pull request are free text: "[skip ci]" in them would keep the merge from being deployed
    await merger.put(`/repos/{repository}/pulls/${decision.number}/merge`, { sha: decision.headSha, merge_method: 'squash', commit_title: title, commit_message: message });
  } catch (error) {
    // An error does not prove that nothing happened: a merge whose answer was lost must not be reported as refused, nor leave an approval behind when it did fail
    const { merged: mergedAnyway } = await reader.get(`/repos/{repository}/pulls/${decision.number}`).catch(() => ({}));

    if (!mergedAnyway) {
      if (review) {
        await merger.put(`/repos/{repository}/pulls/${decision.number}/reviews/${review.id}/dismissals`, { message: 'The automatic merge failed.', event: 'DISMISS' }).catch(dismissalError => console.log(`#${decision.number}: approval not dismissed (${dismissalError.message})`));
      }

      console.log(`#${decision.number}: merge refused (${error.message})`);
      continue;
    }
  }

  merged++;
  console.log(`#${decision.number}: merged`);
  await merger.post(`/repos/{repository}/issues/${decision.number}/labels`, { labels: [MERGED_LABEL] }).catch(error => console.log(`#${decision.number}: label not set (${error.message})`));
  await closeLinkedIssues(decision.number).catch(error => console.log(`#${decision.number}: linked issues not closed (${error.message})`));
}

console.log(`${merged} pull request(s) ${options['dry-run'] ? 'would be ' : ''}merged`);
