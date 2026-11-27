# Changelog

English | [中文](CHANGELOG.zh-CN.md)

All notable changes to ai-relay and its panel ai-relay-status, newest first. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## v0.30.6

<sub>2026-11-28</sub>

### Fixed

- **Quota probe no longer leaves `git-*` temp dirs in `~/.codex/.tmp`**: the Codex live quota probe now starts `codex app-server -c features.plugins=false`. Previously app-server ran `git ls-remote` for git-sourced plugin marketplaces on startup and was stopped before it finished, leaving an empty `git-XXXXXX` directory behind every time (about 4,000 a day).

## v0.30.5

<sub>2026-11-27</sub>

### Added

- **GLM-5.4 vision in the preset**: the custom-endpoint preset `knownModelCaps` now includes `glm-5.4` (vision: true), so `provider models <name> --add glm-5.4` turns vision on and `provider caps ... vision on` is no longer needed.

## v0.30.4

<sub>2026-11-25</sub>

### Added

- **Stop dispatching to agy when its login expires**: a login failure reported by an agy job is recorded at once, and picking, dispatch and quota checks all skip agy instead of opening a browser login page. Both `relay run` and the executor block it, so queued jobs never reach agy either.
- **Re-login reminder**: the prompt hook reminds the user on every message to run `agy` in a terminal to sign in again, then `relay quota --force` to resume. Status and quota summaries show "login expired".

## v0.30.3

<sub>2026-11-25</sub>

### Fixed

- **agy opened a browser login page on every message after its login expired**: `agy /usage` no longer runs automatically once the login has expired; only `relay quota --force` checks again.
- Ordinary failures also back off for 5 minutes instead of retrying on the next message.
- When several sessions refresh quota at once, they compete under a lock and only one runs agy.

## v0.30.2

<sub>2026-11-25</sub>

### Fixed

- **Medium-task ranking**: mid-tier subscription models are no longer placed in a hard group ahead of strong-tier ones; non-reserved mid and strong subscription candidates compete in the same group by composite score.
- **Pace from stale quota**: stale quota windows are skipped when calculating pace and expiring-soon urgency, so frozen balances no longer produce inflated pace as the reset time approaches.
- **Near-tie ordering**: within the 5% near-tie band, pace breaks ties when both paces are known; when only one is known, it wins only if positive (quota to spend before reset), otherwise ranking falls back to the composite score instead of treating an unknown pace as `0`.

## v0.30.1

<sub>2026-11-25</sub>

### Fixed

- **Background notifications reset the round**: task notifications, sub-agent messages and other system messages are no longer treated as a new round; the user's prompt, the round's division decision, hand-written line count and read count are kept.

## v0.30.0

<sub>2026-11-24 · panel ai-relay-status 0.29.0</sub>

### Added

- **Gemini 4 Carbon**: joins the gemini pool (high is strong tier, low / medium mid) and is routed for implement, debug, review, read, deep and claude-backup. Older configs migrate automatically.

### Fixed

- **Model discovery missed models**: models that were already listed but never pooled are now onboarded; failed families wait 24 hours before another attempt, undone ones stay out, and orchestrator entries are ignored.
- **Panel View button**: brings the pane to the front even when it is already open behind another tab or collapsed.

## v0.29.0

<sub>2026-11-24</sub>

### Changed

- **Thinking effort per task**: workers no longer always run at maximum thinking. The lead picks low / medium / high / max with `--effort` or a `思考：` line; otherwise easy → medium, medium → high, hard → max, with code and doc writing one level higher and hard tasks never below high.
- agy switches to the matching model variant; Codex `--effort`, Grok `--reasoning-effort` and the custom-endpoint thinking budget follow the chosen level. Grok's fixed xhigh in older configs is migrated away.

## v0.28.0

<sub>2026-11-24</sub>

### Changed

- **`quick` route adds Neon and Argon**: medium and hard questions still have a worker after Grok was disabled; simple questions still go to the light model first. Older configs migrate automatically.
- **Simple tasks weigh role fit more**: role fit counts more and economy less, so a light model still wins when its fit is close, but a much better-suited model wins when the gap is large (e.g. 0.4 vs 0.9).

### Fixed

- **Stalled jobs no longer count against reliability**: jobs that timed out or were cancelled with no output and no workspace changes are treated as a CLI or service hang.

## v0.27.0

<sub>2026-11-24 · panel ai-relay-status 0.28.0</sub>

### Added

- **New-model onboarding**: `relay models discover`, triggered by the panel on a schedule. Pools by official quota group, researches tier and role fit online, writes the config add-only, and every change can be undone.
- **Gemini 4 Neon**: joins the gemini pool, high thinking variants are strong tier, and it is routed for implement, debug, review, read, deep and claude-backup. Older configs migrate automatically.

### Fixed

- When a worker reports an exhausted quota (including agy's `RESOURCE_EXHAUSTED` / `Individual quota reached`), the pool is blocked until the reset time in the error; quota failures no longer lower a model's reliability.
- Read-only tasks no longer count write-only full access as "can run commands"; for a named vendor, vision is judged on the model actually picked.
- The old `read` route made `run` reject the model `pick` had just chosen; fixed and migrated.
- Medium tasks with a step spec no longer prefer a light model over a qualified one; duplicate routes keep the higher fit; ranking uses unrounded scores.
- "Save for hard tasks" applies only to pools that have a strong model and are under half full, and a saved subscription pool still ranks ahead of metered endpoints.
- `--downgrade` without a reason no longer swallows the next flag; Codex dispatch reads the panel's default model, supports downgrade and passes per-model vision; `--model` in the body is still tier-checked, except inside code blocks.
- `relay cancel` stops the real worker process; a foreground relay that is killed takes its worker process group with it.
- agy idle timeout identifies the session database by process group, so panel polling or other agy sessions on the machine no longer keep a stuck task alive.
- With parallel dispatches, auto-review diffs, out-of-scope checks and changed-line counts cover only the task's own changes; running from a repo subdirectory works for change detection, scope checks and write locks.
- `--write` inside a brief body no longer opens the edit gate; a rejected `relay run` does not count as a dispatch; reworks keep their session.
- Parallel Bash calls keep separate line snapshots; Codex write records without a pid release their lock after the idle timeout; quota cache and metered usage use a file lock and atomic writes.
- Job logs, Codex logs, verification output and connectivity tests are all masked for secrets.
- Panel: View opens the Conversation page even when the pane is behind another tab; a failed connectivity test shows the reason; the lead's line count skips docs and denied edits; continued turns keep the self-work reason; Codex token totals no longer double-count or mix up parallel runs.

## v0.25.0

<sub>2026-11-18 · panel ai-relay-status 0.27.1</sub>

### Added

- Gemini 4 Hydrogen in the default config.
- Writable dispatches with 150+ changed lines get an automatic review from another vendor.

### Changed

- Workers always run at maximum thinking.

### Fixed

- Added the commands the panel depends on.

## v0.23.0

<sub>2026-11-16 · panel ai-relay-status 0.26.0</sub>

### Added

- Custom endpoints for domestic models, metered with a daily cap.
- Writable dispatches run verification commands automatically.
- Exhausted quotas reported by workers are flagged automatically.

### Changed

- Dispatch is paced by quota, with tighter rules for the lead doing work itself.
- Medium tasks with a step spec may drop one tier.
- Collapsible vendor cards on the Providers page.

## v0.20.0

<sub>2026-11-09 · panel ai-relay-status 0.25.1</sub>

### Changed

- Codex model and reasoning effort follow task difficulty.

## v0.19.0

<sub>2026-11-09 · panel ai-relay-status 0.25.0</sub>

### Added

- Each dispatch is reviewed as it finishes, and failures go back with `relay rework`.

### Changed

- Every brief must state a difficulty, which gates the tier.

## v0.18.2

<sub>2026-11-08 · panel ai-relay-status 0.24.0</sub>

### Added

- The "review every result" rule: the lead personally reviews every dispatched result.

### Changed

- The division-of-labor gate covers multiple repos.
- The Conversation project filter defaults to the current window.

## v0.17.1

<sub>2026-11-06 · panel ai-relay-status 0.22.0</sub>

### Added

- Panel master switch for ai-relay.

### Fixed

- Missing token data for the lead model.
- False agy timeouts.

## v0.17.0

<sub>2026-11-06 · panel ai-relay-status 0.20.0</sub>

### Added

- Pick a default model per pool on the Providers page.
- The Conversation page groups by user message and shows token usage per model.

## v0.13.1

<sub>2026-11-05</sub>

### Added

- Throttling by remaining Claude quota, with a quality floor.

## v0.12.0

<sub>2026-11-05</sub>

### Changed

- Quota weight lowered to the minimum; `relay run auto` no longer silently skips Codex.

## v0.11.0

<sub>2026-11-05 · panel ai-relay-status 0.14.0</sub>

First release.
