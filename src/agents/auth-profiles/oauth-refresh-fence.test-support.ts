import { afterEach, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { testing as externalAuthTesting } from "./external-auth.test-support.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./runtime-snapshots.js";
import type { OAuthCredential } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

export async function withOAuthTempRoot(
  prefix: string,
  run: (tempRoot: string) => Promise<void>,
): Promise<void> {
  const tempRoot = tempDirs.make(prefix);
  await withEnvAsync({ OPENCLAW_STATE_DIR: tempRoot }, async () => await run(tempRoot));
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  externalAuthTesting.resetResolveExternalAuthProfilesForTest();
  clearRuntimeAuthProfileStoreSnapshots();
  for (const stateDir of tempDirs.dirs) {
    await cleanupSessionStateForTest({ stateDir });
  }
});

export function createCredential(overrides: Partial<OAuthCredential> = {}): OAuthCredential {
  return {
    type: "oauth",
    provider: "openai",
    access: "access-token",
    refresh: "refresh-token",
    expires: Date.now() + 60_000,
    ...overrides,
  };
}

type ForcedRefreshFailureCase = {
  name: string;
  candidate: Partial<OAuthCredential>;
  expectedApiKey?: string;
  buildError?: string;
};

export const FORCED_REFRESH_FAILURE_CASES: ForcedRefreshFailureCase[] = [
  {
    name: "rejects refresh-only changes",
    candidate: {
      access: "failed-access",
      refresh: "new-refresh",
      expires: Date.now() + 600_000,
      accountId: "acct-123",
    },
    expectedApiKey: undefined,
  },
  {
    name: "adopts access-token changes",
    candidate: {
      access: "new-access",
      refresh: "failed-refresh",
      expires: Date.now() + 600_000,
      accountId: "acct-123",
    },
    expectedApiKey: "new-access",
  },
  {
    name: "preserves the refresh error when adopted-key construction fails",
    candidate: {
      access: "new-access",
      refresh: "failed-refresh",
      expires: Date.now() + 600_000,
      accountId: "acct-123",
    },
    expectedApiKey: undefined,
    buildError: "fallback key construction failed",
  },
];
