# Manual acceptance

中文：[手动验收](手动验收.md). The 1.1.0 checklist below is the current release checklist; the 0.4.0 checklist after it is kept as a historical record. These are operator checks, not claims that every UI or deployment has been exercised. Use a disposable profile and workspace; retain commands, observed results, platform/host versions and the candidate commit.

## 1.1.0 computer use (current)

Run on a real Windows 10/11 x64 desktop. Nothing in this list is exercised by CI: the repository suites cover the vendored upstream units with mocks, not a live desktop. Record the OS build, the DSH version, the commit and a screenshot per step.

1. **Install and identity.** In a disposable profile, run `npx --yes dsh-ops-pro@latest install --profile desktop`, start the host and confirm exactly one row with id `dsh-ops-pro` at 1.1.0; `dsh-ops-pro status --profile desktop` agrees. The `ops_cu_*` tools are absent while the computer-use row is disabled.
2. **Enable.** Turn the computer-use row on, restart, and confirm the 26 `ops_cu_*` tools appear. With the row off again, they disappear and no child process remains (check with `tasklist`).
3. **Desktop identification.** Open a normal Win32 application (Notepad is enough). `cu_snapshot` and `cu_accessibility_tree` return an element tree; `cu_find` locates a menu item by name; `cu_invoke` activates it. Do not move the mouse: the lane works in the background, so the pointer position must be unchanged afterwards.
4. **Element ids.** Reuse an id from step 3 for `cu_element_info` and one action; then activate another window, return, and confirm the stale id is rejected rather than acting on the wrong element. `cu_set_value` with `elementId: "new-tab"` in the browser lane opens a page.
5. **Approval and refusal.** Trigger an action that needs approval (for example `cu_type_text` into a focused field after `cu_focus`). Confirm the approval prompt names the action and the target; deny once and confirm nothing was typed. No credential value may appear in the prompt or the report.
6. **Browser lane.** Launch the browser lane with a throwaway profile, open one site, read the accessibility outline, fill a field with `cu_set_value` and close the lane. Then set `browserAttachUser` and confirm attaching to the user's own browser requires explicit approval plus remote debugging, and that the plugin never signs in on its own.
7. **Failure recovery.** Kill the computer-use child process once and confirm it restarts; kill it twice within a minute and confirm the tools report `CU_UNAVAILABLE` instead of retrying silently. A tool timeout reports `CU_TIMEOUT` and leaves no half-executed action.
8. **Sidebar console.** Open the 电脑操控 tab, change one setting, and confirm it lands in `<DSH_HOME>/dsh-ops/computer-use.json` and restarts only the computer-use runtime. The Status tab reports the same state the CLI prints.
9. **Usage statistics.** Run a handful of tool calls, check calls, failures, p50/p95 wall time and the estimated token count in the 用量统计 tab; `resetUsage` clears them and `<DSH_HOME>/dsh-ops/usage.json` stays valid JSON.
10. **Uninstall.** Uninstall, restart, and confirm no `ops_cu_*` tools, no child process, and that `computer-use.json` and `usage.json` survive for a rollback.

## 0.4.0 checklist (historical)

## Build and release evidence

Run the [full release gate](CONTRIBUTING.md#the-verification-gate) with the required worker and,
on Windows, the verified Bash fixture. A skipped required runtime is not a pass. Run the separate
[BM-01–05 gates](benchmark-gates.md); record individual failed/blocked/passed states and raw receipts.
Apply the explicitly approved criteria: BM-01 requires at least 40% fewer bytes than OPS 0.3.x on the fixed lossless workload; retain the official reader as a separate comparison. BM-03 applies ≤400 tokens to the file/discovery schemas while keeping Bash at startup. Record both the scoped score and the full actual provider total, and require the exact default tool inventory including a usable Bash (pinned Windows payload or host Bash). A smaller workload, missing Bash or functional CI success cannot replace these measurements.

## Profiles and configuration

1. Start a saved six-row profile with explicit name-qualified overrides, mixed on/off switches and
   unrelated plugin settings. Upgrade and restart twice. Verify seven unique OPS IDs, the unchanged
   legacy file name/configuration, preserved switches and the added discovery row.
2. In a fresh profile, verify file/PTC/discovery on, shell on for all three platforms, and
   panel/TUI/replacements off. Enable a fresh panel row and observe new events; disable it and verify queued collection stops
   with no final fold. An explicit legacy capture:false must stay inert until changed by the operator.
3. Save valid built-in row settings and restart. Reject an unknown key or wrong type without changing
   saved values. A stale revision must not overwrite a newer edit. Null legacy file/root/shell settings
   must keep their defaults. A disabled row must be enabled before editing.
   Apply only to the stopped disposable profile with --offline --yes. Verify backup originals, seven
   retained IDs/switches/configs, restart and custom-page activation. Disable/re-enable the carrier and
   verify custom pages unload/recover. External ambiguous overrides must refuse without writes.

## Tool publication and results

1. Inspect the actual first provider request: Standard/Cordis Native has inspect_local_file/glob/grep,
   discover_tools and an available Bash; read_files/result and advanced document schemas are absent. Select one advanced capability and verify it appears only in
   the owning next request, not in current-round diagnostics or a sibling agent.
2. PTC starts with inspect_local_file/load_sdk. Load result on demand, including with allowedTools: [].
   Load permitted advanced APIs through ops_load_sdk and
   check the next SDK snapshot, typed Outcome status and data. Preserve an operator's explicit allowed
   pool; tool listing must not imply filesystem permission.
3. Read three file ranges once. Reconstruct escaped lines exactly, check per-file errors and both
   pending-input and in-file continuations. Edit five ranges in one file with a revision; stale or
   overlapping edits must change nothing. Never treat a partial response as full coverage.
4. Exercise CSV/TSV, DOCX and a supported text-layer PDF, plus malformed/unsupported later content.
   Safe prefixes may survive, but total/revision require a stable complete scan. Check page versus scan
   versus display/reference-capture completeness and the explicit excluded document scope.
5. Select an official replacement only when its exact OPS counterpart is ready: read requires
   inspect_local_file, not read_files. An unrelated same-name tool must not satisfy readiness.

## Authority, runtime and teardown

Use read-only, workspace-write and full-access sessions. Credential-fenced reads must reject.
Writes must reject in read-only, and outside writes must reject in workspace-write, without leaking
denied paths/content or changing files. Full access follows its documented broader write authority. A host-authorized ordinary outside
read is an allowed control, not a failed workspace jail. Verify authority changes and cancellation
stop or invalidate owned work, and unloading removes only this plugin's registrations.

Bash must keep the host command/description/cwd/timeout contract, approvals, job IDs and output kinds.
Default timeout is 120 seconds, maximum 600. Without jobs, background is absent. With jobs, collect or
stop through host job tools; a timeout promotion must not execute the command twice. Windows restricted
modes have documented partial enforcement and exact MSYS compatibility requirements.

Runtime management must first show a plan, then require explicit execution. Cancellation after launch
may have unknown effects. Git/managed selection edits a draft until saved. PowerShell upgrades target
the standard host installation, require restart and leave custom pwshPath review to the operator.
Do not claim installation success from opening a page or losing a transport connection.

Record TUI acceptance separately when a compatible dsh-TUI host is available. The optional host suites
must be reported as skipped when it is absent; synthetic registry tests do not replace terminal UI
acceptance. Preserve every failure and skip in the release review.
