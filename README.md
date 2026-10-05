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

# One agent on its own; refuses to run if its dependencies are missing.
node --experimental-strip-types scripts/worker.ts --agent brand-engineer --pre-cloud
```

Agents 16-20 need GitHub. `pre-cloud` stops before them on purpose rather than
reporting a build that never happened.

## Cloud
- `builder-planner.yml` plans an idea and uploads the plan.
- `builder-coordinator.yml` runs the fleet, caches the run store and uploads it,
  so `--resume <runId>` continues instead of starting again.
- `builder-workers.yml` runs individual agents for a run, given a run id.
- `builder-android-build.yml` is the Gradle build that produces the APK. It is
  the only thing that may claim a build happened.

## Layout
- Agents: `scripts/agents/` (specs in `agents/`, registry, planner, coordinator,
  recovery, ownership)
- Project generation: `scripts/project/emitters.ts`, `scripts/generateAndroidApp.ts`
- Live state and evidence: `scripts/live/`, `shared/state.ts`, `shared/liveProgress.ts`
- Run store: `.builder/agents/<runId>/` (manifest, ledger, per-agent artifacts)
- Tests: `npm test`, state gate: `npm run validate`, file check: `scripts/verify.ts`
