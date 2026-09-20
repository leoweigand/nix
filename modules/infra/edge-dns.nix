{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.homelab.infra.edgeDns;
  edge = config.homelab.infra.edge;
  zone = config.homelab.baseDomain;

  proxyNames = builtins.attrNames edge.proxies;
  edgeRecordNames =
    proxyNames
    ++ lib.optional (edge.rootProxy != null) "@"
    ++ lib.optional (edge.webhookRoutes != [ ]) "webhooks";

  ensureAbsoluteName = value: if lib.hasSuffix "." value then value else "${value}.";

  mkExtraRecord =
    view: name: record:
    let
      value =
        if view == "tailnet" && record.tailnetValue != null then record.tailnetValue else record.value;
      renderedValue = if record.type == "CNAME" then ensureAbsoluteName value else value;
    in
    "${name} ${toString cfg.ttl} IN ${record.type} ${renderedValue}";

  mkZone =
    view: listenAddress: answerAddress:
    let
      edgeRecords = map (name: "${name} ${toString cfg.ttl} IN A ${answerAddress}") edgeRecordNames;
      extraRecords = lib.mapAttrsToList (mkExtraRecord view) cfg.extraRecords;
    in
    ''
      $ORIGIN ${zone}.
      @ ${toString cfg.ttl} IN SOA ns1.${zone}. hostmaster.${zone}. (
        ${toString cfg.serial} ; serial
        300 ; refresh
        60 ; retry
        604800 ; expire
        ${toString cfg.ttl} ; negative cache TTL
      )
      @ ${toString cfg.ttl} IN NS ns1.${zone}.
      ns1 ${toString cfg.ttl} IN A ${listenAddress}
      ${lib.concatStringsSep "\n" edgeRecords}
      ${lib.concatStringsSep "\n" extraRecords}
    '';

  mkTransferBlock =
    addresses:
    lib.optionalString (addresses != [ ]) ''
      transfer ${zone} {
        to ${lib.concatStringsSep " " addresses}
      }
    '';

  lanZone = mkZone "lan" cfg.lanListenAddress cfg.lanAnswerAddress;
  tailnetZone = mkZone "tailnet" cfg.tailnetListenAddress cfg.tailnetAnswerAddress;

  corefile = ''
    .:53 {
      bind ${cfg.lanListenAddress}
      file /etc/edge-dns/lan.zone ${zone}
      ${mkTransferBlock cfg.lanSecondaries}
      forward . ${lib.concatStringsSep " " cfg.upstreamResolvers}
      cache 300
      log
      errors
    }

    ${zone}:53 {
      bind ${cfg.tailnetListenAddress}
      file /etc/edge-dns/tailnet.zone ${zone}
      ${mkTransferBlock cfg.tailnetSecondaries}
      log
      errors
    }
  '';
in

{
  options.homelab.infra.edgeDns = {
    enable = lib.mkEnableOption "authoritative split DNS for the edge domain";

    serial = lib.mkOption {
      type = lib.types.int;
      description = "SOA serial; increment whenever the generated DNS records change";
      example = 2026092001;
    };

    ttl = lib.mkOption {
      type = lib.types.ints.positive;
      default = 60;
      description = "TTL in seconds for records in the generated zones";
    };

    lanListenAddress = lib.mkOption {
      type = lib.types.str;
      description = "IP address where DNS listens for LAN clients";
      example = "192.168.1.10";
    };

    lanAnswerAddress = lib.mkOption {
      type = lib.types.str;
      description = "A record returned for reverse-proxied services on the LAN";
      example = "192.168.1.10";
    };

    lanSecondaries = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = "LAN addresses allowed to transfer the LAN view";
      example = [ "192.168.1.11" ];
    };

    tailnetListenAddress = lib.mkOption {
      type = lib.types.str;
      description = "IP address where DNS listens for tailnet clients";
      example = "100.64.0.12";
    };

    tailnetAnswerAddress = lib.mkOption {
      type = lib.types.str;
      description = "A record returned for reverse-proxied services on the tailnet";
      example = "100.64.0.12";
    };

    tailnetSecondaries = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = "Tailnet addresses allowed to transfer the tailnet view";
      example = [ "100.64.0.13" ];
    };

    extraRecords = lib.mkOption {
      default = { };
      description = "Explicit records that do not correspond to a reverse-proxy virtual host";
      type = lib.types.attrsOf (
        lib.types.submodule {
          options = {
            type = lib.mkOption {
              type = lib.types.enum [
                "A"
                "CNAME"
              ];
              description = "DNS record type";
            };

            value = lib.mkOption {
              type = lib.types.str;
              description = "LAN record value, or the value for both views when tailnetValue is unset";
            };

            tailnetValue = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              description = "Optional value used only in the tailnet view";
            };
          };
        }
      );
    };

    upstreamResolvers = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [
        "1.1.1.1"
        "1.0.0.1"
      ];
      description = "Recursive upstream resolvers used for non-local DNS lookups";
      example = [
        "9.9.9.9"
        "1.1.1.1"
      ];
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = zone != "";
        message = "homelab.baseDomain must be set when homelab.infra.edgeDns.enable = true";
      }
      {
        assertion = cfg.serial > 0 && cfg.serial <= 4294967295;
        message = "homelab.infra.edgeDns.serial must be a valid positive 32-bit SOA serial";
      }
      {
        assertion = lib.intersectLists edgeRecordNames (builtins.attrNames cfg.extraRecords) == [ ];
        message = "homelab.infra.edgeDns.extraRecords must not duplicate reverse-proxy DNS names";
      }
      {
        assertion = !(builtins.elem "ns1" edgeRecordNames) && !(cfg.extraRecords ? ns1);
        message = "ns1 is reserved for the generated authoritative nameserver record";
      }
      {
        assertion = lib.all (record: record.type != "CNAME" || record.tailnetValue == null) (
          builtins.attrValues cfg.extraRecords
        );
        message = "CNAME extra records use the same value in both views and cannot set tailnetValue";
      }
    ];

    environment.etc = {
      "edge-dns/Corefile".text = corefile;
      "edge-dns/lan.zone".text = lanZone;
      "edge-dns/tailnet.zone".text = tailnetZone;
    };

    systemd.services.edge-dns = {
      description = "CoreDNS authoritative server for split DNS";
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      wantedBy = [ "multi-user.target" ];
      restartTriggers = [
        config.environment.etc."edge-dns/Corefile".source
        config.environment.etc."edge-dns/lan.zone".source
        config.environment.etc."edge-dns/tailnet.zone".source
      ];
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
