#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { assess, compare } from './compare.mjs';
import { createGitHub } from './github.mjs';

const DECLARATION_PATH = /^declarations\/[^/]+\.json$/;
const OTA = './node_modules/.bin/ota';

const { values: options } = parseArgs({
  options: {
    decisions: { type: 'string' },
    pull: { type: 'string' },
    config: { type: 'string', default: fileURLToPath(new URL('./config.json', import.meta.url)) },
    output: { type: 'string', default: 'validation.json' },
  },
});

const config = JSON.parse(fs.readFileSync(options.config));
const decision = JSON.parse(fs.readFileSync(options.decisions)).decisions.find(({ number, eligible }) => eligible && String(number) === options.pull);
const failures = [];
const comparisons = [];

if (!decision) {
  throw new Error(`Pull request ${options.pull} is not eligible`);
}

const git = (...args) => execFileSync('git', args, { maxBuffer: 64 * 1024 * 1024 });

git('fetch', '--quiet', 'origin', `+refs/pull/${decision.number}/head:refs/pr/${decision.number}`);

if (git('rev-parse', `refs/pr/${decision.number}`).toString().trim() !== decision.headSha) {
  throw new Error('The pull request changed since it was evaluated');
}

for (const file of decision.files) {
  if (!DECLARATION_PATH.test(file.path)) {
    throw new Error('Unexpected file in the decision');
  }

  fs.writeFileSync(file.path, git('cat-file', 'blob', file.sha));
}

const versions = createGitHub({ token: process.env.GITHUB_TOKEN, repository: config.versionsRepository });

for (const service of decision.services) {
  const target = [ '--services', service.id, '--types', ...service.types ];

  if (spawnSync(OTA, [ 'validate', 'declarations', ...target ], { stdio: 'inherit' }).status !== 0) {
    failures.push(`${service.id}: the declaration does not pass validation`);
    continue;
  }

  spawnSync(OTA, [ 'track', ...target ], { stdio: 'inherit' });

  const history = JSON.parse(fs.readFileSync(`declarations/${service.id}.history.json`));

  for (const type of service.types) {
    const label = `${service.id} ‧ ${type}`;
    const versionPath = path.join('data/versions', service.id, `${type}.md`);
    const remotePath = `${encodeURIComponent(service.id)}/${encodeURIComponent(type)}.md`;

    if (!fs.existsSync(versionPath)) {
      failures.push(`${label}: no version could be extracted`);
      continue;
    }

    const referenceResponse = await fetch(`https://raw.githubusercontent.com/${config.versionsRepository}/HEAD/${remotePath}`);

    if (!referenceResponse.ok) {
      failures.push(`${label}: there is no recorded version to compare with`);
      continue;
    }

    const [lastCommit] = await versions.get(`/repos/{repository}/commits?path=${remotePath}&per_page=1`);
    const lastRecordedAt = lastCommit.commit.author.date;
    const { validUntil } = history[type].at(-1);
    const comparison = compare(fs.readFileSync(versionPath, 'utf8'), await referenceResponse.text());
    const failure = assess(comparison, config.comparison)
      // An older declaration that would claim to end before the last version it produced would be applied to the wrong snapshots when versions are extracted again
      ?? (Date.parse(validUntil) < Date.parse(lastRecordedAt) ? '"validUntil" is earlier than the last recorded version' : null);

    comparisons.push({ service: service.id, type, ...comparison, validUntil, lastRecordedAt, failure });

    if (failure) {
      failures.push(`${label}: ${failure}`);
    }
  }
}

fs.writeFileSync(options.output, JSON.stringify({ number: decision.number, headSha: decision.headSha, comparisons, failures }, null, 2));

if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = comparisons.map(({ service, type, similarity, sizeRatio, validUntil, lastRecordedAt, failure }) => `| ${service} | ${type} | ${similarity.toFixed(2)} | ${sizeRatio.toFixed(2)} | ${validUntil} | ${lastRecordedAt} | ${failure ?? 'ok'} |`);

  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
    `### Pull request #${decision.number}`,
    '',
    '| Service | Terms | Similarity | Size ratio | validUntil | Last recorded version | Result |',
    '|---|---|---|---|---|---|---|',
    ...rows,
    '',
    ...failures.map(failure => `- ${failure}`),
    '',
  ].join('\n'));
}

console.log(failures.length ? `Failed:\n${failures.join('\n')}` : 'Passed');
process.exit(failures.length ? 1 : 0);
