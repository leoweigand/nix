# Home Assistant workflow improvements

Goal: make Home Assistant config management predictable from the host and add a repeatable update workflow for HA releases.

## Plan

1. Confirm `/config` is bind-mounted from a host path (`lab.services.homeassistant.configDir`) and document the effective location on `picard`.
2. Verify host accessibility and permissions for that path so edits/backups can be done outside the container.
3. Add an agent skill for Home Assistant updates so version bumps, rebuild/apply, and post-update checks follow one consistent flow.

## Done when

- We can point to the exact host directory used as HA `/config`.
- The update skill exists under `.agents/skills/` with clear usage instructions and verification steps.
