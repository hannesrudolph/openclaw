import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  buildUpdateDoctorBudgetEnv,
  UPDATE_DOCTOR_BUDGET_ENV,
} from "../infra/update-doctor-budget.js";
import { buildUpdateRehearsalPathEnv } from "../infra/update-rehearsal-paths.js";
import { buildUpdateDoctorEnv } from "../infra/update-runner-doctor.js";
import { admitDoctorUpdateInspection, resolveDoctorUpdateBudget } from "./doctor-update-budget.js";

const ledger = vi.hoisted(() => vi.fn());
// mock-isolation: Budget resolution only reads ledger facts; no database or worker belongs to this fixture.
vi.mock("../infra/update-run-reader.js", () => ({ listUpdateRunsAsync: ledger }));
const start = 1_000_000;
const cfg: OpenClawConfig = {
  agents: { ownership: "explicit", entries: { first: {}, second: {}, third: {} } },
};
const inspection = [{ id: "fixture/inspection", label: "Synthetic inspection" }];
let now: number;

function rehearsalEnv(value?: string): NodeJS.ProcessEnv {
  return {
    ...buildUpdateRehearsalPathEnv("/synthetic/rehearsal"),
    ...buildUpdateDoctorEnv({
      allowGatewayActivation: false,
      allowGatewayServiceRepair: false,
      serviceRepairPolicy: "external",
    }),
    [UPDATE_DOCTOR_BUDGET_ENV]: value,
  };
}

function parentBudget(workMs = 298_000): string {
  const value = buildUpdateDoctorBudgetEnv("lint", start, start + workMs)[UPDATE_DOCTOR_BUDGET_ENV];
  assert(value !== undefined);
  return value;
}

beforeEach(() => {
  now = start;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  ledger
    .mockReset()
    .mockResolvedValue([{ steps: [{ step: "validating", startedAtMs: start - 400_000 }] }]);
});
afterEach(() => vi.restoreAllMocks());

describe("parent-to-Doctor validation budget", () => {
  it("uses the parent command clock after slow preparation, without reading a stale ledger", async () => {
    now += 5_000;
    const env = rehearsalEnv(parentBudget());
    const budget = await resolveDoctorUpdateBudget({ cfg, env });
    expect(budget).toMatchObject({
      agentCount: 3,
      phase: "validation",
      source: "parent-validation-budget",
      inspectionDeadlineMs: start + 149_000,
      disposalDeadlineMs: start + 298_000,
    });
    expect(admitDoctorUpdateInspection(budget, "agent", inspection)).toBe(true);
    now += 60_000;
    expect(await resolveDoctorUpdateBudget({ cfg, env })).toEqual(budget);
    expect(ledger).not.toHaveBeenCalled();
  });

  it.each([
    { workMs: 10_000, windowMs: 5_000 },
    { workMs: 298_000, windowMs: 149_000 },
    { workMs: 3_000_000, windowMs: 149_000 },
    { workMs: 0, windowMs: 0 },
  ])("preserves the $workMs ms parent limit and cleanup reserve", async ({ workMs, windowMs }) => {
    const budget = await resolveDoctorUpdateBudget({
      cfg,
      env: rehearsalEnv(parentBudget(workMs)),
    });
    expect(budget?.inspectionDeadlineMs).toBe(start + windowMs);
    expect(budget?.disposalDeadlineMs).toBe(start + workMs);
  });

  it("requires the complete fleet allowance and never re-admits a deferred check", async () => {
    const budget = await resolveDoctorUpdateBudget({ cfg, env: rehearsalEnv(parentBudget()) });
    now = start + 143_000;
    expect(admitDoctorUpdateInspection(budget, "agent", inspection)).toBe(true);
    now += 1;
    expect(admitDoctorUpdateInspection(budget, "agent", inspection)).toBe(false);
    expect([...budget!.deferred.values()]).toEqual([
      expect.objectContaining({
        errorCode: "update-inspection-deferred",
        requirement: "update-validation-budget",
      }),
    ]);
    now = start;
    expect(admitDoctorUpdateInspection(budget, "agent", inspection)).toBe(false);
    expect(budget!.deferred.size).toBe(1);
  });

  it("accounts for prepared agents and genuine total exhaustion", async () => {
    const env = rehearsalEnv(parentBudget());
    const fleet = await resolveDoctorUpdateBudget({ cfg, env, preparedAgentCount: 480 });
    expect(fleet?.agentCount).toBe(480);
    expect(admitDoctorUpdateInspection(fleet, "agent", inspection)).toBe(false);
    now = start + 300_000;
    const exhausted = await resolveDoctorUpdateBudget({ cfg, env });
    expect(admitDoctorUpdateInspection(exhausted, "run", inspection)).toBe(false);
    expect(exhausted?.disposalDeadlineMs).toBe(start + 298_000);
  });

  it.each([
    "",
    "not-json",
    "null",
    JSON.stringify({
      version: 2,
      phase: "validation",
      startedAtMs: start,
      workDeadlineMs: start + 298_000,
    }),
    JSON.stringify({
      version: 1,
      phase: "activation",
      startedAtMs: start,
      workDeadlineMs: start + 298_000,
    }),
    JSON.stringify({
      version: 1,
      phase: "validation",
      startedAtMs: start,
      workDeadlineMs: "1298000",
    }),
    JSON.stringify({
      version: 1,
      phase: "validation",
      startedAtMs: start,
      workDeadlineMs: start - 1,
    }),
    JSON.stringify({ version: 1, phase: "validation", startedAtMs: -1, workDeadlineMs: start }),
    JSON.stringify({
      version: 1,
      phase: "validation",
      startedAtMs: start + 1,
      workDeadlineMs: start + 298_000,
    }),
    JSON.stringify({
      version: 1,
      phase: "validation",
      startedAtMs: start,
      workDeadlineMs: Number.MAX_SAFE_INTEGER + 1,
    }),
  ])("defers on malformed or unsupported explicit handoff %s", async (value) => {
    const budget = await resolveDoctorUpdateBudget({ cfg, env: rehearsalEnv(value) });
    expect(budget?.source).toBe("invalid-parent-validation-budget");
    expect(admitDoctorUpdateInspection(budget, "agent", inspection)).toBe(false);
    expect(ledger).not.toHaveBeenCalled();
  });

  it("preserves the published parent ledger deadline instead of resetting it", async () => {
    const env = rehearsalEnv();
    ledger.mockResolvedValue([{ steps: [{ step: "validating", startedAtMs: start }] }]);
    const fresh = await resolveDoctorUpdateBudget({ cfg, env });
    expect(fresh?.inspectionDeadlineMs).toBe(start + 149_000);
    expect(fresh?.disposalDeadlineMs).toBe(start + 298_000);
    expect(admitDoctorUpdateInspection(fresh, "agent", inspection)).toBe(true);
    now += 400_000;
    const expired = await resolveDoctorUpdateBudget({ cfg, env });
    expect(expired?.source).toBe("validation-ledger");
    expect(expired?.disposalDeadlineMs).toBe(start + 298_000);
    expect(admitDoctorUpdateInspection(expired, "agent", inspection)).toBe(false);
  });

  it.each(["missing", "ambiguous", "unreadable"])(
    "defers legacy optional work with %s ledger origin",
    async (mode) => {
      if (mode === "unreadable") {
        ledger.mockRejectedValue(new Error("synthetic read refusal"));
      } else {
        ledger.mockResolvedValue(mode === "ambiguous" ? [{ steps: [] }, { steps: [] }] : []);
      }
      const budget = await resolveDoctorUpdateBudget({ cfg, env: rehearsalEnv() });
      expect(budget?.source).toBe("unavailable-validation-origin");
      expect(admitDoctorUpdateInspection(budget, "agent", inspection)).toBe(false);
    },
  );

  it("clears inherited command clocks at parent phase boundaries and ignores them after activation", async () => {
    const validation = rehearsalEnv(parentBudget());
    const live = {
      ...validation,
      HOME: "/synthetic/operator",
      OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH: "/synthetic/doctor-result.json",
    };
    now += 600_000;
    const activated = await resolveDoctorUpdateBudget({ cfg, env: live });
    expect(activated).toMatchObject({
      phase: "activation",
      source: "activation-policy",
      inspectionDeadlineMs: now + 149_000,
    });
    expect(activated?.disposalDeadlineMs).toBeUndefined();
    expect(admitDoctorUpdateInspection(activated, "agent", inspection)).toBe(true);
    const nextPhase = {
      ...live,
      ...buildUpdateDoctorEnv({ allowGatewayActivation: false, allowGatewayServiceRepair: false }),
    };
    expect(nextPhase).toHaveProperty(UPDATE_DOCTOR_BUDGET_ENV, undefined);
    expect(
      await resolveDoctorUpdateBudget({ cfg, env: { [UPDATE_DOCTOR_BUDGET_ENV]: parentBudget() } }),
    ).toBeUndefined();
  });
});
