# Picard Setup

NixOS VM on Unraid as the service layer for the homelab.

## Context

Migrating from manually-configured Unraid Docker containers to declarative NixOS services. The strategy: **Unraid handles storage** (array, parity, SMB shares), **NixOS handles compute** (services, databases, application logic).

This gives us reproducible infrastructure while keeping Unraid's storage management strengths. Services run in the VM, user-facing directories (like Paperless consume folder) are exposed via Unraid's existing SMB.

## Done

- [x] NixOS configuration (`machines/picard/`)
- [x] UEFI boot with virtio drivers
- [x] Two-tier storage: fast (VM-local) + normal (NFS from Unraid)
- [x] Paperless, backup, Tailscale modules wired up
- [x] Flake entry added

## TODO

### Unraid Setup
1. Create NFS share at `/mnt/user/nixos-data`
2. Create VM: UEFI, virtio, bridge networking
3. Add two vdisks: primary (OS), secondary (fast storage)

### NixOS Install
4. Boot NixOS ISO, partition disks (vda1=EFI, vda2=root, vdb1=fast)
5. Update `filesystems.nix` with correct Unraid IP (currently `192.168.1.10`)
6. `nixos-install --flake github:youruser/nix#picard`

### Post-Install
7. Set up 1Password token at `/etc/opnix-token`
8. Join Tailscale network
9. Verify mounts: `/mnt/fast` (local), `/mnt/normal` (NFS)
10. Test Paperless and backup jobs

## Storage Layout

```
/mnt/fast    → /dev/vdb1 (VM vdisk, appdata/databases)
/mnt/normal  → NFS from Unraid (media, documents, Paperless consume)
```
