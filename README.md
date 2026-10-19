# AI App Builder

Autonomous cloud builder that creates real Android apps from plain-text ideas.
A plan for an idea, twenty named agents that produce it, a Gradle build on GitHub
Actions, and a public release that is only reported once it has been downloaded
and verified.

## Key principles
- Public only: every app and release is public.
- Cloud-only builds. Gradle runs on GitHub Actions; no local Android SDK needed.
- Twenty agents, each with a declared contract, owned files and failure policy.
  Identity and order live in `scripts/agents/agentIds.ts`.
- Truthful progress. Percentages come from recorded evidence, never from a timer.
- Real artifacts only. An APK checksum, icon check and public download URL are
  reported only when the evidence chain proves them.

## Flow
IDEA → ANALYZE → DESIGN → PLAN → SCAFFOLD → IMPLEMENT → TESTGEN → VALIDATE →
CLOUD_BUILD → BUILD_SUCCESS → REAL_APK → APK_VERIFY → REAL_ICON_VERIFY →
RELEASE → RELEASE_ASSET → PUBLIC_HTTPS_URL → PUBLIC_DOWNLOAD → FINAL_VERIFY

A stage is shown as done only when `.builder/live/state.json` carries its
evidence. That is the same proof `lifecycleGate` checks before a download URL or
a completion screen may appear.

## The fleet
| # | Agent | What it owns |
|---|-------|--------------|
| 1 | `idea-intake` | The normalised brief |
| 2 | `requirements-analyst` | Requirements and acceptance criteria |
| 3 | `domain-modeler` | Entity, fields and actions |
| 4 | `architect` | Pinned build configuration |
| 5 | `ui-designer` | Screens, states, copy keys |
| 6 | `security-analyst` | Permissions, data at rest, secret policy |
| 7 | `feature-planner` | Features, tasks, execution waves |
| 8 | `project-scaffolder` | Gradle skeleton |
| 9 | `manifest-engineer` | `AndroidManifest.xml` |
| 10 | `data-engineer` | `*Store.kt` |
| 11 | `ui-engineer` | `MainActivity.kt` |
| 12 | `resource-engineer` | `strings.xml`, `colors.xml`, `themes.xml` |
| 13 | `brand-engineer` | Launcher icon at every density |
| 14 | `test-engineer` | JUnit tests for every planned action |
| 15 | `quality-auditor` | Validation report |
| 16 | `repo-publisher` | Push to GitHub |
| 17 | `build-verifier` | The Actions run, the APK, its checksum and icon |
| 18 | `release-publisher` | The public release and its asset |
| 19 | `failure-diagnostician` | Health checks and failure classification |
| 20 | `integration-supervisor` | Whole-fleet completion check |

Every generated file has exactly one owner (`scripts/agents/ownership.ts`).
Dependencies decide the waves; the scheduler also holds back agents whose owned
paths or exclusive resources overlap.

## Running it

```bash
# Everything that does not need GitHub: analysis, project, tests, validation.
node --experimental-strip-types scripts/coordinator.ts --pre-cloud "Plant watering journal"

# The whole fleet, including the push, the cloud build and the release.
node --experimental-strip-types scripts/coordinator.ts "Plant watering journal"

# What happened, what is proven, what is still missing.
node --experimental-strip-types scripts/coordinator.ts --status
node --experimental-strip-types scripts/coordinator.ts --runs

# Continue a stopped run without redoing verified work.
node --experimental-strip-types scripts/coordinator.ts --resume <runId>

# Ask GitHub to build an idea. The request is committed and pushed before the
# dispatch is sent, so a dispatch the platform drops leaves the idea on record.
node --experimental-strip-types scripts/requestRun.ts --idea "Plant watering journal"

# Send the request again, and see which requests are still owed a delivered app.
node --experimental-strip-types scripts/requestRun.ts --idea "Plant watering journal" --redrive
node --experimental-strip-types scripts/coordinator.ts --requests

# One agent on its own; refuses to run if its dependencies are missing.
node --experimental-strip-types scripts/worker.ts --agent brand-engineer --pre-cloud
```

Agents 16-20 need GitHub. `pre-cloud` stops before them on purpose rather than
reporting a build that never happened.

A new idea always starts from an empty state. A checkout of `main` carries the
live state and evidence of whatever ran last, so the CLI clears it first — with a
`before-restart` checkpoint and a logged abandonment — instead of letting a new
run inherit another app's proof.

## Cloud
- `builder-planner.yml` plans an idea and uploads the plan.
- `builder-coordinator.yml` runs the fleet, caches the run store and uploads it,
  so `--resume <runId>` continues instead of starting again.
- `builder-workers.yml` runs individual agents for a run, given a run id.
- `builder-android-build.yml` is the Gradle build that produces the APK. It is
  the only thing that may claim a build happened. It refuses to build a project
  that differs from the one committed for that idea, and one build per commit
  means a stuck run cannot block every other build.

### When the platform will not start a run
A `workflow_dispatch` can be accepted and then never handed a runner. That is
recorded as what it is rather than as a build failure:

- a run that ends with no step of any job having executed is classified
  `infrastructure_not_started`; it is retried with backoff and the state stays at
  `CLOUD_BUILDING`, so no repair pass is pointed at code that never ran;
- a queued run older than `BUILDER_STALE_QUEUED_MS` is abandoned and re-dispatched
  rather than watched until it times out;
- the dispatch that answers a retry must have been created after it was requested,
  so a previous attempt's run can never be adopted as this one's result.

Requests live in `.builder/requests/` and are pushed before the dispatch, so a lost
dispatch costs a retry and not the idea.

### Watchdog (no phone in the loop)
`builder-watchdog.yml` runs every twenty minutes and on demand. It reads the open
requests, the live state and the coordinator runs GitHub reports, then acts on
what nothing else is answering:

- an interrupted run with a store on disk is resumed (`--resume`), never
  restarted, and the request for it is not re-driven alongside it;
- a request that was never dispatched, or whose run the platform queued and
  forgot, is re-dispatched through `requestRun.ts --redrive`, bounded by a
  lifetime cap, a backoff floor, an age window and one dispatch per tick;
- a run that sat queued past `BUILDER_WATCHDOG_STALE_QUEUED_MS` (it holds the
  coordinator concurrency slot) or ran past `BUILDER_WATCHDOG_STALE_INPROGRESS_MS`
  is cancelled;
- a request whose idea already has a completed, fully-gated delivery is closed;
- a run that FAILED is left alone: rebuilding the same failure automatically is
  a loop, not a repair.

The rules live in `scripts/live/watchdogPlan.ts` as a pure function over
fixtures (`npm test` exercises them); `scripts/watchdog.ts` only gathers the
inputs, executes the plan and pushes what it changed.

### Notification email
`scripts/notifyEmail.ts` sends the mail the run owes: **COMPLETE** only when the
same gates that produce `COMPLETED` pass (full evidence chain, verified APK and
icon, created release, public HTTPS download fetched and matched), **FAILED** for
a failed run, **WAITING** otherwise. Each declaration is sent once — the
fingerprint is recorded in the live state, which is committed, so a resumed run
stays quiet. The coordinator runs it before publishing the state, and the
watchdog runs it for runs that died before they could.

Configuration is by repository secrets: `BUILDER_EMAIL_TO`, `BUILDER_SMTP_HOST`,
`BUILDER_SMTP_PORT` (587), `BUILDER_SMTP_FROM`, optional `BUILDER_SMTP_USER`,
`BUILDER_SMTP_PASS`, `BUILDER_SMTP_SECURITY` (`starttls` default, `implicit` or
`none`). Without them the step reports `status=not_configured` with the missing
names and the build stays green. Credentials are never printed or committed; the
recipient is stored masked.

## Layout
- Agents: `scripts/agents/` (specs in `agents/`, registry, planner, coordinator,
  recovery, ownership)
- Project generation: `scripts/project/emitters.ts`, `scripts/generateAndroidApp.ts`
- Live state and evidence: `scripts/live/`, `shared/state.ts`, `shared/liveProgress.ts`
- Run store: `.builder/agents/<runId>/` (manifest, ledger, per-agent artifacts)
- Tests: `npm test`, state gate: `npm run validate`, file check: `scripts/verify.ts`
