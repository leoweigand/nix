{ config, lib, pkgs, ... }:

let
  cfg = config.lab.edgeDns;
  zone = config.lab.baseDomain;

  mkServerBlock = listenAddress: answerAddress: ''
    ${zone}:53 {
      bind ${listenAddress}
      template IN A {
        match (^|.*\.)${lib.escapeRegex zone}\.$
        answer "{{ .Name }} 60 IN A ${answerAddress}"
      }
      template IN AAAA {
        match (^|.*\.)${lib.escapeRegex zone}\.$
        rcode NXDOMAIN
      }
      log
      errors
    }
  '';
in

{
  options.lab.edgeDns = {
    enable = lib.mkEnableOption "Authoritative split DNS for the edge domain";

    lanListenAddress = lib.mkOption {
      type = lib.types.str;
      description = "IP address on picard where DNS listens for LAN clients";
      example = "192.168.1.10";
    };

    lanAnswerAddress = lib.mkOption {
      type = lib.types.str;
      description = "A record returned to LAN clients";
      example = "192.168.1.10";
    };

    tailnetListenAddress = lib.mkOption {
      type = lib.types.str;
      description = "IP address on picard where DNS listens for tailnet clients";
      example = "100.64.0.12";
    };

    tailnetAnswerAddress = lib.mkOption {
      type = lib.types.str;
      description = "A record returned to tailnet clients";
      example = "100.64.0.12";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = zone != "";
        message = "lab.baseDomain must be set when lab.edgeDns.enable = true";
      }
    ];

    environment.etc."edge-dns/Corefile".text =
      mkServerBlock cfg.lanListenAddress cfg.lanAnswerAddress
      + "\n"
      + mkServerBlock cfg.tailnetListenAddress cfg.tailnetAnswerAddress;

    systemd.services.edge-dns = {
      description = "CoreDNS authoritative server for split DNS";
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      wantedBy = [ "multi-user.target" ];
      serviceConfig = {
        DynamicUser = true;
        ExecStart = "${pkgs.coredns}/bin/coredns -conf /etc/edge-dns/Corefile";
        Restart = "on-failure";
        RestartSec = "5s";
        AmbientCapabilities = [ "CAP_NET_BIND_SERVICE" ];
        CapabilityBoundingSet = [ "CAP_NET_BIND_SERVICE" ];
        NoNewPrivileges = true;
      };
    };

    networking.firewall.allowedTCPPorts = [ 53 ];
    networking.firewall.allowedUDPPorts = [ 53 ];
  };
}
