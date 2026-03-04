# Home Assistant workflow improvements

Goal: make Home Assistant config management predictable from the host and add a repeatable update workflow for HA releases.

## Plan

1. Move Home Assistant `/config` on `picard` to `/mnt/fast/homeassistant/config` via `lab.services.homeassistant.configDir`.
2. Run a one-time migration during rollout so current Home Assistant state is moved to the new path without changing ownership/mode unexpectedly.
3. Verify host accessibility and permissions for that path so edits/backups can be done outside the container.
4. Add an agent skill for Home Assistant updates so version bumps, rebuild/apply, and post-update checks follow one consistent flow.

## Done when

- Home Assistant `/config` is mounted from `/mnt/fast/homeassistant/config` on `picard`.
- Existing data is migrated safely as part of rollout.
- The update skill exists under `.agents/skills/` with clear usage instructions and verification steps.
