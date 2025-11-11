# Leo's NixOS Infrastructure

NixOS config for my homelab infrastructure.

## Key Features

- Remote access and SSH authentication through Tailscale
- Secret management using 1Password with [opnix](https://github.com/brizzbuzz/opnix)
- Flake-based configuration: reproducible builds with pinned dependencies
- Automated provisioning via cloud-init and Tailscale auth keys

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

## Installation Runbook

This section covers how to **deploy a server from scratch** using a simple two-step process.

### Step 1: Install NixOS (nixos-infect)

This minimal cloud-config will run [nixos-infect](https://github.com/elitak/nixos-infect) and automatically reboot into NixOS.

```yaml
#cloud-config

runcmd:
  - curl https://raw.githubusercontent.com/elitak/nixos-infect/master/nixos-infect | PROVIDER=hetznercloud NIX_CHANNEL=nixos-24.05 bash 2>&1 | tee /tmp/infect.log
```

> [!Warning]
> Note for Hetzner: doesn't work with Debian newer than 11 at the time of writing.


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

Once connected via Tailscale, you can check the status:

```bash
# Check that public SSH is blocked
# From another machine (not on Tailscale):
nc -zv <public-ip> 22  # Should timeout/be refused

# Connect via Tailscale MagicDNS
ssh <hostname>
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

## Security Model
- **No password authentication**: SSH key-only access
- **Public SSH**: DISABLED - port 22 is not accessible from the internet
- **Tailscale SSH**: ENABLED - all SSH access via Tailscale only
- **Root login disabled**: Must use sudo
- **Firewall enabled**: No ports exposed publicly except Tailscale UDP (41641)
- **1Password Service Accounts**: Secrets never stored in Nix store
- **Emergency access**: Hetzner Cloud Console provides VNC access if needed

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
ssh <hostname>
cd /etc/nixos-config
git pull
sudo nixos-rebuild switch --flake .#<hostname>
```

## Troubleshooting

```bash
# SSH to server using public IP (if still accessible)
ssh root@<server-ip>

# Check nixos-infect log
cat /tmp/infect.log

# Check nixos-rebuild log
cat /tmp/nixos-deploy.log

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
