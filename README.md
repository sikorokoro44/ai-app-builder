# Builder (Autonomous Cloud Builder)

Self-contained module for the Autonomous Cloud Builder system. Everything under `/builder/`.

## Purpose
- Takes a plain-text idea, breaks into features, builds them in parallel on GitHub Actions (Gradle only).
- 20 worker agents, single config value (`builder/config/builder.json` → `agents.count`).
- Status tracked in GitHub Issues. Coordinator merges passing feature branches into `main` one-at-a-time.
- Zero user interaction after submission.
- All apps must be public (repo/releases). Every completed build produces a public GitHub Releases asset URL, automatically reported on the status board.

## Structure
- `config/builder.json` — single source of truth for agent count, labels, visibility, releases
- `actions/` — reusable composite actions/workflow templates
- `scripts/` — Node/TS scripts (planner, worker, coordinator, status, release)
- `gradle/` — minimal Gradle config for cloud builds
- `.github/workflows/` (added) — planner, workers (20), coordinator
- `opencode/` — Termux/OpenCode polling UI/view
