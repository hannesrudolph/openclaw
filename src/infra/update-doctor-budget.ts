import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { UpdateCanaryCommand } from "./update-candidate-canary-commands.js";

export const UPDATE_DOCTOR_BUDGET_ENV = "OPENCLAW_UPDATE_DOCTOR_BUDGET";
export const UPDATE_DOCTOR_INSPECTION_WINDOW_MS = 149_000;

type UpdateDoctorValidationBudget = {
  version: 1;
  phase: "validation";
  startedAtMs: number;
  workDeadlineMs: number;
};

/** Carry the existing command clock, including time spent starting Doctor. */
function serializeUpdateDoctorValidationBudget(params: {
  startedAtMs: number;
  workDeadlineMs: number;
}): string {
  return JSON.stringify({ version: 1, phase: "validation", ...params });
}

/** Each command overwrites inherited clocks; non-Doctor phases clear the handoff. */
export function buildUpdateDoctorBudgetEnv(
  phase: UpdateCanaryCommand["phase"],
  startedAtMs: number,
  workDeadlineMs: number,
): NodeJS.ProcessEnv {
  return {
    [UPDATE_DOCTOR_BUDGET_ENV]:
      phase === "doctor" || phase === "lint"
        ? serializeUpdateDoctorValidationBudget({ startedAtMs, workDeadlineMs })
        : undefined,
  };
}

/** Unknown or malformed handoffs cannot authorize optional inspection work. */
export function parseUpdateDoctorValidationBudget(
  value: string,
): UpdateDoctorValidationBudget | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (
    !isRecord(parsed) ||
    parsed.version !== 1 ||
    parsed.phase !== "validation" ||
    typeof parsed.startedAtMs !== "number" ||
    !Number.isSafeInteger(parsed.startedAtMs) ||
    parsed.startedAtMs < 0 ||
    typeof parsed.workDeadlineMs !== "number" ||
    !Number.isSafeInteger(parsed.workDeadlineMs) ||
    parsed.workDeadlineMs < parsed.startedAtMs
  ) {
    return undefined;
  }
  return {
    version: 1,
    phase: "validation",
    startedAtMs: parsed.startedAtMs,
    workDeadlineMs: parsed.workDeadlineMs,
  };
}
