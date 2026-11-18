import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { checkLocation, classify, createGit, evaluate, parseStrictJSON, Refusal } from './gate.js';

const NOW = new Date('2026-11-18T00:00:00Z');
const CONFIG = { sharedHosts: ['shared.example'], limits: {} };

const MAIN_DECLARATION = {
  name: 'Service',
  terms: {
    'Terms of Service': { fetch: 'https://service.example/terms', select: '.old' },
    'Privacy Policy': { fetch: 'https://service.example/privacy', select: '.old', remove: '.banner' },
  },
};
const MAIN_HISTORY = { 'Privacy Policy': [{ fetch: 'https://service.example/privacy', select: '.older', validUntil: '2024-01-01T00:00:00Z' }] };

const json = value => `${JSON.stringify(value, null, 2)}\n`;

function fixedDeclaration(changes = { select: '.new' }) {
  return { ...MAIN_DECLARATION, terms: { ...MAIN_DECLARATION.terms, 'Terms of Service': { ...MAIN_DECLARATION.terms['Terms of Service'], ...changes } } };
}

function fixedHistory(validUntil = '2026-10-01T00:00:00Z') {
  return { ...MAIN_HISTORY, 'Terms of Service': [{ ...MAIN_DECLARATION.terms['Terms of Service'], validUntil }] };
}

describe('gate', () => {
  let repositoryPath;
  let git;
  let pullRequestCount = 0;

  const run = (...args) => execFileSync('git', [ '-C', repositoryPath, ...args ], { stdio: [ 'ignore', 'pipe', 'pipe' ] }).toString().trim();

  function commit(files, message) {
    for (const [ filePath, content ] of Object.entries(files)) {
      const absolutePath = path.join(repositoryPath, filePath);

      if (content === null) {
        fs.rmSync(absolutePath);
      } else {
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        fs.writeFileSync(absolutePath, content);
      }
    }
    run('add', '-A');
    run('commit', '-q', '--allow-empty', '-m', message);

    return run('rev-parse', 'HEAD');
  }

  function openPullRequest(files, overrides = {}) {
    const number = ++pullRequestCount;

    run('checkout', '-q', '-B', `pr-${number}`, overrides.from ?? 'main');
    const sha = overrides.prepare ? overrides.prepare() : commit(files, `Pull request ${number}`);

    run('update-ref', `refs/pr/${number}`, sha);
    run('checkout', '-q', 'main');

    return {
      number,
      draft: false,
      auto_merge: null,
      labels: [],
      base: { ref: 'main' },
      head: { sha },
      ...overrides.pullRequest,
    };
  }

  const decide = pullRequest => evaluate({ pullRequest, git, config: CONFIG, mainRef: 'refs/heads/main', now: NOW });

  function assertRefused(decision, reasonPattern) {
    assert.equal(decision.eligible, false);
    assert.match(decision.reason, reasonPattern);
    assert.deepEqual(decision.files, []);
  }

  before(() => {
    repositoryPath = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
    execFileSync('git', [ 'init', '-q', '-b', 'main', repositoryPath ]);
    run('config', 'user.name', 'Test');
    run('config', 'user.email', 'test@example.com');
    run('config', 'core.symlinks', 'true');
    commit({
      'declarations/Service.json': json(MAIN_DECLARATION),
      'declarations/Service.history.json': json(MAIN_HISTORY),
      'declarations/Service.filters.js': 'export function clean() {}\n',
      'declarations/Other.json': json({ name: 'Other', terms: { Imprint: { fetch: 'https://other.example/imprint', select: 'body' } } }),
      'package.json': '{}\n',
    }, 'Initial declarations');
    git = createGit(repositoryPath);
  });

  after(() => fs.rmSync(repositoryPath, { recursive: true, force: true }));

  describe('eligible pull requests', () => {
    it('accepts a selector fix with its history entry in tier P1', () => {
      const decision = decide(openPullRequest({ 'declarations/Service.json': json(fixedDeclaration()), 'declarations/Service.history.json': json(fixedHistory()) }));

      assert.equal(decision.eligible, true, decision.reason);
      assert.equal(decision.tier, 'P1');
      assert.deepEqual(decision.services, [{ id: 'Service', types: ['Terms of Service'] }]);
      assert.deepEqual(decision.files.map(file => file.path), [ 'declarations/Service.json', 'declarations/Service.history.json' ]);
    });

    it('accepts the creation of the history file of an existing service', () => {
      const declaration = { name: 'Other', terms: { Imprint: { fetch: 'https://other.example/imprint', select: 'main' } } };
      const history = { Imprint: [{ fetch: 'https://other.example/imprint', select: 'body', validUntil: '2026-10-01T00:00:00Z' }] };
      const decision = decide(openPullRequest({ 'declarations/Other.json': json(declaration), 'declarations/Other.history.json': json(history) }));

      assert.equal(decision.eligible, true, decision.reason);
    });

    it('classifies a path change on the same host in tier P2', () => {
      const decision = decide(openPullRequest({ 'declarations/Service.json': json(fixedDeclaration({ fetch: 'https://service.example/legal/terms' })), 'declarations/Service.history.json': json(fixedHistory()) }));

      assert.equal(decision.eligible, true, decision.reason);
      assert.equal(decision.tier, 'P2');
    });

    it('still accepts a pull request when main moved without touching its files', () => {
      const pullRequest = openPullRequest({ 'declarations/Service.json': json(fixedDeclaration()), 'declarations/Service.history.json': json(fixedHistory()) });

      commit({ 'declarations/Third.json': json({ name: 'Third', terms: {} }) }, 'Unrelated change on main');

      assert.equal(decide(pullRequest).eligible, true);
    });
  });

  describe('tiers', () => {
    it('never merges a change of host', () => {
      const pullRequest = openPullRequest({ 'declarations/Service.json': json(fixedDeclaration({ fetch: 'https://elsewhere.example/terms' })), 'declarations/Service.history.json': json(fixedHistory()) });

      assertRefused(decide(pullRequest), /tier P3/);
    });

    it('never merges a new service', () => {
      const pullRequest = openPullRequest({ 'declarations/New.json': json({ name: 'New', terms: {} }) });

      assertRefused(decide(pullRequest), /tier P4/);
    });

    for (const [ title, declaration ] of Object.entries({
      'a changed filter': fixedDeclaration({ filter: ['clean'] }),
      'a changed name': { ...fixedDeclaration(), name: 'Renamed' },
      'an added terms type': { ...MAIN_DECLARATION, terms: { ...MAIN_DECLARATION.terms, Imprint: { fetch: 'https://service.example/imprint', select: 'body' } } },
      'a removed terms type': { ...MAIN_DECLARATION, terms: { 'Terms of Service': fixedDeclaration().terms['Terms of Service'] } },
      'an unknown key': fixedDeclaration({ unknown: true }),
    })) {
      it(`puts ${title} in tier P3`, () => {
        assert.equal(classify(MAIN_DECLARATION, declaration).tier, 'P3');
      });
    }
  });

  describe('files', () => {
    const validFiles = () => ({ 'declarations/Service.json': json(fixedDeclaration()), 'declarations/Service.history.json': json(fixedHistory()) });

    for (const [ title, files ] of Object.entries({
      'a filters file': { 'declarations/Service.filters.js': 'export function clean() { process.exit() }\n' },
      'a file outside the declarations directory': { 'package.json': '{"scripts":{}}\n' },
      'a workflow': { '.github/workflows/test.yml': 'on: push\n' },
    })) {
      it(`refuses ${title}`, () => {
        assertRefused(decide(openPullRequest({ ...validFiles(), ...files })), /something else than JSON files/);
      });
    }

    it('refuses a declaration replaced by a directory', () => {
      assertRefused(decide(openPullRequest({ 'declarations/Service.json': null, 'declarations/Service.json/payload.json': '{}\n' })), /deletes a file|something else than JSON files/);
    });

    it('refuses more files than a declaration fix needs', () => {
      const files = Object.fromEntries(Array.from({ length: 11 }, (_, index) => [ `declarations/Service ${index}.json`, '{}\n' ]));

      assertRefused(decide(openPullRequest(files)), /too many files/);
    });

    it('refuses a deleted declaration', () => {
      assertRefused(decide(openPullRequest({ 'declarations/Other.json': null })), /deletes a file/);
    });

    it('refuses a symbolic link', () => {
      const pullRequest = openPullRequest({}, {
        prepare() {
          fs.rmSync(path.join(repositoryPath, 'declarations/Service.json'));
          fs.symlinkSync('../package.json', path.join(repositoryPath, 'declarations/Service.json'));

          return commit({}, 'Symbolic link');
        },
      });

      assertRefused(decide(pullRequest), /not a regular file/);
    });

    it('refuses an added JSON file next to an existing service', () => {
      assertRefused(decide(openPullRequest({ ...validFiles(), 'declarations/Service.filters.json': '{}\n' })), /tier P4/);
    });

    it('refuses a declaration that changes without its history', () => {
      assertRefused(decide(openPullRequest({ 'declarations/Service.json': json(fixedDeclaration()) })), /history file does not/);
    });

    it('refuses a history that changes without its declaration', () => {
      assertRefused(decide(openPullRequest({ 'declarations/Service.history.json': json(fixedHistory()) })), /declaration does not/);
    });

    it('refuses a file that also changed on main since the pull request branched off', () => {
      const pullRequest = openPullRequest(validFiles());

      commit({ 'declarations/Service.json': json(fixedDeclaration({ select: '.changed-on-main' })) }, 'Concurrent change on main');
      try {
        assertRefused(decide(pullRequest), /rebase/);
      } finally {
        commit({ 'declarations/Service.json': json(MAIN_DECLARATION) }, 'Restore main');
      }
    });

    it('refuses a head that is not the evaluated one', () => {
      const pullRequest = openPullRequest(validFiles());

      pullRequest.head.sha = run('rev-parse', 'main');

      assertRefused(decide(pullRequest), /changed while/);
    });
  });

  describe('state of the pull request', () => {
    const open = pullRequest => openPullRequest({ 'declarations/Service.json': json(fixedDeclaration()), 'declarations/Service.history.json': json(fixedHistory()) }, { pullRequest });

    for (const [ title, pullRequest, reason ] of [
      [ 'a draft', { draft: true }, /draft/ ],
      [ 'another base branch', { base: { ref: 'other' } }, /main/ ],
      [ 'a pull request on hold', { labels: [{ name: 'hold' }] }, /hold/ ],
      [ 'native auto-merge', { auto_merge: { merge_method: 'squash' } }, /auto-merge/ ],
    ]) {
      it(`refuses ${title}`, () => {
        assertRefused(decide(open(pullRequest)), reason);
      });
    }
  });

  describe('history', () => {
    const withHistory = history => decide(openPullRequest({ 'declarations/Service.json': json(fixedDeclaration()), 'declarations/Service.history.json': json(history) }));

    it('refuses a changed existing entry', () => {
      assertRefused(withHistory({ ...fixedHistory(), 'Privacy Policy': [{ ...MAIN_HISTORY['Privacy Policy'][0], select: '.rewritten' }] }), /changes or moves/);
    });

    it('refuses a dropped existing entry', () => {
      assertRefused(withHistory({ 'Terms of Service': fixedHistory()['Terms of Service'] }), /drops existing entries/);
    });

    it('refuses an entry for terms whose declaration is unchanged', () => {
      assertRefused(withHistory({ ...fixedHistory(), 'Privacy Policy': [ ...MAIN_HISTORY['Privacy Policy'], { ...MAIN_DECLARATION.terms['Privacy Policy'], validUntil: '2026-10-01T00:00:00Z' }] }), /unchanged/);
    });

    it('refuses an entry that differs from the declaration it replaces', () => {
      assertRefused(withHistory({ ...MAIN_HISTORY, 'Terms of Service': [{ fetch: 'https://service.example/terms', select: '.invented', validUntil: '2026-10-01T00:00:00Z' }] }), /differs from the declaration/);
    });

    it('refuses a missing entry', () => {
      assertRefused(withHistory({ ...MAIN_HISTORY, 'Terms of Service': [] }), /exactly one new history entry/);
    });

    for (const [ title, validUntil, reason ] of [
      [ 'a date in the future', '2027-01-01T00:00:00Z', /future/ ],
      [ 'a date that is not ISO 8601', '1 October 2026', /valid "validUntil"/ ],
      [ 'a missing date', null, /valid "validUntil"/ ],
    ]) {
      it(`refuses ${title}`, () => {
        assertRefused(withHistory(fixedHistory(validUntil)), reason);
      });
    }

    it('refuses an entry older than the existing ones', () => {
      const declaration = { ...MAIN_DECLARATION, terms: { ...MAIN_DECLARATION.terms, 'Privacy Policy': { ...MAIN_DECLARATION.terms['Privacy Policy'], select: '.new' } } };
      const history = { 'Privacy Policy': [ ...MAIN_HISTORY['Privacy Policy'], { ...MAIN_DECLARATION.terms['Privacy Policy'], validUntil: '2023-01-01T00:00:00Z' }] };

      assertRefused(decide(openPullRequest({ 'declarations/Service.json': json(declaration), 'declarations/Service.history.json': json(history) })), /not more recent/);
    });
  });

  describe('strict JSON', () => {
    const refuses = (buffer, reason) => assert.throws(() => parseStrictJSON(Buffer.from(buffer)), error => error instanceof Refusal && reason.test(error.message));

    it('refuses a duplicated key', () => refuses('{"terms":{},"terms":{"a":1}}', /same key twice/));
    it('refuses a key duplicated through an escape', () => refuses('{"name":1,"n\\u0061me":2}', /same key twice/));
    it('refuses a byte order mark', () => refuses([ 0xEF, 0xBB, 0xBF, 0x7B, 0x7D ], /byte order mark/));
    it('refuses invalid UTF-8', () => refuses([ 0x22, 0xC3, 0x28, 0x22 ], /UTF-8/));
    it('refuses deep nesting', () => refuses('['.repeat(64) + ']'.repeat(64), /nested too deeply/));
    it('refuses a "__proto__" key', () => refuses('{"__proto__":{}}', /__proto__/));
    it('refuses trailing content', () => refuses('{} {}', /valid JSON/));

    it('accepts the same key in different objects and tricky strings', () => {
      assert.deepEqual(parseStrictJSON(Buffer.from('{"a":{"k":"}\\"{"},"b":{"k":[1,{"k":null}]}}')), { a: { k: '}"{' }, b: { k: [ 1, { k: null }] } });
    });

    it('refuses a declaration with a duplicated key in a pull request', () => {
      const declaration = json(fixedDeclaration()).replace('"name": "Service",', '"name": "Service",\n  "name": "Service",');

      assertRefused(decide(openPullRequest({ 'declarations/Service.json': declaration, 'declarations/Service.history.json': json(fixedHistory()) })), /same key twice/);
    });
  });

  describe('fetch locations', () => {
    const refuses = (location, reason) => assert.throws(() => checkLocation(location, CONFIG), error => error instanceof Refusal && reason.test(error.message));

    it('accepts a plain https location', () => checkLocation('https://service.example/legal/terms?lang=en', CONFIG));
    it('refuses http', () => refuses('http://service.example/terms', /https/));
    it('refuses another scheme', () => refuses('file:///etc/passwd', /https/));
    it('refuses credentials', () => refuses('https://service.example@evil.example/terms', /credentials/));
    it('refuses a port', () => refuses('https://service.example:8443/terms', /port/));
    it('refuses an IPv4 address', () => refuses('https://169.254.169.254/latest', /IP address/));
    it('refuses an IPv4 address written as a number', () => refuses('https://2130706433/', /canonical/));
    it('refuses an IPv6 address', () => refuses('https://[::1]/', /IP address/));
    it('refuses a host without a domain', () => refuses('https://localhost/terms', /public domain/));
    it('refuses an internationalized host', () => refuses('https://xn--80ak6aa92e.com/', /internationalized/));
    it('refuses a host where anyone can publish', () => refuses('https://someone.shared.example/terms', /anyone can publish/));
    it('refuses a location that is not canonical', () => refuses('https://service.example/a/../terms', /canonical/));

    it('refuses such a location in a pull request', () => {
      const pullRequest = openPullRequest({ 'declarations/Service.json': json(fixedDeclaration({ fetch: 'https://service.example:8443/terms' })), 'declarations/Service.history.json': json(fixedHistory()) });

      assertRefused(decide(pullRequest), /tier P3|port/);
    });
  });
});
