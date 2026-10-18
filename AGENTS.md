## Git workflow

- Before starting work, preserve any existing local changes, fetch `origin`, and
  fast-forward local `main` to `origin/main` with `git merge --ff-only origin/main`.
  If local `main` has diverged, preserve its commits and resolve the divergence
  before proceeding; never reset away local work.
- Create a temporary branch from that updated `main` and commit work in logical
  commits. Use a unique branch name for each task to avoid clashes across machines.
- Before merging, fetch `origin` again and incorporate the latest `origin/main`
  into the temporary branch. Resolve any conflicts there and run the relevant
  checks against the combined changes.
- Fast-forward local `main` to the completed temporary branch and push `main`
  immediately. If the push is rejected because another machine has pushed first,
  fetch again, incorporate the new `origin/main` on the temporary branch, resolve
  conflicts, repeat the relevant checks, and retry. Never force-push `main` or
  rewrite published history.
- After confirming the push succeeded, delete the temporary branch locally and
  on the remote if it was published. Leave the checkout clean and on `main`, with
  all intended changes committed. Do not leave completed work on temporary
  branches unless explicitly requested.
