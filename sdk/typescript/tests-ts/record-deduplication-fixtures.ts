import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  DeduplicationReviewRequest,
  Finding,
  FindingsDocument,
} from "../src/index.js";
import { PLUGIN_ROOT } from "./plugin-root.js";

const fixture: FindingsDocument = JSON.parse(
  await readFile(
    join(PLUGIN_ROOT, "examples/completed-scan/findings.json"),
    "utf8",
  ),
);

export function finding(index: number): Finding {
  return {
    ...structuredClone(fixture.findings[0]!),
    findingId: `csf_${index.toString(16).padStart(24, "0")}`,
    occurrenceId: `occ_${index.toString(16).padStart(24, "0")}`,
    title: `Synthetic issue ${index}`,
    extensions: {
      originalEvidence: { description: `Complete evidence ${index}` },
    },
  };
}

export function assigned(request: DeduplicationReviewRequest): Finding[] {
  return JSON.parse(
    request.prompt.slice(request.prompt.lastIndexOf("\n\n") + 2),
  ).findings;
}

export function submission(
  request: DeduplicationReviewRequest,
  same = true,
): unknown {
  const findings = assigned(request);
  if (request.stage === "screening")
    return {
      decisions: Object.fromEntries(
        findings.slice(1).map((_, index) => [
          `pair-${index + 1}`,
          {
            decision: same ? "SAME" : "DISTINCT",
            rationale: same
              ? "One control closes both reported paths."
              : "Independent corrections are required.",
          },
        ]),
      ),
    };
  return same
    ? {
        decision: "SAME",
        rationale: "The inspected shared control closes both complete paths.",
        canonicalFindingId: findings[0]!.findingId,
        mergedFinding: {
          ...findings[0],
          title: findings.map((value) => value.title).join("; "),
          extensions: { originalFindings: findings },
        },
      }
    : {
        decision: "DISTINCT",
        rationale: "Independent corrections are required.",
      };
}
