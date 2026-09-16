# Audit picard for configuration drift

## Problem

Picard has run configuration that was never committed. Generation 150 contained a
`podman-linkding.service`, a `bookmarks.leolab.party` vhost and a TinyAuth image
pointing at `ghcr.io/tinyauthapp`, none of which existed in git —
`git log --all -S linkding` returns nothing on any branch. It was deployed from a
working tree whose changes were later discarded.

The deploy script builds from the working tree, not from `HEAD`, so uncommitted work
reaches picard and survives only as long as the generation that carries it. Linkding
and the TinyAuth image path have been recovered and committed, but they were only
found because they broke. Anything else lost the same way is still invisible.

## Work

- [ ] Diff generation 150's `/etc/systemd/system` against the current generation and
      account for every unit that exists in one but not the other
- [ ] Diff generation 150's Caddy config vhost list against the current one
- [ ] Compare the opnix declarative secrets JSON between generations; an orphaned
      secret is a strong signal of a service that was dropped
- [ ] Commit or deliberately discard anything found

Generation 150 is the last one predating the recovery. Pin it against garbage
collection until the audit is finished:

```bash
sudo nix-env -p /nix/var/nix/profiles/system --list-generations
ls -l /nix/var/nix/profiles/system-150-link
```

## Prevention

Options worth weighing:

- Deploy from a committed revision (`--flake git+file://...`) so an uncommitted tree
  cannot reach the machine
- Keep the working-tree behaviour but have the deploy script refuse a dirty tree
  unless explicitly overridden
- Pull-based GitOps, which removes the question entirely — see
  `plans/picard-pull-based-gitops-deploy.md`
