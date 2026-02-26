# Picard VM Setup Plan (Unraid)

This plan is for bringing up `picard` as a NixOS VM on Unraid with a safe bootstrap path, then hardening disk/device stability after first boot.

## 1) Preflight in this repo

1. Confirm the target build evaluates:
   - `nix --extra-experimental-features 'nix-command flakes' eval .#nixosConfigurations.picard.config.system.build.toplevel.drvPath`
2. Build an installer ISO from your preferred NixOS channel if you have not already.
3. Keep current storage settings as-is (`/var/lib/picard` temporary fast/normal tiers).

## 2) Create VM in Unraid

1. Create a new VM using OVMF (UEFI).
2. Set machine/chipset to a modern Q35-style profile.
3. Attach the primary OS disk as VirtIO (so it appears as `/dev/vda` during install).
4. Attach network as VirtIO.
5. Mount the NixOS installer ISO.
6. Give the VM a fixed MAC and DHCP reservation (or static lease in your router/Unraid DNS setup).

## 3) Install with current disko layout

1. Boot installer and clone this repo.
2. Run disko for picard:
   - `sudo nix --extra-experimental-features 'nix-command flakes' run github:nix-community/disko -- --mode disko ./machines/picard/disko.nix`
3. Install the system:
   - `sudo nixos-install --flake .#picard`
4. Reboot into installed system.

## 4) Bootstrap access and identity

1. Verify LAN SSH access works with your key (port 22 now allowed in firewall).
2. Verify Tailscale service starts and joins the tailnet.
3. Verify opnix retrieves secrets and dependent services wait for it:
   - `systemctl status opnix-secrets.service`
4. Verify core service health:
   - `systemctl status tailscaled`
   - `systemctl status paperless-scheduler`
   - `systemctl list-timers | grep restic`

## 5) Stabilize disk naming (by-id) after first boot

Why: `/dev/vda` works, but `/dev/disk/by-id/*` is more stable if device order changes.

1. In Unraid VM settings, assign a fixed disk serial for the OS disk.
2. In VM, inspect stable device links:
   - `ls -l /dev/disk/by-id`
3. Identify the VirtIO disk symlink that points to your OS disk (the one resolving to `../../vda`).
4. Update `machines/picard/disko.nix`:
   - Replace `device = "/dev/vda";`
   - With `device = "/dev/disk/by-id/<your-stable-id>";`
5. Commit the change so future rebuilds/install docs use stable naming.

## 6) Post-install validation

1. Confirm firewall behavior:
   - SSH reachable on LAN.
   - Service ports still not broadly exposed.
2. Confirm paperless paths resolve under temporary storage root:
   - `/var/lib/picard/appdata`
   - `/var/lib/picard/data`
3. Trigger and inspect backup jobs manually once:
   - `sudo systemctl start restic-backups-appdata-s3.service`
   - `sudo systemctl status restic-backups-appdata-s3.service`

## 7) Follow-up hardening after stable operation

1. Add and commit `flake.lock` to pin dependency revisions.
2. When ready, migrate fast/normal tiers to second vdisk + NFS and update `machines/picard/filesystems.nix`.
3. Re-run validation after storage migration (permissions, service startup, backup paths).
