import type { RpcResult } from "@/server/rpc/envelope";

/**
 * §6.1 The spreadsheet menu and the sidebar it opens. Every item here is a
 * shortcut into the same sidebar: no menu callback performs scan or apply work
 * itself, because a menu callback runs under the six-minute limit with no way
 * to report progress and no way for the reviewer to stop it.
 */

const MENU_TITLE = "Deduplication";
const SIDEBAR_TITLE = "Participant Deduplication";

/** §21.1 The view the sidebar opens on. */
export type SidebarView = "BOOTSTRAP" | "APPLY_CONFIRMATION" | "AUDIT_HISTORY" | "QUEUE_FILTERS";

/**
 * What the menu tells the sidebar on load. Serialized into the page by
 * `showSidebar` and read once at startup; it is a starting point, not state.
 */
export interface SidebarBoot {
  view: SidebarView;
  /** §6.1 Whether to begin or resume a batch as soon as the sidebar is ready. */
  autoStart: boolean;
}

/**
 * Renders the sidebar with its boot options injected. `Sidebar.html` reads them
 * from the `<?!= boot ?>` scriptlet; nothing else is passed from the server at
 * load time, so the page starts from a single known state.
 */
export function showSidebar(boot: SidebarBoot): void {
  const template = HtmlService.createTemplateFromFile("Sidebar");
  (template as unknown as Record<string, string>).boot = JSON.stringify(boot);
  SpreadsheetApp.getUi().showSidebar(template.evaluate().setTitle(SIDEBAR_TITLE));
}

export function onOpen(): void {
  SpreadsheetApp.getUi()
    .createMenu(MENU_TITLE)
    .addItem("Scan Active Sheet", "menuScanActiveSheet")
    .addItem("Open Review Sidebar", "menuOpenReviewSidebar")
    .addItem("Queue Filters", "menuQueueFilters")
    .addItem("Refresh Current Batch", "menuRefreshCurrentBatch")
    .addItem("Apply Reviewed Decisions", "menuApplyReviewedDecisions")
    .addItem("View Change History", "menuViewChangeHistory")
    // §6 has no `menuRepairDuplicateIds` global, so the item binds to the
    // allowlisted RPC. It reports its own result — see `reportRepair`.
    .addItem("Repair Duplicate IDs", "rpcRepairDuplicateIds")
    .addToUi();
}

/**
 * Editor add-ons receive `onInstall` when a user installs them from the Sheets
 * UI. Delegating to `onOpen` makes the Deduplication menu appear immediately
 * after install without doing privileged work under limited auth.
 */
export function onInstall(): void {
  onOpen();
}

/**
 * §6.1 Opens the sidebar and gets the reviewer to a useful state: resume a
 * mid-scan batch, show an existing READY queue, or start a scan when there is
 * nothing to resume. A forced rescan is the queue's "Scan again" control.
 */
export function menuScanActiveSheet(): void {
  showSidebar({ view: "BOOTSTRAP", autoStart: true });
}

export function menuOpenReviewSidebar(): void {
  showSidebar({ view: "BOOTSTRAP", autoStart: false });
}

export function menuQueueFilters(): void {
  showSidebar({ view: "QUEUE_FILTERS", autoStart: false });
}

export function menuRefreshCurrentBatch(): void {
  showSidebar({ view: "BOOTSTRAP", autoStart: false });
}

export function menuApplyReviewedDecisions(): void {
  showSidebar({ view: "APPLY_CONFIRMATION", autoStart: false });
}

export function menuViewChangeHistory(): void {
  showSidebar({ view: "AUDIT_HISTORY", autoStart: false });
}

/**
 * §9.4 A toast for the one RPC the menu invokes directly. Called only when
 * there is no sidebar to render the answer, so the reviewer still learns
 * whether anything was repaired.
 */
export function reportRepair(result: RpcResult<{ repaired: number }>): void {
  const message = result.ok
    ? result.data.repaired === 0
      ? "No duplicate participant IDs found."
      : `Repaired ${result.data.repaired} duplicate participant ID(s).`
    : result.error.message;
  SpreadsheetApp.getActiveSpreadsheet().toast(message, MENU_TITLE, 8);
}
