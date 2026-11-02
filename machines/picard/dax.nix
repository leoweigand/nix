{ config, pkgs, ... }:

let
  domain = "elephant.leolab.party";
  certificateDirectory = "/var/lib/acme/${domain}";
in
{
  # Dax pulls only its own certificate; the Cloudflare API token stays on Picard.
  security.acme.certs.${domain} = {
    inherit domain;
    extraDomainNames = [ "*.${domain}" ];
    dnsProvider = "cloudflare";
    dnsPropagationCheck = true;
    dnsResolver = "1.1.1.1:53";
    credentialFiles.CF_DNS_API_TOKEN_FILE =
      config.services.onepassword-secrets.secretPaths.cloudflareAcmeToken;
    group = "dax-cert";
  };
  systemd.services."acme-${domain}" = {
    after = [ "opnix-secrets.service" ];
    requires = [ "opnix-secrets.service" ];
  };
  users.groups.dax-cert = { };
  users.users.dax-cert = {
    isSystemUser = true;
    group = "dax-cert";
    shell = pkgs.bash;
    openssh.authorizedKeys.keys = [
      ''restrict,from="192.168.2.6",command="${pkgs.gnutar}/bin/tar -C ${certificateDirectory} -cf - fullchain.pem key.pem" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIC4Jxyh4cvHMAHuIVZptmYYi53/TB3kpnuD++ljHj/6X dax-certificate-pull''
    ];
  };
}
