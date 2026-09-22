{ config, lib, pkgs, ... }:

let
  dax = "192.168.2.135";
  backupDir = "${config.homelab.mounts.fast}/appdata/hermes-dax";
in
{
  # Hermes runs on Ubuntu/Dax; Picard retains the authenticated edge and backups.
  homelab.infra.edge.proxies.hermes = {
    upstream = "http://${dax}:9119";
    auth = true;
    headerUp = {
      Host = "127.0.0.1:9119";
      Origin = "https://127.0.0.1:9119";
    };
  };

  homelab.infra.homepage.infrastructureEntries.hermes = {
    category = "Productivity";
    name = "Hermes";
    href = "https://hermes.${config.homelab.baseDomain}";
    icon = "mdi-robot-outline";
    description = "AI assistant on Dax";
  };

  # Only expose Home Assistant to Dax, not all virtual hosts on the normal edge.
  services.caddy.virtualHosts."https://home.${config.homelab.baseDomain}:8444" = {
    useACMEHost = config.homelab.baseDomain;
    extraConfig = ''
      bind 192.168.2.4
      @dax remote_ip ${dax}
      handle @dax {
        reverse_proxy ${config.homelab.infra.edge.proxies.home.upstream}
      }
      handle {
        respond 403
      }
    '';
  };
  networking.firewall.extraCommands = ''
    iptables -A nixos-fw -s ${dax} -p tcp --dport 8444 -j nixos-fw-accept
  '';

  systemd.tmpfiles.rules = [
    "d ${backupDir} 0700 root root - -"
    "d /var/lib/hermes-dax-backup 0700 root root - -"
  ];

  # Picard holds the private key; Dax only has a forced-command public key.
  # A failed export aborts the backup rather than silently archiving stale state.
  homelab.infra.backup.jobs.appdata.prepareCommand = lib.mkAfter ''
    ${pkgs.openssh}/bin/ssh -T \
      -i /var/lib/hermes-dax-backup/id_ed25519 \
      -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \
      -o UserKnownHostsFile=/var/lib/hermes-dax-backup/known_hosts \
      -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
      hermes-backup@${dax} > ${backupDir}/state.tar.gz.partial
    ${pkgs.gzip}/bin/gzip -t ${backupDir}/state.tar.gz.partial
    ${pkgs.coreutils}/bin/mv ${backupDir}/state.tar.gz.partial ${backupDir}/state.tar.gz
  '';
}
