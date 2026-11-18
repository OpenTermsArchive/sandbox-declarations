const API = 'https://api.github.com';

export const STATUS_CONTEXT = 'auto-merge';
export const VALIDATION_FAILURE = 'validation failure';

export function createGitHub({ token, repository }) {
  async function request(method, path, body) {
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

export function validationJobName(pullRequestNumber) {
  return `validate (#${pullRequestNumber})`;
}

export async function validationConclusions(github, runId) {
  const jobs = await github.list(`/repos/{repository}/actions/runs/${runId}/jobs?per_page=100`, data => data.jobs);

  return new Map(jobs.map(job => [ job.name, job.conclusion ]));
}
