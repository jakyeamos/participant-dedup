import type { SheetsGateway } from "@/server/sheets/SheetsGateway";
import type { Cluster } from "@/server/types";
import { sha256Hex } from "@/server/hashing";
import { stateRepository } from "@/server/stateRepository";

export const SUPPRESSION_STATE_TYPE = "SUPPRESSION";

export interface SuppressionMember {
  dedupId: string;
  relevantHash: string;
}

interface SuppressionValue {
  memberIds: string[];
  memberContentHash: string;
  configHash: string;
}

/** §19.1 Identity of a suppressed cluster: its membership under one config. */
export function suppressionKey(memberIds: string[], configHash: string): string {
  const sorted = [...memberIds].sort();
  return sha256Hex(`${sorted.join("|")}|${configHash}`);
}

/** §19.1 Content of a suppressed cluster: what each member looked like when kept. */
export function memberContentHash(members: ReadonlyArray<SuppressionMember>): string {
  const sorted = [...members].sort((a, b) => a.dedupId.localeCompare(b.dedupId));
  return sha256Hex(sorted.map((m) => `${m.dedupId}:${m.relevantHash}`).join("|"));
}

/** §19.2 step 3. Idempotent: re-saving the same decision updates one state row. */
export function recordKeepAll(
  gateway: SheetsGateway,
  members: ReadonlyArray<SuppressionMember>,
  configHash: string,
): void {
  const memberIds = members.map((m) => m.dedupId).sort();
  const value: SuppressionValue = {
    memberIds,
    memberContentHash: memberContentHash(members),
    configHash,
  };
  stateRepository(gateway).put(
    SUPPRESSION_STATE_TYPE,
    suppressionKey(memberIds, configHash),
    value,
  );
}

/**
 * §19.3 A cluster stays suppressed only while its member ids, their relevant
 * hashes, and the config all match what the reviewer saw when they chose Keep
 * All. Any change of membership, content, or config makes it eligible again.
 */
export function isSuppressed(
  gateway: SheetsGateway,
  members: ReadonlyArray<SuppressionMember>,
  configHash: string,
): boolean {
  const memberIds = members.map((m) => m.dedupId).sort();
  const row = stateRepository(gateway).get(
    SUPPRESSION_STATE_TYPE,
    suppressionKey(memberIds, configHash),
  );
  if (!row) return false;

  const stored = row.valueJson as SuppressionValue | null;
  if (!stored) return false;
  return (
    stored.configHash === configHash &&
    stored.memberContentHash === memberContentHash(members)
  );
}

/** §19.3 last line: a Keep All decision that is changed loses its suppression. */
export function clearKeepAll(
  gateway: SheetsGateway,
  memberIds: string[],
  configHash: string,
): void {
  stateRepository(gateway).put(
    SUPPRESSION_STATE_TYPE,
    suppressionKey(memberIds, configHash),
    null,
  );
}

/**
 * §19.3 Scan-time filter. Drops generated clusters and Low pairs the reviewer
 * already kept, using the current relevant hash of each member so an edited row
 * brings its cluster straight back into the queue.
 */
export function filterSuppressed(
  gateway: SheetsGateway,
  clusters: Cluster[],
  relevantHashOf: (dedupId: string) => string,
  configHash: string,
): Cluster[] {
  return clusters.filter((c) => {
    const members = c.memberIds.map((id) => ({
      dedupId: id,
      relevantHash: relevantHashOf(id),
    }));
    return !isSuppressed(gateway, members, configHash);
  });
}
