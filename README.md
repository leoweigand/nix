# Leo's NixOS Infrastructure

Declarative NixOS configurations for homelab infrastructure with automated secret management via 1Password and Tailscale VPN.

## Overview

This repository contains NixOS configurations for:
- **riker**: Hetzner VPS for development and testing (temporary)
- **picard**: Production homelab server (will replace riker)
- **guinan**: Raspberry Pi reverse proxy gateway (separate project)

### Key Features

- **Flake-based configuration**: Reproducible builds with pinned dependencies
- **1Password integration**: Automated secret management using [opnix](https://github.com/brizzbuzz/opnix)
- **Tailscale VPN**: Automatic connection with SSH access via MagicDNS
- **Automated deployment**: Zero-touch server provisioning via cloud-init

## Quick Start: Two-Step Deployment

This section covers how to **deploy a server from scratch** using a simple two-step process.

### Prerequisites

Before creating a new server, ensure you have:

#### 1. SSH Key
- Your SSH public key (stored in `modules/common.nix`)
- The same key must be added to your Hetzner Cloud account

#### 2. 1Password Setup
- **Vault**: Create a vault named `Homelab` in 1Password
- **Service Account**: Create a 1Password Service Account:
  1. Go to 1Password → Settings → Developer → Service Accounts
  2. Create new Service Account with read access to `Homelab` vault
  3. Copy the service account token (starts with `ops_...`)
  4. **Save this token securely** - you'll need it for step 2
- **Tailscale Auth Key**: Store in 1Password:
  1. Generate a reusable auth key at https://login.tailscale.com/admin/settings/keys
  2. In 1Password `Homelab` vault, create item named `Tailscale`
  3. Add field `authKey` with the auth key value

#### 3. Repository
- Push this configuration to a Git repository
- Make sure the repository is publicly accessible

### Step 1: Create Server and Install NixOS

#### 1. Create Server in Hetzner Cloud Console

1. Go to Hetzner Cloud Console → Create Server
2. **Location**: Choose your preferred location
3. **Image**: Ubuntu 22.04 (will be converted to NixOS)
4. **Type**: Choose your server size (e.g., CPX11 for testing)
5. **SSH Keys**: Select your SSH key
6. **User Data**: Paste the simple cloud-config below

#### 2. Simple Cloud-Config

This minimal cloud-config just installs NixOS:

```yaml
#cloud-config

runcmd:
  - curl https://raw.githubusercontent.com/elitak/nixos-infect/master/nixos-infect | PROVIDER=hetznercloud NIX_CHANNEL=nixos-24.05 bash 2>&1 | tee /tmp/infect.log
```

#### 3. Wait for Installation

The server will:
1. Run nixos-infect (~2-3 minutes)
2. Automatically reboot into NixOS (~2 minutes)
3. Be ready for step 2

**Monitor progress** (optional):
```bash
# SSH during Ubuntu phase
ssh root@<server-ip>
tail -f /tmp/infect.log
```

### Step 2: Apply Configuration

After the server reboots into NixOS (~5 minutes after creation), run the setup script:

```bash
# SSH to the server
ssh root@<server-ip>

# Run setup script (replace with your token and hostname)
curl -sSL https://raw.githubusercontent.com/leoweigand/nix/main/setup.sh | \
  OPNIX_TOKEN=ops_YOUR_TOKEN_HERE \
  HOSTNAME=riker \
  nix-shell -p git --run "bash"
```

**What the setup script does:**
1. Creates `/etc/opnix-token` with your 1Password service account token
2. Clones your configuration repository to `/etc/nixos-config`
3. Runs `nixos-rebuild switch --flake .#HOSTNAME`
4. Configures Tailscale, opnix, and all services

**Timeline:** ~5-10 minutes for full deployment

### Verify Deployment

Once connected via Tailscale:

```bash
# Check services
systemctl status tailscale
systemctl status opnix-secrets

# Verify secrets were fetched
sudo ls -la /var/lib/opnix/secrets/

# Check that public SSH is blocked
# From another machine (not on Tailscale):
nc -zv <public-ip> 22  # Should timeout/be refused
```

### What Gets Configured

After running the setup script, the server will have:

✅ NixOS 24.05 (from nixos-infect)
✅ All system packages and dependencies
✅ User account (leo) with SSH keys and sudo access
✅ 1Password integration via opnix
✅ Tailscale VPN connected with MagicDNS
✅ Tailscale SSH enabled
✅ Public SSH port 22 closed (Tailscale-only access)
✅ Firewall configured (only Tailscale UDP port open)
✅ Automatic garbage collection enabled

**Total time**: ~10-15 minutes from server creation to full deployment (mostly waiting for reboots)

## Manual Deployment

If you prefer manual deployment or need to update an existing server:

### 1. Copy Configuration

```bash
# From your local machine
rsync -avz --delete /path/to/nix-config/ riker:/tmp/nix-config/ --exclude='.git' --exclude='*.img*' --exclude='*.gz' --exclude='*.log'
```

### 2. Set Up 1Password Token (First Time Only)

If this is the first deployment or the token file doesn't exist:

```bash
# SSH to the server
ssh riker

# Create the 1Password service account token file
echo "ops_YOUR_SERVICE_ACCOUNT_TOKEN" | sudo tee /etc/opnix-token > /dev/null
sudo chmod 600 /etc/opnix-token
sudo chown root:root /etc/opnix-token
```

### 3. Deploy Configuration

```bash
# Deploy using flakes
cd /tmp/nix-config
sudo nixos-rebuild switch --flake .#riker
```

### 4. Verify Services

```bash
# Check Tailscale connection
tailscale status

# Check opnix secrets service
systemctl status opnix-secrets

# Verify secrets were fetched
sudo ls -la /var/lib/opnix/secrets/

# Verify you can SSH via Tailscale
# From another machine on your Tailscale network:
ssh riker  # Uses Tailscale MagicDNS
```

## Repository Structure

```
.
├── flake.nix                    # Flake configuration with inputs and outputs
├── flake.lock                   # Locked flake dependencies
├── hosts/
│   └── riker/
│       └── configuration.nix    # Host-specific configuration
├── modules/
│   ├── common.nix              # Shared configuration (users, SSH, packages)
│   ├── tailscale.nix           # Tailscale VPN with auto-authentication
│   ├── secrets/
│   │   └── 1password.nix       # 1Password/opnix integration
│   └── services/
│       └── (future services)
└── README.md
```

## Secret Management

Secrets are managed using [opnix](https://github.com/brizzbuzz/opnix), which integrates 1Password with NixOS.

### How It Works

1. Secrets are stored in 1Password vaults
2. A Service Account token provides read-only access to specific vaults
3. At system activation, opnix fetches secrets and mounts them to a secure ramfs
4. Services reference secrets via the `services.onepassword-secrets.secrets` configuration

### Adding New Secrets

```nix
# In any module
services.onepassword-secrets.secrets.my-secret = {
  reference = "op://Homelab/my-item/my-field";
  owner = "myuser";
  services = [ "my-service" ];  # Services to restart when secret changes
};

# Access in systemd service
script = ''
  SECRET=$(cat ${config.services.onepassword-secrets.secretsPath}/my-secret)
'';
```

## Network Access

### Security Model
- **Public SSH**: DISABLED - port 22 is not accessible from the internet
- **Tailscale SSH**: ENABLED - all SSH access via Tailscale VPN only
- **Emergency access**: Hetzner Cloud Console provides VNC access if needed

### Accessing Services
- SSH: `ssh riker` (uses Tailscale MagicDNS)
- All services: Only accessible via Tailscale network
- No ports exposed publicly except Tailscale UDP (41641)

## Security Features

- **No password authentication**: SSH key-only access
- **Root login disabled**: Must use sudo
- **Passwordless sudo for wheel group**: Convenient for remote management
- **Firewall enabled**: Only necessary ports open
- **1Password Service Accounts**: Secrets never stored in Nix store
- **Tailscale SSH**: Integrated with Tailscale ACLs and MFA

## Updating Configuration

```bash
# Make changes locally
cd /path/to/nix-config
# Edit configuration files...

# Commit and push changes
git add .
git commit -m "Update configuration"
git push

# On the server, pull and apply changes
ssh riker
cd /etc/nixos-config
git pull
sudo nixos-rebuild switch --flake .#riker
```

## Troubleshooting

### Tailscale Not Connecting

```bash
# Check Tailscale service status
systemctl status tailscale
systemctl status tailscale-autoconnect

# Check logs
journalctl -u tailscale-autoconnect -n 50

# Check if secret was fetched
sudo cat /var/lib/opnix/secrets/tailscaleAuthkey

# Manually authenticate (for testing)
sudo tailscale up --authkey="YOUR_AUTH_KEY" --hostname="riker" --ssh
```

### opnix Secrets Not Loading

```bash
# Verify token file exists and has correct permissions
ls -la /etc/opnix-token
# Should be: -rw------- 1 root root (or root:onepassword-secrets)

# Check opnix service status
systemctl status opnix-secrets

# Check opnix service logs
journalctl -u opnix-secrets -n 50

# Manually restart opnix service
sudo systemctl restart opnix-secrets

# Verify secrets directory
sudo ls -la /var/lib/opnix/secrets/
```

### Public SSH Still Accessible

If port 22 is still open publicly after deployment:

```bash
# Check if openssh has openFirewall disabled
grep -r "openFirewall" /tmp/nix-config/modules/

# Verify firewall rules
sudo iptables -L nixos-fw -n -v | grep "dpt:22"

# Redeploy to ensure firewall changes are applied
cd /tmp/nix-config && sudo nixos-rebuild switch --flake .#riker
```

### Cloud-Config Deployment Failed

```bash
# SSH to server using public IP (if still accessible)
ssh root@<server-ip>

# Check nixos-infect log
cat /tmp/infect.log

# Check nixos-rebuild log
cat /tmp/nixos-deploy.log

# Manually retry deployment
cd /tmp/nix-config
sudo nixos-rebuild switch --flake .#riker
```

## Future Plans

- [ ] Deploy paperless-ngx for document management
- [ ] Set up Backblaze B2 backups with restic
- [ ] Deploy picard (Raspberry Pi) with similar configuration
- [ ] Add monitoring and alerting
- [ ] Implement automated testing of configurations

## License

Personal configuration - use at your own risk.
