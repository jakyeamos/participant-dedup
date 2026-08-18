# Participant Deduplication context index

last_reviewed: 2026-08-18

Load only the packet needed for the task. Keep the local Apps Script/sidebar,
the Railway scan backend, the Google Sheets connector, and production workbook
deployment separate.

- [README.md](../../README.md) — setup, UAT checklist, scripts, and deployment boundary.
- [Backend contract](../../docs/BACKEND.md) — Railway and service-account integration.
- [Addon packaging](../../docs/ADDON_PACKAGING.md) — standalone Apps Script deployment.

Run typecheck, tests, and build before recording a source change as complete.
Push and deploy only to an explicitly authorized workbook copy or add-on lane.
