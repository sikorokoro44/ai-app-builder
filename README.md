# AI App Builder

Autonomous cloud builder creating real Android apps from plain-text ideas.

## Key Principles
- Public only: all apps and releases are public
- Cloud-only builds via GitHub Actions (Gradle)
- 20 worker agents, single config value (builder/config/builder.json)
- Truthful live progress (visual-only to user): overall + current stage, 0-100%, never simulated
- Real artifacts only: public GitHub release URLs, verified before marking DOWNLOAD_READY/COMPLETED

## Flow
IDEA → ANALYZE → DESIGN → PLAN → BUILDING → TESTING → CLOUD_BUILDING → VERIFYING → RELEASING → DOWNLOAD_READY → COMPLETED

## Usage
Submit idea via GitHub Actions workflow (planner), workers build in parallel, coordinator merges on green. Monitor visual progress.
# sync
