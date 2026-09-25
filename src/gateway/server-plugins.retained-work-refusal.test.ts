/** Retained-work reload refusal keeps the serving plugin runtime authoritative. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { markGatewayRestartHandled } from "../infra/restart.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import { clearInstanceBindingProbeCoordinators } from "./server-plugins.lifecycle.test-fixtures.js";
import {
  installInstanceBindingConfigIo,
  prepareInstanceBindingFixture,
  requireBoundRuntime,
  requestInstanceBindingProbe,
} from "./server-plugins.lifecycle.test-support.js";
import {
  connectWebchatClient,
  installGatewayTestHooks,
  rpcReq,
  startTestGatewayServer,
} from "./test-helpers.server.js";

vi.doUnmock("../plugins/loader.js");
installGatewayTestHooks({ scope: "suite" });
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
installInstanceBindingConfigIo();

describe("Gateway plugin retained-work reload refusal", () => {
  let server: Awaited<ReturnType<typeof startTestGatewayServer>> | undefined;
  let socket: Awaited<ReturnType<typeof connectWebchatClient>> | undefined;
  let restoreRuntimeLoader: (() => void) | undefined;

  afterEach(async () => {
    markGatewayRestartHandled();
    const closingSocket = socket;
    const socketClosed =
      !closingSocket || closingSocket.readyState === closingSocket.CLOSED
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            closingSocket.once("close", () => resolve());
          });
    closingSocket?.close();
    try {
      const results = await Promise.allSettled([
        server?.close({ reason: "retained-work reload refusal cleanup" }),
        socketClosed,
      ]);
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length > 0) {
        throw new AggregateError(failures, "Retained-work refusal fixture shutdown failed");
      }
    } finally {
      restoreRuntimeLoader?.();
      clearInstanceBindingProbeCoordinators();
      delete process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;
      server = undefined;
      socket = undefined;
      restoreRuntimeLoader = undefined;
    }
  });

  it("leaves the serving runtime generation authoritative", { timeout: 300_000 }, async () => {
    const fixture = await prepareInstanceBindingFixture(
      tempDirs.make("openclaw-instance-binding-"),
    );
    restoreRuntimeLoader = fixture.restoreChannelRuntimeLoader;
    const claim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
    server = await startTestGatewayServer(claim, {
      auth: { mode: "none" },
      controlUiEnabled: false,
      sidecarStartup: "start",
    });
    await server.startupSettled;

    const registry = getActivePluginRegistry();
    const record = registry?.plugins.find((entry) => entry.id === "instance-binding-probe");
    const instance = record && getPluginInstance(record);
    const { runtime } = await requireBoundRuntime(fixture.coordinator.runtimes, "retained owner");
    const before = await requestInstanceBindingProbe(runtime);
    const releaseWork = instance!.retainWork();
    try {
      socket = await connectWebchatClient({ port: claim.port, scopes: ["operator.admin"] });
      const reload = await rpcReq(socket, "plugins.reload", {
        plugins: [{ pluginId: "instance-binding-probe" }],
      });
      expect(reload.ok).toBe(false);
      expect(reload.error?.message).toContain("active retained work");
      await expect(requestInstanceBindingProbe(runtime)).resolves.toEqual(before);
      expect(getActivePluginRegistry()).toBe(registry);
    } finally {
      releaseWork();
    }
  });
});
