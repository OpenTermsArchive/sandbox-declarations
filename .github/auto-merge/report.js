#!/usr/bin/env node
import fs from 'node:fs';
import { parseArgs } from 'node:util';

import { commentFor, setComment } from './comment.js';
import { createGitHub, setStatus, VALIDATION_FAILURE, validationConclusions, validationJobName } from './github.js';

const DESCRIPTION_LIMIT = 140;

const { values: options } = parseArgs({ options: { decisions: { type: 'string' } } });
const { decisions } = JSON.parse(fs.readFileSync(options.decisions));
const github = createGitHub({ token: process.env.GITHUB_TOKEN, repository: process.env.GITHUB_REPOSITORY });
const conclusions = await validationConclusions(github, process.env.GITHUB_RUN_ID);
const runUrl = `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
const rows = [];

function outcomeOf(decision, validation) {
  if (!decision.eligible) {
    return decision.reason;
  }

  if (decision.validation === 'failed-before') {
    return 'validation already failed on this commit';
  }

  if (decision.validation === 'deferred') {
    return 'waiting for validation';
  }

  return validation === 'success' ? 'tests pass' : `${VALIDATION_FAILURE}: see the run for details`;
}

for (const decision of decisions) {
  const validation = decision.validation === 'selected' ? conclusions.get(validationJobName(decision.number)) : null;
  const passed = validation === 'success';
  const waiting = decision.eligible && decision.validation === 'deferred';
  const outcome = outcomeOf(decision, validation);

  rows.push(`| #${decision.number} | ${passed ? 'pass' : 'fail'} | ${outcome} |`);

  try {
    await setComment(github, decision.number, ({ hasComment }) => commentFor(decision, { validation, hasComment }));
  } catch (error) {
    console.error(`#${decision.number}: comment not set (${error.message})`);
    process.exitCode = 1;
  }

  // A status is only posted where the tests are meant to decide: pull requests left to a maintainer only get the comment
  if (!decision.withinScope || !decision.headSha || decision.validation === 'failed-before') {
    continue;
  }

  try {
    await setStatus(github, decision.headSha, {
      state: passed ? 'success' : waiting ? 'pending' : 'failure',
      description: outcome.slice(0, DESCRIPTION_LIMIT),
      targetUrl: runUrl,
    });
  } catch (error) {
    console.error(`#${decision.number}: status not set (${error.message})`);
    process.exitCode = 1;
  }
}

if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
    '| Pull request | Tests | Outcome |',
    '|---|---|---|',
    ...rows,
    '',
  ].join('\n'));
}
