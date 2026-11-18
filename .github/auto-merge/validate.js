#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { parseArgs } from 'node:util';

const DECLARATION_PATH = /^declarations\/[^/]+\.json$/;
const OTA = './node_modules/.bin/ota';

const { values: options } = parseArgs({
  options: {
    decisions: { type: 'string' },
    pull: { type: 'string' },
  },
});

const decision = JSON.parse(fs.readFileSync(options.decisions)).decisions.find(({ number, eligible }) => eligible && String(number) === options.pull);

if (!decision) {
  throw new Error(`Pull request ${options.pull} is not eligible`);
}

const git = (...args) => execFileSync('git', args, { maxBuffer: 64 * 1024 * 1024 });

git('fetch', '--quiet', 'origin', `+refs/pull/${decision.number}/head:refs/pr/${decision.number}`);

if (git('rev-parse', `refs/pr/${decision.number}`).toString().trim() !== decision.headSha) {
  throw new Error('The pull request changed since it was evaluated');
}

// Only the files that passed the rules are brought in, as plain content: the engine, its dependencies and everything else stay those of main
for (const file of decision.files) {
  if (!DECLARATION_PATH.test(file.path)) {
    throw new Error('Unexpected file in the decision');
  }

  fs.writeFileSync(file.path, git('cat-file', 'blob', file.sha));
}

const passes = args => spawnSync(OTA, args, { stdio: 'inherit' }).status === 0;

// The lint is run as well: validate does not check the formatting, and a badly formatted file merged here fails the lint of every later pull request. Both run so that the log shows every error
const failures = decision.services.filter(service => {
  const linted = passes([ 'lint', '--services', service.id ]);
  const validated = passes([ 'validate', 'declarations', '--services', service.id, '--types', ...service.types ]);

  return !linted || !validated;
});

console.log(failures.length ? `Failed: ${failures.map(service => service.id).join(', ')}` : 'Passed');
process.exit(failures.length ? 1 : 0);
