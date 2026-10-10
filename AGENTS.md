Start by reading:
- README.md

- When wrapping up Nix work, leave this checkout clean: commit all intended
  changes in logical commits.

## Git updates

- If Git commands run during normal work reveal that the Nix or sibling homelab
  checkout is behind its tracked upstream, fetch and bring that checkout up to
  date automatically. Do not run extra checks or fetches solely to look for updates.
- Prefer a fast-forward; rebase unpublished local commits if needed. Preserve
  uncommitted work and published history. If conflicts prevent a safe update,
  report the blocker without discarding local work.
