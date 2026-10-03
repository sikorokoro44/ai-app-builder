# Builder (Autonomous Cloud Builder)

Self-contained module under `/builder/`. All building is cloud-only (Gradle on GitHub Actions).

## Rules
- 20 worker agents (single config value: `builder/config/builder.json` → `agents.count`)
- No user interaction after idea submission
- All apps public (repo/releases). Every completed build produces public GitHub Releases asset URL reported on completion
- Coordinator merges passing branches into `main` one-at-a-time
- GitHub Issues = source of truth (labels per status)
- Visual-only live progress view (no text details displayed to user)

## Files
- Config: `config/builder.json`
- Scripts: `scripts/*`, `scripts/live/*`
- Shared: `shared/types.ts`, `shared/state.ts`, `shared/progress.ts`, `shared/stateWithProgressImpl2.ts`
- Workflows: `.github/workflows/builder-*.yml`
- Termux/OpenCode view: `opencode/live-view-visual.ts`, `opencode/visual-view.sh`
