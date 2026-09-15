import type { Finding } from "../models.js";

/** The grouping algorithm uses only identity and observed severity. */
export interface DeduplicationIdentity {
  findingId: string;
  severity: { level: Finding["severity"]["level"] };
}
