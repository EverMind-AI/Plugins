/**
 * Common dual-track retrieval and merge utilities for EverOS Antigravity Plugin.
 * Prevents code duplication across recall.js, mcp/server.js, and skills/everos/cli.js.
 * Solves single-track starvation (D2-04) by interleaving results.
 */

/**
 * Interleave elements of two arrays evenly to prevent either track from being starved.
 *
 * @template T
 * @param {T[]} a
 * @param {T[]} b
 * @returns {T[]}
 */
export function interleave(a = [], b = []) {
  const result = [];
  const maxLen = Math.max(a.length, b.length);
  for (let i = 0; i < maxLen; i++) {
    if (i < a.length) result.push(a[i]);
    if (i < b.length) result.push(b[i]);
  }
  return result;
}

/**
 * Execute dual-track parallel search across User Track and Agent Engineering Track.
 *
 * @param {object} client - EverOS client instance
 * @param {object} options
 * @param {object} options.identity - Resolved identity (appId, projectId, userId, agentId)
 * @param {string} options.query - Search query string
 * @param {object} [options.config={}] - Configuration object
 * @param {number} [options.topK=3] - Items per track
 * @param {boolean} [options.includeProfile=false] - Whether to include profile
 * @param {AbortSignal} [options.signal] - Timeout / cancellation signal
 * @returns {Promise<{ episodes: any[], agent_cases: any[], profiles: any[], profile: any | null }>}
 */
export async function dualTrackSearch(client, options) {
  const {
    identity,
    query,
    config = {},
    topK = 3,
    includeProfile = false,
    signal,
  } = options;

  const searchErrors = [];
  const searches = [];

  // Track 1: User Track
  if (identity.userId) {
    searches.push(
      client
        .search(
          {
            app_id: identity.appId,
            query,
            project_id: identity.projectId,
            user_id: identity.userId,
            method: config.searchMethod || "keyword",
            top_k: topK,
            include_profile: includeProfile,
          },
          signal
        )
        .catch((err) => {
          searchErrors.push(err);
          return null;
        })
    );
  } else {
    searches.push(Promise.resolve(null));
  }

  // Track 2: Agent Engineering Track
  searches.push(
    client
      .search(
        {
          app_id: identity.appId,
          query,
          project_id: identity.projectId,
          agent_id: identity.agentId,
          method: config.searchMethod || "keyword",
          top_k: topK,
          include_profile: includeProfile && !identity.userId,
        },
        signal
      )
      .catch((err) => {
        searchErrors.push(err);
        return null;
      })
  );

  const [userRes, agentRes] = await Promise.all(searches);

  // Normalize profiles: upstream contract uses 'profiles' array
  const userProfiles = userRes?.profiles ?? (userRes?.profile ? [userRes.profile] : []);
  const agentProfiles = agentRes?.profiles ?? (agentRes?.profile ? [agentRes.profile] : []);
  const profiles = [...userProfiles, ...agentProfiles];
  const profile = profiles[0] ?? null;

  // Interleave episodes and cases to prevent one track starving the other (D2-04)
  const userEpisodes = Array.isArray(userRes?.episodes) ? userRes.episodes : [];
  const agentEpisodes = Array.isArray(agentRes?.episodes) ? agentRes.episodes : [];
  const episodes = interleave(userEpisodes, agentEpisodes);

  const userCases = Array.isArray(userRes?.agent_cases)
    ? userRes.agent_cases
    : Array.isArray(userRes?.cases)
      ? userRes.cases
      : [];
  const agentCases = Array.isArray(agentRes?.agent_cases)
    ? agentRes.agent_cases
    : Array.isArray(agentRes?.cases)
      ? agentRes.cases
      : [];
  const agent_cases = interleave(userCases, agentCases);

  return {
    episodes,
    agent_cases,
    profiles,
    profile,
    errors: searchErrors,
  };
}
