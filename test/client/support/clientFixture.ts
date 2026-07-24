import type { ClusterDetail, ClusterDetailRecord } from "@/server/review/clusterDetail";
import type { QueueCounts, QueueItem, QueuePage } from "@/server/review/queue";
import type { HistoryEvent, HistoryPage } from "@/server/history";
import type { BatchSummary } from "@/server/review/summary";
import type { CreatedChallenge } from "@/server/apply/preflight";
import { CLUSTER_STATUSES, CONFIDENCE_LEVELS } from "@/shared/constants";

/**
 * Synthetic sidebar inputs. Every name here is invented; §2 forbids real
 * participant data anywhere in the repository, and a render test only needs
 * values that are distinguishable from each other.
 */

export function counts(overrides: Partial<QueueCounts> = {}): QueueCounts {
  const byConfidence = {} as QueueCounts["byConfidence"];
  for (const c of CONFIDENCE_LEVELS) byConfidence[c] = 0;
  const byStatus = {} as QueueCounts["byStatus"];
  for (const s of CLUSTER_STATUSES) byStatus[s] = 0;
  return { total: 0, byConfidence, byStatus, readyToApply: 0, ...overrides };
}

export function queueItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    clusterId: "c1",
    clusterType: "CORE",
    confidence: "HIGH",
    score: 0.94,
    status: "UNREVIEWED",
    memberCount: 2,
    suggestedCount: 0,
    warnings: [],
    firstSourceRow: 12,
    label: "Ada Placeholder",
    reviewerId: "",
    reviewedAt: "",
    ...overrides,
  };
}

export function queuePage(overrides: Partial<QueuePage> = {}): QueuePage {
  const items = overrides.items ?? [queueItem()];
  return {
    items,
    nextCursor: null,
    counts: counts({ total: items.length }),
    filteredCount: items.length,
    ...overrides,
  };
}

export function clusterRecord(overrides: Partial<ClusterDetailRecord> = {}): ClusterDetailRecord {
  return {
    dedupId: "DD-0001",
    sourceRow: 12,
    label: "Ada Placeholder",
    role: "CORE",
    values: ["Ada", "Placeholder", "1990-01-02", "1 Sample St"],
    ...overrides,
  };
}

export function clusterDetail(overrides: Partial<ClusterDetail> = {}): ClusterDetail {
  return {
    batchId: "b1",
    clusterId: "c1",
    clusterType: "CORE",
    confidence: "HIGH",
    score: 0.94,
    status: "UNREVIEWED",
    revision: 3,
    warnings: [],
    oversized: false,
    reviewerId: "",
    reviewedAt: "",
    notes: "",
    staleReason: "",
    headers: ["First", "Last", "DOB", "Address"],
    records: [
      clusterRecord(),
      clusterRecord({
        dedupId: "DD-0002",
        sourceRow: 40,
        values: ["Ada", "Placeholder", "1990-01-02", ""],
      }),
    ],
    differingHeaders: ["Address"],
    decision: null,
    plan: null,
    ...overrides,
  };
}

export function batchSummary(overrides: Partial<BatchSummary> = {}): BatchSummary {
  return {
    batchId: "b1",
    sourceSheetName: "People",
    totalClusters: 4,
    readyToApplyClusters: 2,
    keepAllClusters: 1,
    unresolvedClusters: 1,
    staleClusters: 0,
    appliedClusters: 0,
    rowsToRetain: 2,
    rowsToDelete: 2,
    blankFieldsToFill: 1,
    manualConflictChoices: 0,
    candidateTruncation: false,
    candidateTruncationCount: 0,
    reviewerIds: ["reviewer@example.test"],
    ...overrides,
  };
}

export function challenge(overrides: Partial<CreatedChallenge> = {}): CreatedChallenge {
  return {
    token: "tok_1",
    summaryHash: "hash_1",
    summary: { clusterCount: 2, retainedCount: 2, deletionRowCount: 2, fillCount: 1 },
    warningText: "This permanently deletes rows.",
    expiresAt: "2026-07-23T18:00:00.000Z",
    ...overrides,
  };
}

export function historyEvent(overrides: Partial<HistoryEvent> = {}): HistoryEvent {
  return {
    eventId: "e1",
    eventAt: "2026-07-23T17:00:00.000Z",
    eventType: "ROW_DELETED",
    actorId: "reviewer@example.test",
    actorType: "USER",
    reviewerId: "reviewer@example.test",
    batchId: "b1",
    applyBatchId: "a1",
    clusterId: "c1",
    sourceSheetName: "People",
    targetDedupId: "DD-0002",
    relatedIds: ["DD-0001"],
    fieldName: "",
    beforeValue: null,
    afterValue: null,
    confidence: "HIGH",
    score: 0.94,
    reasons: [],
    warnings: [],
    result: "SUCCESS",
    errorCode: "",
    errorMessage: "",
    ...overrides,
  };
}

export function historyPage(overrides: Partial<HistoryPage> = {}): HistoryPage {
  const events = overrides.events ?? [historyEvent()];
  return {
    events,
    nextCursor: null,
    filteredCount: events.length,
    totalCount: events.length,
    ...overrides,
  };
}
