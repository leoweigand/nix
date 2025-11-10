# NixOS Raspberry Pi Installation Guide

## Prerequisites
- Raspberry Pi (3, 4, or 5)
- MicroSD card (minimum 8GB, 16GB+ recommended)
- Network connection (Ethernet recommended for initial setup)
- Another computer to prepare the SD card
- Your SSH public key (already configured in initial-configuration.nix)

## Step 1: Download NixOS ARM Image

Choose one of these Hydra builds:

**Recommended - Stable (24.11):**
https://hydra.nixos.org/job/nixos/release-24.11/nixos.sd_image.aarch64-linux

**Alternative - Unstable (Latest):**
https://hydra.nixos.org/job/nixos/trunk-combined/nixos.sd_image.aarch64-linux

1. Click the link
2. Click on the latest successful build (green checkmark)
3. Under "Build products", download the `.img.zst` file

## Step 2: Flash the Image to SD Card

The SD card should already be unmounted. Flash the image:

```bash
# Decompress and write in one command
nix-shell -p zstd --run "zstdcat /path/to/nixos-sd-image-*.img.zst | sudo dd of=/dev/rdisk4 bs=4m status=progress"
```

**Note:** Using `/dev/rdisk4` (raw disk) is faster than `/dev/disk4`

## Step 3: Configure for Headless Boot

After flashing, the SD card will have two partitions. We need to add our configuration BEFORE first boot.

```bash
# Mount the root partition
diskutil list  # Verify the disk number
diskutil mount /dev/disk4s2  # Mount the Linux partition

# Copy our initial configuration
sudo cp initial-configuration.nix /Volumes/NIXOS_SD/etc/nixos/configuration.nix

# Unmount when done
diskutil unmount /dev/disk4s2
```

## Step 4: First Boot

1. Insert the SD card into your Raspberry Pi
2. Connect Ethernet cable (highly recommended for first boot)
3. Power on the Pi

## Step 5: Connect via SSH

The Pi should be discoverable via mDNS:

```bash
# Try mDNS hostname first (hostname: guinan)
ssh leo@guinan.local

# If that doesn't work, find the IP:
# Option 1: Check your router's DHCP leases
# Option 2: Scan your network
nmap -sn 192.168.1.0/24  # Adjust to your subnet

# Then connect with IP
ssh leo@192.168.1.XXX
```

## Step 6: Verify and Generate Hardware Config

Once connected:

```bash
# Generate hardware configuration
sudo nixos-generate-config

# Review the generated hardware-configuration.nix
sudo vim /etc/nixos/hardware-configuration.nix

# Apply the configuration
sudo nixos-rebuild switch
```

## Step 7: Test Configuration Updates

Test that you can apply configuration changes remotely:

```bash
# On your Mac, edit the configuration
# Then copy it to the Pi
scp initial-configuration.nix leo@guinan.local:/tmp/

# On the Pi, apply it
ssh leo@guinan.local
sudo cp /tmp/initial-configuration.nix /etc/nixos/configuration.nix
sudo nixos-rebuild switch
```

## Troubleshooting

### Can't connect via SSH

1. **Check if Pi is powered on:** LED should be blinking
2. **Verify network connection:**
   - Ethernet: Link light should be on
   - WiFi: You'll need to configure this via serial console or pre-configure it
3. **Serial console access:** Connect USB-TTL adapter to GPIO pins (RX/TX) at 115200 baud
4. **Check router:** Look for new DHCP leases

### Wrong architecture errors

Make sure you downloaded the **aarch64** image, not armv7l.

### Can't write to SD card

```bash
# Verify the correct disk
diskutil list

# Force unmount if needed
diskutil unmountDisk force /dev/disk4
```

## Next Steps

Once you have SSH working and can apply configurations:
- ✅ Move to Milestone 3: Set up Tailscale for remote access
- ✅ Configure Caddy reverse proxy
- ✅ Deploy Home Assistant

## Important Notes

- **Backup:** You already have a backup of the original SD card
- **Password:** The configuration has password authentication disabled. SSH keys only!
- **Sudo:** Currently configured to not require password. Change `security.sudo.wheelNeedsPassword` to `true` for more security
- **Timezone:** Adjust `time.timeZone` in configuration.nix to your location
