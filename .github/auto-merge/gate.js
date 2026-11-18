#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const TIERS = [ 'P1', 'P2', 'P3', 'P4' ];

// P3 and P4 are only recognised: no rule vouches for them, so they are left to a maintainer
export const MERGEABLE_TIERS = [ 'P1', 'P2' ];

const DECLARATION_PATH = /^declarations\/([^/]+)\.json$/;
const HISTORY_SUFFIX = '.history';
const REGULAR_FILE_MODE = '100644';
// executeClientScripts is not a selector: it changes how the document is fetched, so changing it leaves the tiers that merge automatically
const SELECTOR_KEYS = [ 'select', 'remove' ];
const VALID_UNTIL_FORMAT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const IPV4_FORMAT = /^\d+(\.\d+){3}$/;

export const DEFAULT_LIMITS = { files: 10, fileBytes: 200_000, depth: 32, urlLength: 2048, combine: 20 };

export class Refusal extends Error {}

function refuse(reason) {
  throw new Refusal(reason);
}

export function parseStrictJSON(buffer, { depth = DEFAULT_LIMITS.depth } = {}) {
  if (buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
    refuse('a file starts with a byte order mark');
  }

  let text;

  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    refuse('a file is not valid UTF-8');
  }

  let value;

  try {
    value = JSON.parse(text);
  } catch {
    refuse('a file is not valid JSON');
  }

  assertUnambiguousKeys(text, depth);

  return value;
}

// JSON.parse keeps the last of two identical keys while other readers may keep the first: what is checked here would then differ from what is read elsewhere
function assertUnambiguousKeys(text, maxDepth) {
  let index = 0;

  const skipWhitespace = () => {
    while (index < text.length && ' \t\n\r'.includes(text[index])) {
      index++;
    }
  };

  const readString = () => {
    const start = index;

    index++;
    while (text[index] !== '"') {
      index += text[index] === '\\' ? 2 : 1;
    }
    index++;

    return JSON.parse(text.slice(start, index));
  };

  const readValue = depth => {
    if (depth > maxDepth) {
      refuse('a file is nested too deeply');
    }

    skipWhitespace();

    if (text[index] === '{') {
      const keys = new Set();

      index++;
      skipWhitespace();
      if (text[index] === '}') {
        index++;

        return;
      }

      for (;;) {
        skipWhitespace();
        const key = readString();

        if (keys.has(key)) {
          refuse('a file holds the same key twice in one object');
        }
        if (key === '__proto__') {
          refuse('a file holds a "__proto__" key');
        }
        keys.add(key);
        skipWhitespace();
        index++;
        readValue(depth + 1);
        skipWhitespace();
        if (text[index++] === '}') {
          return;
        }
      }
    }

    if (text[index] === '[') {
      index++;
      skipWhitespace();
      if (text[index] === ']') {
        index++;

        return;
      }

      for (;;) {
        readValue(depth + 1);
        skipWhitespace();
        if (text[index++] === ']') {
          return;
        }
      }
    }

    if (text[index] === '"') {
      readString();

      return;
    }

    while (index < text.length && !',]} \t\n\r'.includes(text[index])) {
      index++;
    }
  };

  readValue(0);
}

function canonical(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }

  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }

  return JSON.stringify(value) ?? 'null';
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function withoutSelectors(termsDeclaration, transformFetch = fetch => fetch) {
  if (!isPlainObject(termsDeclaration)) {
    return termsDeclaration;
  }

  const result = {};

  for (const [ key, value ] of Object.entries(termsDeclaration)) {
    if (SELECTOR_KEYS.includes(key)) {
      continue;
    }

    if (key === 'combine' && Array.isArray(value)) {
      result.combine = value.map(item => withoutSelectors(item, transformFetch));
    } else if (key === 'fetch') {
      result.fetch = transformFetch(value);
    } else {
      result[key] = value;
    }
  }

  return result;
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return `invalid:${url}`;
  }
}

function fetchLocations(termsDeclaration) {
  const locations = [];

  if (typeof termsDeclaration?.fetch === 'string') {
    locations.push(termsDeclaration.fetch);
  }

  if (Array.isArray(termsDeclaration?.combine)) {
    termsDeclaration.combine.forEach(item => typeof item?.fetch === 'string' && locations.push(item.fetch));
  }

  return locations;
}

export function classify(mainDeclaration, headDeclaration) {
  if (!isPlainObject(headDeclaration) || !isPlainObject(headDeclaration.terms)) {
    refuse('a declaration has no terms');
  }

  const { terms: mainTerms, ...mainRest } = mainDeclaration;
  const { terms: headTerms, ...headRest } = headDeclaration;
  const outOfTier = { tier: 'P3', modifiedTypes: [], modifiedLocations: [] };

  if (canonical(mainRest) !== canonical(headRest)) {
    return outOfTier;
  }

  if (canonical(Object.keys(mainTerms).sort()) !== canonical(Object.keys(headTerms).sort())) {
    return outOfTier;
  }

  let tier = 'P1';
  const modifiedTypes = [];
  const modifiedLocations = [];

  for (const type of Object.keys(mainTerms)) {
    if (canonical(mainTerms[type]) === canonical(headTerms[type])) {
      continue;
    }

    modifiedTypes.push(type);

    if (canonical(withoutSelectors(mainTerms[type])) === canonical(withoutSelectors(headTerms[type]))) {
      continue;
    }

    if (canonical(withoutSelectors(mainTerms[type], hostnameOf)) !== canonical(withoutSelectors(headTerms[type], hostnameOf))) {
      return outOfTier;
    }

    tier = 'P2';
    const mainLocations = fetchLocations(mainTerms[type]);

    modifiedLocations.push(...fetchLocations(headTerms[type]).filter(location => !mainLocations.includes(location)));
  }

  return { tier, modifiedTypes, modifiedLocations };
}

export function checkHistory({ mainHistory, headHistory, mainDeclaration, modifiedTypes, now }) {
  if (!isPlainObject(headHistory)) {
    refuse('a history file is not an object');
  }

  for (const type of new Set([ ...Object.keys(mainHistory), ...Object.keys(headHistory), ...modifiedTypes ])) {
    if (!Object.hasOwn(mainHistory, type) && !Object.hasOwn(mainDeclaration.terms, type)) {
      refuse('a history file adds terms that the declaration does not have');
    }

    const previousEntries = Object.hasOwn(mainHistory, type) ? mainHistory[type] : [];
    const entries = Object.hasOwn(headHistory, type) ? headHistory[type] : [];

    if (!Array.isArray(entries) || entries.length < previousEntries.length) {
      refuse('a history file drops existing entries');
    }

    if (canonical(entries.slice(0, previousEntries.length)) !== canonical(previousEntries)) {
      refuse('a history file changes or moves existing entries');
    }

    const addedEntries = entries.slice(previousEntries.length);

    if (!modifiedTypes.includes(type)) {
      if (addedEntries.length) {
        refuse('a history file gains an entry for terms whose declaration is unchanged');
      }

      continue;
    }

    if (addedEntries.length !== 1) {
      refuse('each modified terms declaration needs exactly one new history entry, added last');
    }

    const [addedEntry] = addedEntries;

    if (!isPlainObject(addedEntry)) {
      refuse('a history entry is not an object');
    }

    const { validUntil, ...previousDeclaration } = addedEntry;

    if (canonical(previousDeclaration) !== canonical(mainDeclaration.terms[type])) {
      refuse('a new history entry differs from the declaration it replaces');
    }

    if (typeof validUntil !== 'string' || !VALID_UNTIL_FORMAT.test(validUntil) || Number.isNaN(Date.parse(validUntil))) {
      refuse('a new history entry has no valid "validUntil" date');
    }

    if (Date.parse(validUntil) > now.getTime()) {
      refuse('a new history entry is valid until a date in the future');
    }

    const lastPreviousEntry = previousEntries.at(-1);

    if (lastPreviousEntry && Date.parse(validUntil) <= Date.parse(lastPreviousEntry.validUntil)) {
      refuse('a new history entry is not more recent than the existing ones');
    }
  }
}

export function checkLocation(location, { sharedHosts = [], limits = DEFAULT_LIMITS } = {}) {
  if (location.length > limits.urlLength) {
    refuse('a fetch location is too long');
  }

  let url;

  try {
    url = new URL(location);
  } catch {
    refuse('a fetch location is not a valid URL');
  }

  if (url.protocol !== 'https:') {
    refuse('a fetch location does not use https');
  }

  if (url.username || url.password) {
    refuse('a fetch location holds credentials');
  }

  if (url.port) {
    refuse('a fetch location sets a port');
  }

  if (url.href !== location && url.href !== `${location}/`) {
    refuse('a fetch location is not in canonical form');
  }

  const { hostname } = url;

  if (IPV4_FORMAT.test(hostname) || hostname.includes(':') || hostname.startsWith('[')) {
    refuse('a fetch location targets an IP address');
  }

  if (!hostname.includes('.') || !/[a-z]$/.test(hostname)) {
    refuse('a fetch location targets a host that is not a public domain name');
  }

  if (hostname.split('.').some(label => label.startsWith('xn--'))) {
    refuse('a fetch location uses an internationalized host name');
  }

  if (sharedHosts.some(sharedHost => hostname === sharedHost || hostname.endsWith(`.${sharedHost}`))) {
    refuse('a fetch location changes on a host where anyone can publish');
  }
}

export function checkState(pullRequest) {
  if (pullRequest.draft) {
    refuse('the pull request is a draft');
  }

  if (pullRequest.base?.ref !== 'main') {
    refuse('the pull request does not target main');
  }

  if ((pullRequest.labels ?? []).some(label => label.name === 'hold')) {
    refuse('the pull request is on hold');
  }

  if (pullRequest.auto_merge) {
    refuse('native auto-merge is enabled on the pull request');
  }
}

export function createGit(repositoryPath) {
  const run = (...args) => execFileSync('git', [ '-C', repositoryPath, ...args ], { maxBuffer: 256 * 1024 * 1024, stdio: [ 'ignore', 'pipe', 'pipe' ] });

  return {
    resolve: ref => run('rev-parse', '--verify', '--quiet', `${ref}^{commit}`).toString().trim(),
    mergeBase: (first, second) => run('merge-base', first, second).toString().trim(),
    blob: sha => run('cat-file', 'blob', sha),
    blobSize: sha => Number(run('cat-file', '-s', sha).toString()),
    declarationsTree(commit) {
      const tree = new Map();

      for (const line of run('ls-tree', '-z', commit, 'declarations/').toString().split('\0').filter(Boolean)) {
        const [ metadata, path ] = line.split('\t');
        const [ mode, type, sha ] = metadata.split(' ');

        tree.set(path, { mode, type, sha });
      }

      return tree;
    },
    changes(from, to) {
      const fields = run('diff-tree', '-r', '--no-renames', '--no-abbrev', '--raw', '-z', from, to).toString().split('\0').filter(Boolean);
      const changes = [];

      for (let index = 0; index < fields.length; index += 2) {
        const [ oldMode, newMode, oldSha, newSha, status ] = fields[index].slice(1).split(' ');

        changes.push({ oldMode, newMode, oldSha, newSha, status, path: fields[index + 1] });
      }

      return changes;
    },
  };
}

function checkFiles({ changes, mainTree, limits }) {
  if (!changes.length) {
    refuse('the pull request changes nothing');
  }

  if (changes.length > limits.files) {
    refuse('the pull request changes too many files');
  }

  const services = new Map();

  for (const change of changes) {
    const match = change.path.match(DECLARATION_PATH);

    if (!match) {
      refuse('the pull request changes something else than JSON files in the declarations directory');
    }

    if (change.status === 'D') {
      refuse('the pull request deletes a file');
    }

    if (change.newMode !== REGULAR_FILE_MODE || (change.status === 'M' && change.oldMode !== REGULAR_FILE_MODE)) {
      refuse('the pull request changes something that is not a regular file');
    }

    const isHistory = match[1].endsWith(HISTORY_SUFFIX);
    const serviceId = isHistory ? match[1].slice(0, -HISTORY_SUFFIX.length) : match[1];
    const declarationOnMain = mainTree.get(`declarations/${serviceId}.json`);

    if (!declarationOnMain || declarationOnMain.mode !== REGULAR_FILE_MODE) {
      return { tier: 'P4' };
    }

    const fileOnMain = mainTree.get(change.path);

    if (change.status === 'A' ? fileOnMain : fileOnMain?.sha !== change.oldSha) {
      refuse('a changed file has also changed on main since the pull request branched off: rebase it');
    }

    if (change.status === 'A' && !isHistory) {
      refuse('the pull request adds a file that is not the history of an existing service');
    }

    const service = services.get(serviceId) ?? {};

    service[isHistory ? 'history' : 'declaration'] = change;
    services.set(serviceId, service);
  }

  return { services };
}

// A pull request is validated on the main that was evaluated: a later change of main keeps that validation only if it touches the declarations of other services
export function invalidatesValidation({ changedPaths, serviceIds }) {
  return changedPaths.some(path => !path.startsWith('declarations/') || serviceIds.some(id => path.startsWith(`declarations/${id}.`)));
}

export function evaluate({ pullRequest, git, config, mainRef = 'refs/remotes/origin/main', now = new Date() }) {
  const limits = { ...DEFAULT_LIMITS, ...config.limits };
  const result = { number: pullRequest.number, headSha: pullRequest.head?.sha, tier: null, services: [], files: [] };

  try {
    checkState(pullRequest);

    const head = git.resolve(`refs/pr/${pullRequest.number}`);

    if (head !== pullRequest.head.sha) {
      refuse('the pull request changed while it was being evaluated');
    }

    const main = git.resolve(mainRef);
    const mainTree = git.declarationsTree(main);
    const { services, tier: fileTier } = checkFiles({ changes: git.changes(git.mergeBase(main, head), head), mainTree, limits });

    result.tier = fileTier ?? 'P1';

    if (!fileTier) {
      for (const [ serviceId, { declaration, history }] of services) {
        if (!declaration) {
          refuse('a history file changes while its declaration does not');
        }

        if (!history) {
          refuse('a declaration changes while its history file does not');
        }

        for (const change of [ declaration, history ]) {
          if (git.blobSize(change.newSha) > limits.fileBytes) {
            refuse('a file is too large');
          }
        }

        const mainDeclaration = JSON.parse(git.blob(declaration.oldSha));
        const headDeclaration = parseStrictJSON(git.blob(declaration.newSha), limits);
        const mainHistory = history.status === 'A' ? {} : JSON.parse(git.blob(history.oldSha));
        const headHistory = parseStrictJSON(git.blob(history.newSha), limits);
        const { tier, modifiedTypes, modifiedLocations } = classify(mainDeclaration, headDeclaration);

        if (TIERS.indexOf(tier) > TIERS.indexOf(result.tier)) {
          result.tier = tier;
        }

        if (tier === 'P3') {
          continue;
        }

        if (!modifiedTypes.length) {
          refuse('a declaration file changes without changing any terms');
        }

        if (Object.values(headDeclaration.terms).some(terms => Array.isArray(terms.combine) && terms.combine.length > limits.combine)) {
          refuse('a declaration combines too many documents');
        }

        modifiedLocations.forEach(location => checkLocation(location, { sharedHosts: config.sharedHosts, limits }));
        checkHistory({ mainHistory, headHistory, mainDeclaration, modifiedTypes, now });

        result.services.push({ id: serviceId, types: modifiedTypes });
        result.files.push({ path: declaration.path, sha: declaration.newSha }, { path: history.path, sha: history.newSha });
      }
    }

    if (!MERGEABLE_TIERS.includes(result.tier)) {
      refuse(`the pull request belongs to tier ${result.tier}, which does not merge automatically`);
    }

    return { ...result, eligible: true, reason: `eligible in tier ${result.tier}` };
  } catch (error) {
    if (!(error instanceof Refusal)) {
      console.error(`#${pullRequest.number}:`, error);
    }

    return { ...result, eligible: false, services: [], files: [], reason: error instanceof Refusal ? error.message : 'the evaluation could not be completed' };
  }
}

function main() {
  const { values: options } = parseArgs({
    options: {
      repository: { type: 'string', default: '.' },
      pulls: { type: 'string' },
      config: { type: 'string', default: fileURLToPath(new URL('./config.json', import.meta.url)) },
      'main-ref': { type: 'string', default: 'refs/remotes/origin/main' },
      output: { type: 'string' },
    },
  });

  const config = JSON.parse(fs.readFileSync(options.config));
  const pullRequests = JSON.parse(fs.readFileSync(options.pulls));
  const git = createGit(options.repository);
  const decisions = pullRequests.map(pullRequest => evaluate({ pullRequest, git, config, mainRef: options['main-ref'] }));

  if (options.output) {
    fs.writeFileSync(options.output, JSON.stringify({ main: git.resolve(options['main-ref']), decisions }, null, 2));
  }

  for (const decision of decisions) {
    console.log(`#${decision.number}\t${decision.eligible ? 'ELIGIBLE' : 'REFUSED'}\t${decision.tier ?? '-'}\t${decision.reason}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
