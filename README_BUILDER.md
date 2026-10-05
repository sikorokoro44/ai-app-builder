# Builder (Autonomous Cloud Builder)

This repository is the builder module. All building is cloud-only: Gradle runs on
GitHub Actions, and a build is only ever reported through the evidence chain in
`shared/state.ts` together with `scripts/live/evidenceChain.ts`.

## Rules
- Twenty agents, defined once in `scripts/agents/agentIds.ts`. Each has a
  contract, owned files, a failure policy and a lifecycle transition.
- No user interaction after the idea is submitted.
- All apps public. A completed build produces a public GitHub release asset URL,
  and that URL is reported only after the asset has been downloaded and verified.
- The coordinator is the scheduler of record; it is the only thing that decides
  when an agent may run.
- A new idea starts from an empty state. Inheriting the previous run's evidence
  would report one app's proof as another's.
- A run that the platform never started is an infrastructure fault, not a code
  fault: no repair pass is opened against code that never ran.
- Progress is derived from recorded evidence, never simulated. The live view
  (`shared/liveProgress.ts`, `GET /live/progress`) is a read-only projection of the
  authoritative state.

## Files
- Config: `config/builder.json`
- Agents and fleet: `scripts/agents/`
- Project emitters: `scripts/project/emitters.ts`, `scripts/generateAndroidApp.ts`
- Scripts: `scripts/*`, `scripts/live/*`
- Run requests: `scripts/requestRun.ts`, `scripts/live/runRequests.ts`,
  `.builder/requests/`
- Shared: `shared/types.ts`, `shared/state.ts`, `shared/agentTypes.ts`,
  `shared/liveProgress.ts`, `shared/progress.ts`, `shared/stateWithProgressImpl.ts`
- Workflows: `.github/workflows/builder-*.yml`
- Termux/OpenCode view: `opencode/live-view-visual.ts`, `opencode/live-progress.ts`,
  `opencode/visual-view.sh`

See `README.md` for the fleet, the flow and the commands.
