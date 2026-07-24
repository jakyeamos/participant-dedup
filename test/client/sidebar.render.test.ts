import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderQueue, renderQueueFilters, readQueueFilters, renderFilterSettings } from "@/client/views/queue";
import { readDecision, renderClusterReview } from "@/client/views/cluster";
import {
  renderError,
  renderIdentityRequired,
  renderLoading,
  renderScanProgress,
} from "@/client/views/status";
import { renderApplyConfirmation, renderApplyResult, renderBatchSummary } from "@/client/views/apply";
import { renderHistory } from "@/client/views/history";
import { clearFallbackName, readFallbackName, writeFallbackName } from "@/client/session";
import {
  batchSummary,
  challenge,
  clusterDetail,
  clusterRecord,
  historyEvent,
  historyPage,
  queueItem,
  queuePage,
} from "./support/clientFixture";

/** §21.8 The string a hostile cell would contain. */
const HOSTILE = '<script>alert(1)</script><img src=x onerror="alert(2)">';

const noopClusterHandlers = {
  onSave: vi.fn(),
  onFocusRow: vi.fn(),
  onBack: vi.fn(),
};

const noopQueueHandlers = {
  onOpenFilters: vi.fn(),
  onOpenCluster: vi.fn(),
  onLoadMore: vi.fn(),
  onReviewSummary: vi.fn(),
};

describe("§21.8 safe rendering", () => {
  it("renders a hostile participant value as text, not markup", () => {
    const detail = clusterDetail({
      headers: ["First", "Last"],
      records: [
        clusterRecord({ dedupId: "DD-1", label: HOSTILE, values: [HOSTILE, "Placeholder"] }),
        clusterRecord({ dedupId: "DD-2", label: "Bo Placeholder", values: ["Bo", "Placeholder"] }),
      ],
      differingHeaders: ["First"],
    });

    const view = renderClusterReview(detail, noopClusterHandlers);

    expect(view.querySelector("script")).toBeNull();
    expect(view.querySelector("img")).toBeNull();
    expect(view.innerHTML).toContain("&lt;script&gt;");
    expect(view.textContent).toContain(HOSTILE);
  });

  it("renders a hostile cluster label in the queue as text", () => {
    const view = renderQueue(
      queuePage({ items: [queueItem({ label: HOSTILE })] }),
      { confidence: ["HIGH"], statuses: ["UNREVIEWED"] },
      noopQueueHandlers,
    );

    expect(view.querySelector("script")).toBeNull();
    expect(view.textContent).toContain(HOSTILE);
  });

  it("offers Scan again when a rescan handler is provided", () => {
    const onRescan = vi.fn();
    const view = renderQueue(
      queuePage({ items: [queueItem()] }),
      { confidence: ["HIGH"], statuses: ["UNREVIEWED"] },
      { ...noopQueueHandlers, onRescan },
    );
    const control = view.querySelector('[data-action="rescan"]') as HTMLButtonElement;
    expect(control).toBeTruthy();
    control.click();
    expect(onRescan).toHaveBeenCalledOnce();
  });

  it("renders hostile audit values as text", () => {
    const view = renderHistory(
      historyPage({
        events: [historyEvent({ fieldName: "Address", beforeValue: HOSTILE, afterValue: "" })],
      }),
      { onLoadMore: vi.fn() },
    );

    expect(view.querySelector("script")).toBeNull();
    expect(view.textContent).toContain(HOSTILE);
  });
});

describe("§21.4 default queue filters", () => {
  it("checks High and Medium and leaves Low unchecked", () => {
    const form = renderQueueFilters({
      confidence: ["HIGH", "MEDIUM"],
      statuses: ["UNREVIEWED", "IN_PROGRESS"],
    });

    const checked = (name: string): string[] =>
      Array.from(form.querySelectorAll<HTMLInputElement>(`input[name="${name}"]:checked`)).map(
        (input) => input.value,
      );

    expect(checked("confidence")).toEqual(["HIGH", "MEDIUM"]);
    expect(form.querySelector<HTMLInputElement>('input[name="confidence"][value="LOW"]')).not.toBeNull();
    expect(checked("confidence")).not.toContain("LOW");
    expect(checked("status")).toEqual(["UNREVIEWED", "IN_PROGRESS"]);
  });

  it("reads back exactly what is checked", () => {
    const form = renderQueueFilters({
      confidence: ["HIGH", "MEDIUM"],
      statuses: ["UNREVIEWED", "IN_PROGRESS"],
    });

    expect(readQueueFilters(form)).toEqual({
      confidence: ["HIGH", "MEDIUM"],
      statuses: ["UNREVIEWED", "IN_PROGRESS"],
    });

    form.querySelector<HTMLInputElement>('input[name="confidence"][value="LOW"]')!.checked = true;
    expect(readQueueFilters(form).confidence).toEqual(["HIGH", "MEDIUM", "LOW"]);
  });

  it("keeps the filter form off the queue and behind Change filters", () => {
    const view = renderQueue(
      queuePage({
        items: [
          queueItem({ clusterId: "c1", confidence: "HIGH", label: "One Placeholder" }),
          queueItem({ clusterId: "c2", confidence: "MEDIUM", label: "Two Placeholder" }),
        ],
      }),
      { confidence: ["HIGH", "MEDIUM"], statuses: ["UNREVIEWED"] },
      noopQueueHandlers,
    );

    expect(view.querySelector("form.dd-filters")).toBeNull();
    expect(view.textContent).toContain("Showing: High, Medium · Unreviewed");
    expect(view.querySelector('[data-action="open-filters"]')).not.toBeNull();

    const rows = view.querySelectorAll("[data-cluster-id]");
    expect(Array.from(rows).map((r) => r.getAttribute("data-cluster-id"))).toEqual(["c1", "c2"]);
  });

  it("saves filters from the dedicated filter screen", () => {
    const onSave = vi.fn();
    const view = renderFilterSettings(
      { confidence: ["HIGH"], statuses: ["UNREVIEWED"] },
      { onSave, onBack: vi.fn() },
    );

    view.querySelector<HTMLInputElement>('input[name="confidence"][value="MEDIUM"]')!.checked = true;
    view.querySelector<HTMLButtonElement>('[data-action="save-filters"]')!.click();

    expect(onSave).toHaveBeenCalledWith({
      confidence: ["HIGH", "MEDIUM"],
      statuses: ["UNREVIEWED"],
    });
  });
});

describe("loading state", () => {
  it("renders an immediate loading screen", () => {
    const view = renderLoading("Opening…");
    expect(view.getAttribute("data-view")).toBe("LOADING");
    expect(view.textContent).toContain("Opening…");
    expect(view.querySelector(".dd-progress-indeterminate")).not.toBeNull();
  });
});

describe("§21.6 cluster review", () => {
  it("preselects no deletion and cannot be saved on open", () => {
    const view = renderClusterReview(clusterDetail(), noopClusterHandlers);

    expect(view.querySelector('input[name="mode"]:checked')).toBeNull();
    expect(view.querySelector('input[name="retain"]:checked')).toBeNull();
    expect(view.querySelector<HTMLButtonElement>('[data-action="save"]')!.disabled).toBe(true);
    expect(readDecision(view, clusterDetail())).toBeNull();
  });

  it("enables saving once the reviewer picks a mode", () => {
    const detail = clusterDetail();
    const view = renderClusterReview(detail, noopClusterHandlers);

    const keepAll = view.querySelector<HTMLInputElement>('input[name="mode"][value="KEEP_ALL"]')!;
    keepAll.checked = true;
    keepAll.dispatchEvent(new Event("change", { bubbles: true }));

    expect(view.querySelector<HTMLButtonElement>('[data-action="save"]')!.disabled).toBe(false);
    expect(readDecision(view, detail)).toMatchObject({
      batchId: "b1",
      clusterId: "c1",
      expectedRevision: 3,
      mode: "KEEP_ALL",
      retainedIds: ["DD-0001", "DD-0002"],
      deleteAssignments: {},
    });
  });

  it("assigns each unretained record to a retained one in select mode", () => {
    const detail = clusterDetail();
    const view = renderClusterReview(detail, noopClusterHandlers);

    const select = view.querySelector<HTMLInputElement>('input[name="mode"][value="SELECT_RECORDS"]')!;
    select.checked = true;
    select.dispatchEvent(new Event("change", { bubbles: true }));

    const retain = view.querySelector<HTMLInputElement>('input[name="retain"][value="DD-0001"]')!;
    retain.checked = true;
    retain.dispatchEvent(new Event("change", { bubbles: true }));

    expect(readDecision(view, detail)).toMatchObject({
      mode: "SELECT_RECORDS",
      retainedIds: ["DD-0001"],
      deleteAssignments: { "DD-0002": "DD-0001" },
    });
  });

  it("lets Keep this record select Choose records to keep", () => {
    const detail = clusterDetail();
    const view = renderClusterReview(detail, noopClusterHandlers);

    const retain = view.querySelector<HTMLInputElement>('input[name="retain"][value="DD-0001"]')!;
    expect(retain.disabled).toBe(false);
    retain.checked = true;
    retain.dispatchEvent(new Event("change", { bubbles: true }));

    expect(
      view.querySelector<HTMLInputElement>('input[name="mode"][value="SELECT_RECORDS"]')!.checked,
    ).toBe(true);
    expect(readDecision(view, detail)).toMatchObject({
      mode: "SELECT_RECORDS",
      retainedIds: ["DD-0001"],
      deleteAssignments: { "DD-0002": "DD-0001" },
    });
    expect(view.querySelector<HTMLButtonElement>('[data-action="save"]')!.disabled).toBe(false);
  });

  it("hides the merge-target region until more than one record is kept", () => {
    const detail = clusterDetail();
    const view = renderClusterReview(detail, noopClusterHandlers);
    const targets = view.querySelector<HTMLElement>('[data-region="targets"]')!;

    expect(targets.hidden).toBe(true);

    const select = view.querySelector<HTMLInputElement>('input[name="mode"][value="SELECT_RECORDS"]')!;
    select.checked = true;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(targets.hidden).toBe(true);

    for (const id of ["DD-0001", "DD-0002"]) {
      const retain = view.querySelector<HTMLInputElement>(`input[name="retain"][value="${id}"]`)!;
      retain.checked = true;
      retain.dispatchEvent(new Event("change", { bubbles: true }));
    }
    // Both kept — nothing to merge into, so still hidden.
    expect(targets.hidden).toBe(true);
  });

  it("refuses a select-records decision that retains nothing", () => {
    const detail = clusterDetail();
    const view = renderClusterReview(detail, noopClusterHandlers);

    const select = view.querySelector<HTMLInputElement>('input[name="mode"][value="SELECT_RECORDS"]')!;
    select.checked = true;
    select.dispatchEvent(new Event("change", { bubbles: true }));

    expect(view.querySelector<HTMLButtonElement>('[data-action="save"]')!.disabled).toBe(true);
    expect(readDecision(view, detail)).toBeNull();
  });

  it("offers Open source row for each record", () => {
    const view = renderClusterReview(clusterDetail(), noopClusterHandlers);
    const buttons = view.querySelectorAll<HTMLButtonElement>('[data-action="focus-row"]');

    expect(Array.from(buttons).map((b) => b.getAttribute("data-dedup-id"))).toEqual([
      "DD-0001",
      "DD-0002",
    ]);

    buttons[0]!.click();
    expect(noopClusterHandlers.onFocusRow).toHaveBeenCalledWith("DD-0001");
  });

  it("hides _Dedup_ID and columns that are blank on every record", () => {
    const detail = clusterDetail({
      headers: ["_Dedup_ID", "First", "Last", "Phone", "", "Notes"],
      records: [
        clusterRecord({
          values: ["id-1", "Ada", "Lovelace", "555-0100", "", ""],
        }),
        clusterRecord({
          dedupId: "DD-0002",
          sourceRow: 40,
          values: ["id-2", "Ada", "Lovelace", "", "", ""],
        }),
      ],
      differingHeaders: ["Phone"],
    });
    const view = renderClusterReview(detail, noopClusterHandlers);
    const names = Array.from(view.querySelectorAll(".dd-field-name")).map((n) => n.textContent);

    expect(names).toEqual(["First", "Last", "Phone", "First", "Last", "Phone"]);
    expect(names).not.toContain("_Dedup_ID");
    expect(names).not.toContain("Notes");
    expect(view.querySelectorAll(".dd-field-value.dd-blank")).toHaveLength(1);
  });
});

describe("§24 apply confirmation", () => {
  it("keeps apply disabled until confirm is typed exactly", () => {
    const view = renderApplyConfirmation(challenge(), batchSummary(), "confirm", {
      onApply: vi.fn(),
      onBack: vi.fn(),
    });

    const apply = view.querySelector<HTMLButtonElement>('[data-action="apply"]')!;
    const field = view.querySelector<HTMLInputElement>('[data-field="confirmation"]')!;
    expect(view.textContent).toContain('Type "confirm" exactly');
    expect(apply.disabled).toBe(true);

    field.value = "Confirm";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    expect(apply.disabled).toBe(true);

    field.value = "confirm";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    expect(apply.disabled).toBe(false);
  });

  it("shows what an apply would delete before it runs", () => {
    const view = renderBatchSummary(batchSummary(), { onApply: vi.fn(), onBack: vi.fn() });
    expect(view.textContent).toContain("2");
    expect(view.querySelector('[data-stat="rowsToDelete"]')!.textContent).toBe("2");
  });

  it("reports what an apply actually did", () => {
    const view = renderApplyResult(
      { applyBatchId: "a1", deletedRows: 2, filledFields: 1, auditWritten: 6 },
      { onDone: vi.fn() },
    );
    expect(view.querySelector('[data-stat="deletedRows"]')!.textContent).toBe("2");
    expect(view.querySelector('[data-stat="auditWritten"]')!.textContent).toBe("6");
  });
});

describe("error and identity views", () => {
  it("offers retry only for a retryable error", () => {
    const onRetry = vi.fn();
    const retryable = renderError(
      { code: "LOCK_TIMEOUT", message: "The spreadsheet is busy.", retryable: true },
      { onRetry },
    );
    expect(retryable.querySelector('[data-action="retry"]')).not.toBeNull();
    expect(retryable.textContent).toContain("The spreadsheet is busy.");

    const fatal = renderError(
      { code: "SCHEMA_CHANGED", message: "The sheet changed.", retryable: false },
      { onRetry },
    );
    expect(fatal.querySelector('[data-action="retry"]')).toBeNull();
  });

  it("asks for a name when the account email is unavailable", () => {
    const onSubmit = vi.fn();
    const view = renderIdentityRequired({ onSubmit });
    const field = view.querySelector<HTMLInputElement>('[data-field="fallbackName"]')!;

    field.value = "  Reviewer One  ";
    view.querySelector<HTMLButtonElement>('[data-action="use-name"]')!.click();

    expect(onSubmit).toHaveBeenCalledWith("Reviewer One");
  });

  it("shows estimated scan progress with ETA and real counters", () => {
    const view = renderScanProgress(
      {
        batchId: "b1",
        status: "SCORING",
        phase: "SCORING",
        metrics: {
          records: 500,
          candidates: 1200,
          qualifiedEdges: 40,
          clusters: 0,
          sourceRows: 500,
        },
        warnings: [],
      },
      { onCancel: vi.fn() },
      { elapsedMs: 30_000 },
    );

    const bar = view.querySelector<HTMLElement>('[role="progressbar"]')!;
    expect(bar.getAttribute("aria-valuenow")).toBe("63");
    expect(view.textContent).toContain("63%");
    expect(view.textContent).toContain("remaining");
    expect(view.querySelector('[data-stat="records"]')!.textContent).toBe("500");
    expect(view.querySelector('[data-action="cancel"]')).not.toBeNull();
  });

  it("interpolates snapshot progress from records written", () => {
    const view = renderScanProgress(
      {
        batchId: "b1",
        status: "SNAPSHOTTING",
        phase: "SNAPSHOTTING",
        metrics: {
          records: 1500,
          candidates: 0,
          qualifiedEdges: 0,
          clusters: 0,
          sourceRows: 3000,
        },
        warnings: [],
      },
      { onCancel: vi.fn() },
      { elapsedMs: 20_000 },
    );
    // Midpoint of 5–35 band at 50% of rows → 20%
    expect(view.querySelector('[role="progressbar"]')!.getAttribute("aria-valuenow")).toBe("20");
  });
});

describe("§21.3 fallback identity storage", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
  });

  it("stores the typed name in sessionStorage and never in localStorage", () => {
    writeFallbackName("Reviewer One");

    expect(readFallbackName()).toBe("Reviewer One");
    expect(window.sessionStorage.length).toBe(1);
    expect(window.localStorage.length).toBe(0);
  });

  it("forgets the name on request", () => {
    writeFallbackName("Reviewer One");
    clearFallbackName();
    expect(readFallbackName()).toBe("");
    expect(window.sessionStorage.length).toBe(0);
  });
});
