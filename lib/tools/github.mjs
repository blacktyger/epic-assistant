/**
 * Read-only GitHub reads against an explicit list of EpicCash repositories.
 *
 * The whitelist is a pair of constraints, and both matter:
 *
 * 1. Repository. Only the entries in `tools.github.repos`, currently the node, the wallet and the
 *    miner. A repository name arriving in tool arguments is matched against that list and rejected
 *    otherwise, so no argument the model can produce reaches a repository nobody approved.
 * 2. Endpoint. Only the five read paths below, each with its query string built here. There is no
 *    path parameter, so "read a repository" cannot become "read a user", "search code" or any write.
 *
 * The rate limit is the constraint that shapes the rest of the file. Unauthenticated api.github.com
 * allows 60 requests per hour per IP, measured rather than assumed, and this service will be one IP
 * serving every reader. Three mitigations, in the order they take effect:
 *
 * - A 10-minute TTL cache, so repeated questions cost nothing.
 * - Conditional requests. GitHub does not count a 304 against the budget, so a cached ETag turns a
 *   refresh after the TTL expires into a free revalidation whenever nothing has changed. On a
 *   repository that sees a commit a week, almost every refresh is free.
 * - A floor: once the remaining budget drops to `minRateRemaining`, tools decline rather than spend
 *   the last requests, keeping a reserve for the operator.
 *
 * A note on trust. Release notes, issue titles and PR titles are written by the public and travel into
 * the model's context, so they are the most plausible prompt-injection vector this service has. Two
 * things handle it: every string is truncated and passed as JSON data under a `<tool-result>` framing
 * the prompt marks untrusted, and the output link allowlist means text that persuades the model to
 * emit a URL still cannot emit one outside the allowed hosts.
 */
import { tools as toolCfg } from '../../config.mjs';
import { fetchJson, TtlCache, ToolHttpError } from './http.mjs';

const API = 'https://api.github.com';
const cache = new TtlCache({ maxEntries: 200 });

/** ETag and last body per URL, for conditional requests that do not spend rate-limit budget. */
const revalidation = new Map();

/** Observed from the last response, so the floor check uses fact rather than a counter of our own. */
let rateState = { limit: null, remaining: null, resetAt: null, authenticated: false };

/* ------------------------------------------------------------------ repository allowlist */

/**
 * Resolves whatever the model wrote into an allowlisted `owner/name`, or explains the refusal.
 *
 * Short names are accepted because a model asked about "the wallet repo" writes `wallet` about as
 * often as it writes `EpicCash/epic-wallet`, and refusing that spends a whole tool round teaching it
 * the format. The aliases resolve only into the allowlist, so leniency here does not widen reach.
 *
 * @returns {{ok: true, repo: string} | {ok: false, error: string, allowed: string[]}}
 */
export function resolveRepo(requested) {
  const allowed = toolCfg.github.repos;
  const raw = String(requested ?? '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '');
  if (!raw) return { ok: false, error: 'a repository is required', allowed };

  const wanted = raw.toLowerCase();
  const direct = allowed.find((r) => r.toLowerCase() === wanted);
  if (direct) return { ok: true, repo: direct };

  /*
   * An owner was given and it did not match. Refuse.
   *
   * This is the hole the first version of this function had, and it is worth naming because it looked
   * harmless: the fallback took the last path segment, so `attacker/epic` reduced to `epic` and
   * resolved straight into the allowlist as `EpicCash/epic`. The read would then have gone to the
   * approved repository rather than the attacker's, so nothing leaked, but the tool would have reported
   * on a repository other than the one it was asked about while claiming the name it was given. A
   * caught-by-test bug rather than an incident, and only because the test asked the adversarial
   * question rather than the happy one.
   *
   * Bare names still resolve through the alias table below. An owner is only ever accepted verbatim.
   */
  if (wanted.includes('/')) {
    return {
      ok: false,
      error: `${raw} is not one of the repositories this assistant can read`,
      allowed,
    };
  }

  // Bare name, or one of the words the documentation uses for each repository.
  const aliases = {
    node: 'epic', epic: 'epic', server: 'epic',
    wallet: 'epic-wallet', 'epic-wallet': 'epic-wallet',
    miner: 'epic-miner', 'epic-miner': 'epic-miner', mining: 'epic-miner',
    epicbox: 'epic-epicbox-docker', relay: 'epic-epicbox-docker',
  };
  const name = aliases[wanted] ?? wanted;
  const matched = allowed.find((r) => r.split('/')[1].toLowerCase() === name);
  if (matched) return { ok: true, repo: matched };

  return {
    ok: false,
    error: `${raw} is not one of the repositories this assistant can read`,
    allowed,
  };
}

export function githubAvailable() {
  return toolCfg.enabled && toolCfg.github.enabled && toolCfg.github.repos.length > 0;
}

/* ------------------------------------------------------------------ request */

function token() {
  for (const name of toolCfg.github.tokenEnvNames) {
    const v = process.env[name];
    if (v) return v;
  }
  return null;
}

/**
 * One GitHub read, with conditional revalidation and rate-limit bookkeeping.
 *
 * The 304 path is why this is not a plain `fetchJson` call. A revalidation that comes back unchanged
 * costs no rate-limit budget, which on a 60-per-hour allowance is the difference between the tools
 * working all day and working for the first hour.
 */
async function gh(path, { signal } = {}) {
  if (rateState.remaining != null && rateState.remaining <= toolCfg.github.minRateRemaining) {
    const waitMinutes = rateState.resetAt
      ? Math.max(1, Math.ceil((rateState.resetAt - Date.now()) / 60_000))
      : null;
    throw new ToolHttpError('upstream', `GitHub rate limit nearly exhausted${waitMinutes ? `, resets in about ${waitMinutes} minutes` : ''}`);
  }

  const url = `${API}${path}`;
  const held = revalidation.get(url);
  const auth = token();

  const { status, headers, json } = await fetchJson(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      // GitHub requires a User-Agent and answers 403 without one.
      'User-Agent': 'epic-devdocs-assistant',
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
      ...(held?.etag ? { 'If-None-Match': held.etag } : {}),
    },
    timeoutMs: toolCfg.timeoutMs,
    maxBytes: 1_000_000,
    allowStatus: [304],
    signal,
  });

  const remaining = Number(headers.get('x-ratelimit-remaining'));
  const limit = Number(headers.get('x-ratelimit-limit'));
  const reset = Number(headers.get('x-ratelimit-reset'));
  rateState = {
    limit: Number.isFinite(limit) ? limit : rateState.limit,
    remaining: Number.isFinite(remaining) ? remaining : rateState.remaining,
    resetAt: Number.isFinite(reset) ? reset * 1000 : rateState.resetAt,
    authenticated: Boolean(auth),
  };

  if (status === 304 && held) return held.body;

  const etag = headers.get('etag');
  if (etag) revalidation.set(url, { etag, body: json });
  // Bound the revalidation store the same way the caches are bounded.
  if (revalidation.size > 200) revalidation.delete(revalidation.keys().next().value);

  return json;
}

/* ------------------------------------------------------------------ releases */

/**
 * Releases, newest first. `limit: 1` is the "what is the latest version" answer.
 *
 * `/releases` rather than `/releases/latest`, even for a single result, because the two disagree in a
 * way that matters here: `latest` excludes prereleases and draft releases, so a repository whose
 * newest tag is a release candidate reports the older stable one with no indication that something
 * newer exists. Listing and marking `prerelease` lets the answer say both.
 */
export async function releases({ repo, limit = 3, signal } = {}) {
  const r = resolveRepo(repo);
  if (!r.ok) return r;

  const count = clampInt(limit, 1, toolCfg.github.maxItems, 3);
  const hit = await cache.get(`releases:${r.repo}`, toolCfg.github.ttlSeconds, async () => ({
    list: await gh(`/repos/${r.repo}/releases?per_page=${toolCfg.github.maxItems}`, { signal }),
    at: Date.now(),
  }));

  const list = Array.isArray(hit.value.list) ? hit.value.list : [];
  return withMeta(hit, {
    repo: r.repo,
    repoUrl: `https://github.com/${r.repo}`,
    releaseCount: list.length,
    releases: list.slice(0, count).map((rel) => ({
      tag: rel.tag_name,
      name: rel.name || rel.tag_name,
      publishedAt: rel.published_at,
      prerelease: Boolean(rel.prerelease),
      draft: Boolean(rel.draft),
      url: rel.html_url,
      assets: (rel.assets ?? []).slice(0, 8).map((a) => ({
        name: a.name,
        sizeMb: a.size ? Number((a.size / 1_048_576).toFixed(1)) : null,
        downloads: a.download_count ?? null,
        url: a.browser_download_url,
      })),
      // Release notes are frequently thousands of words. An excerpt is enough to say what a release
      // changed, and the URL is there for a reader who wants the rest.
      notesExcerpt: excerpt(rel.body, 700),
    })),
    note:
      'Prereleases and drafts are included and flagged. A tag here is what GitHub publishes, which ' +
      'is not necessarily what the documentation describes.',
  });
}

/* ------------------------------------------------------------------ activity */

const ACTIVITY_KINDS = new Set(['pull_requests', 'issues', 'commits']);

/**
 * Recent pull requests, issues or commits.
 *
 * One tool with a `kind` argument rather than three tools. Tool schemas sit in every request's cached
 * prefix, and three near-identical schemas cost tokens on every question while also giving the model
 * three similar choices to get wrong. A single verb with an enum is both cheaper and easier to pick.
 */
export async function activity({ repo, kind = 'commits', state = 'open', limit = 5, signal } = {}) {
  const r = resolveRepo(repo);
  if (!r.ok) return r;

  const what = String(kind).toLowerCase();
  if (!ACTIVITY_KINDS.has(what)) {
    return { error: `kind must be one of: ${[...ACTIVITY_KINDS].join(', ')}` };
  }
  const count = clampInt(limit, 1, toolCfg.github.maxItems, 5);
  const wantState = ['open', 'closed', 'all'].includes(String(state)) ? String(state) : 'open';
  const per = toolCfg.github.maxItems;

  if (what === 'commits') {
    const hit = await cache.get(`commits:${r.repo}`, toolCfg.github.ttlSeconds, async () => ({
      list: await gh(`/repos/${r.repo}/commits?per_page=${per}`, { signal }),
      at: Date.now(),
    }));
    const list = Array.isArray(hit.value.list) ? hit.value.list : [];
    return withMeta(hit, {
      repo: r.repo,
      kind: 'commits',
      commits: list.slice(0, count).map((c) => ({
        sha: String(c.sha ?? '').slice(0, 8),
        // First line only. A commit body can be long and adds nothing to "what changed recently".
        subject: excerpt(String(c.commit?.message ?? '').split('\n')[0], 140),
        author: c.author?.login ?? c.commit?.author?.name ?? null,
        date: c.commit?.author?.date ?? null,
        url: c.html_url,
      })),
      note: 'Commits on the default branch, newest first.',
    });
  }

  if (what === 'pull_requests') {
    const hit = await cache.get(`pulls:${r.repo}:${wantState}`, toolCfg.github.ttlSeconds, async () => ({
      list: await gh(`/repos/${r.repo}/pulls?state=${wantState}&sort=updated&direction=desc&per_page=${per}`, { signal }),
      at: Date.now(),
    }));
    const list = Array.isArray(hit.value.list) ? hit.value.list : [];
    return withMeta(hit, {
      repo: r.repo,
      kind: 'pull_requests',
      state: wantState,
      pullRequests: list.slice(0, count).map((p) => ({
        number: p.number,
        title: excerpt(p.title, 160),
        state: p.merged_at ? 'merged' : p.state,
        draft: Boolean(p.draft),
        author: p.user?.login ?? null,
        createdAt: p.created_at,
        updatedAt: p.updated_at,
        mergedAt: p.merged_at ?? null,
        url: p.html_url,
      })),
      note: 'Sorted by most recently updated. A merged pull request reports state "merged".',
    });
  }

  const hit = await cache.get(`issues:${r.repo}:${wantState}`, toolCfg.github.ttlSeconds, async () => ({
    list: await gh(`/repos/${r.repo}/issues?state=${wantState}&sort=updated&direction=desc&per_page=${per}`, { signal }),
    at: Date.now(),
  }));
  const list = Array.isArray(hit.value.list) ? hit.value.list : [];
  return withMeta(hit, {
    repo: r.repo,
    kind: 'issues',
    state: wantState,
    issues: list
      // The issues endpoint returns pull requests as well, which is a documented quirk and not an
      // accident. Without this filter a question about open issues reports PRs as issues.
      .filter((i) => !i.pull_request)
      .slice(0, count)
      .map((i) => ({
        number: i.number,
        title: excerpt(i.title, 160),
        state: i.state,
        author: i.user?.login ?? null,
        comments: i.comments ?? 0,
        labels: (i.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)).filter(Boolean).slice(0, 6),
        createdAt: i.created_at,
        updatedAt: i.updated_at,
        url: i.html_url,
      })),
    note: 'Pull requests are excluded, which GitHub does not do by default on this endpoint.',
  });
}

/* ------------------------------------------------------------------ repository overview */

/**
 * Whether a repository is alive, which is the question behind most "should I use this" questions.
 *
 * `pushedAt` is the field that carries the answer. The miner repository's master branch has not moved
 * since 2022 while the node and wallet were pushed within the last two months, and a reader deciding
 * what to build against needs that told to them rather than discovered.
 */
export async function repoOverview({ repo, signal } = {}) {
  const r = resolveRepo(repo);
  if (!r.ok) return r;

  const hit = await cache.get(`repo:${r.repo}`, toolCfg.github.ttlSeconds, async () => ({
    info: await gh(`/repos/${r.repo}`, { signal }),
    at: Date.now(),
  }));

  const i = hit.value.info ?? {};
  const pushed = i.pushed_at ? Date.parse(i.pushed_at) : null;

  return withMeta(hit, {
    repo: r.repo,
    url: i.html_url ?? `https://github.com/${r.repo}`,
    description: excerpt(i.description, 200),
    defaultBranch: i.default_branch ?? null,
    language: i.language ?? null,
    license: i.license?.spdx_id ?? null,
    archived: Boolean(i.archived),
    stars: i.stargazers_count ?? null,
    forks: i.forks_count ?? null,
    openIssuesAndPullRequests: i.open_issues_count ?? null,
    pushedAt: i.pushed_at ?? null,
    daysSinceLastPush: pushed ? Math.floor((Date.now() - pushed) / 86_400_000) : null,
    note:
      'openIssuesAndPullRequests counts both, which is how GitHub reports it. daysSinceLastPush is ' +
      'the best single signal of whether the repository is maintained.',
  });
}

/* ------------------------------------------------------------------ helpers */

function withMeta(hit, payload) {
  return {
    ...payload,
    observedAt: new Date(Date.now() - hit.ageSeconds * 1000).toISOString(),
    ageSeconds: hit.ageSeconds,
    ...(hit.stale ? { stale: true, staleReason: 'the live refresh failed, this is the last good reading' } : {}),
  };
}

/**
 * Truncates on a word boundary and says that it did.
 *
 * The marker is not cosmetic. Without it a model reads a sentence that stops mid-clause as the whole
 * text and will happily summarise a release as though the excerpt were complete.
 */
function excerpt(text, max) {
  if (typeof text !== 'string') return null;
  const clean = text.replace(/\r/g, '').trim();
  if (clean.length <= max) return clean || null;
  const cut = clean.slice(0, max);
  const at = cut.lastIndexOf(' ');
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).trimEnd()}… [truncated]`;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export const githubRateState = () => ({ ...rateState });
export const githubCacheStats = () => cache.stats;
export const sweepGithubCache = () => cache.sweep();
