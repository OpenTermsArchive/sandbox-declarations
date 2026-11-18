#!/usr/bin/env node
import fs from 'node:fs';
import { parseArgs } from 'node:util';

import { createGitHub, STATUS_CONTEXT, VALIDATION_FAILURE } from './github.mjs';

const { values: options } = parseArgs({
  options: {
    decisions: { type: 'string' },
    limit: { type: 'string', default: '10' },
    retry: { type: 'boolean', default: false },
  },
});

const report = JSON.parse(fs.readFileSync(options.decisions));
const github = createGitHub({ token: process.env.GITHUB_TOKEN, repository: process.env.GITHUB_REPOSITORY });
const limit = Number.parseInt(options.limit, 10) || 0;
const selected = [];

for (const decision of report.decisions.filter(({ eligible }) => eligible)) {
  const statuses = await github.get(`/repos/{repository}/commits/${decision.headSha}/statuses?per_page=100`);
  const lastStatus = statuses.find(status => status.context === STATUS_CONTEXT);

  // Validating loads the tracked pages: a commit that already failed is not tried again on every run, a new push or an explicit retry is needed
  if (!options.retry && lastStatus?.state === 'failure' && lastStatus.description?.startsWith(VALIDATION_FAILURE)) {
    decision.validation = 'failed-before';
  } else if (selected.length >= limit) {
    decision.validation = 'deferred';
  } else {
    decision.validation = 'selected';
    selected.push({ number: decision.number });
  }
}

fs.writeFileSync(options.decisions, JSON.stringify(report, null, 2));
console.log(JSON.stringify(selected));
