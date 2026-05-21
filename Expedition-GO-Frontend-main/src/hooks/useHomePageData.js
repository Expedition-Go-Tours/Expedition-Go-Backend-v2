import { useQuery } from "@tanstack/react-query";

const DEFAULT_INITIAL_DELAY_MS = 250;
/** Slightly longer after auth handoff so the skeleton is visibly distinct from splash. */
const POST_AUTH_INITIAL_DELAY_MS = 380;

/**
 * HomePage loading orchestration.
 * - Brief skeleton delay on first resolved load (unless `skipInitialDelay`)
 * - Set `enabled: false` until a gate opens (e.g. post-auth splash finished) so the skeleton runs after splash
 * - Pass `handoffNonce` after sign-in so React Query cannot reuse cached "already loaded" data and skip skeleton
 */
export function useHomePageData({
  skipInitialDelay = false,
  enabled = true,
  handoffNonce = null,
  postAuthHandoff = false,
} = {}) {
  const delayMs = postAuthHandoff
    ? POST_AUTH_INITIAL_DELAY_MS
    : skipInitialDelay
      ? 0
      : DEFAULT_INITIAL_DELAY_MS;

  const nonceKey =
    typeof handoffNonce === "number" && Number.isFinite(handoffNonce) ? String(handoffNonce) : "stable";

  const delayModeKey = delayMs === 0 ? "skipDelay" : delayMs === POST_AUTH_INITIAL_DELAY_MS ? "postAuthDelay" : "defaultDelay";

  return useQuery({
    queryKey: [
      "homePage",
      "initialLoad",
      delayModeKey,
      postAuthHandoff ? "postAuth" : "default",
      nonceKey,
    ],
    queryFn: async () => {
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      return {
        loaded: true,
        timestamp: Date.now(),
      };
    },
    staleTime: Infinity,
    gcTime: 1000 * 60 * 60,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    enabled,
  });
}
