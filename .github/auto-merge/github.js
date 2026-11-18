const API = 'https://api.github.com';
const ATTEMPTS = 3;

export const STATUS_CONTEXT = 'auto-merge';
export const VALIDATION_FAILURE = 'validation failure';

export function createGitHub({ token, repository }) {
  async function request(method, path, body, attempt = 1) {
    const response = await fetch(path.startsWith('http') ? path : `${API}${path.replace('{repository}', repository)}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(token && { Authorization: `Bearer ${token}` }),
        ...(body && { 'Content-Type': 'application/json' }),
      },
      body: body && JSON.stringify(body),
    });

    // GitHub now and then answers with a server error to a request that succeeds when sent again. A POST is not sent again: it may have been applied despite the error, and would then be applied twice, such as two approvals
    if (response.status >= 500 && attempt < ATTEMPTS && method !== 'POST') {
      await new Promise(resolve => { setTimeout(resolve, attempt * 3000); });

      return request(method, path, body, attempt + 1);
    }

    if (!response.ok) {
      const error = new Error(`${method} ${path}: ${response.status} ${(await response.text()).slice(0, 300)}`);

      error.status = response.status;
      throw error;
    }

    return { data: response.status === 204 ? null : await response.json(), next: response.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1] };
  }

  return {
    get: async path => (await request('GET', path)).data,
    post: async (path, body) => (await request('POST', path, body)).data,
    put: async (path, body) => (await request('PUT', path, body)).data,
    patch: async (path, body) => (await request('PATCH', path, body)).data,
    async list(path, pick = data => data) {
      const items = [];

      for (let url = path; url;) {
        const { data, next } = await request('GET', url);

        items.push(...pick(data));
        url = next;
      }

      return items;
    },
  };
}

// GitHub refuses more than 1000 statuses per commit and context: a status equal to the last one is not posted again
export async function setStatus(github, sha, { state, description, targetUrl }) {
  const statuses = await github.get(`/repos/{repository}/commits/${sha}/statuses?per_page=100`);
  const lastStatus = statuses.find(status => status.context === STATUS_CONTEXT);

  if (lastStatus?.state === state && lastStatus.description === description) {
    return;
  }

  await github.post(`/repos/{repository}/statuses/${sha}`, { context: STATUS_CONTEXT, state, description, target_url: targetUrl });
}

// The merge job dismisses its approval when a merge fails: a dismissed approval of a commit means that merging it already failed
export function ownApproval(reviews, { login, sha }) {
  const ownReviews = reviews.filter(({ user, commit_id: commitId }) => user?.login === login && commitId === sha);

  return { failedBefore: ownReviews.some(({ state }) => state === 'DISMISSED'), approval: ownReviews.find(({ state }) => state === 'APPROVED') };
}

export function validationJobName(pullRequestNumber) {
  return `validate (#${pullRequestNumber})`;
}

export async function validationConclusions(github, runId) {
  const jobs = await github.list(`/repos/{repository}/actions/runs/${runId}/jobs?per_page=100`, data => data.jobs);

  return new Map(jobs.map(job => [ job.name, job.conclusion ]));
}
