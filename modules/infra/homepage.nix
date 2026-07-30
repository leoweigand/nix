{ config, lib, ... }:

let
  cfg = config.homelab.infra.homepage;
  domain = config.homelab.baseDomain;
  edge = config.homelab.infra.edge;
  tinyauth = config.homelab.infra.tinyauth;

  enabledApps = lib.filterAttrs (
    _: app: (app.enable or false) && (app.homepage.enable or false)
  ) config.homelab.apps;

  appEntries = lib.mapAttrsToList (
    appId: app:
    let
      metadata = app.homepage;
      proxy =
        if app ? subdomain && builtins.hasAttr app.subdomain edge.proxies then
          edge.proxies.${app.subdomain}
        else
          null;
      href =
        if metadata.href != null then
          metadata.href
        else if app ? subdomain then
          "https://${app.subdomain}.${domain}"
        else
          throw "homelab.apps.${appId}.homepage.href must be set because the app has no subdomain";
      name = if metadata.name == "" then appId else metadata.name;
      siteMonitor =
        if metadata.siteMonitor == false then
          null
        else if builtins.isString metadata.siteMonitor then
          metadata.siteMonitor
        else if proxy != null then
          proxy.upstream
        else
          null;
    in
    {
      category = metadata.category;
      service = {
        "${name}" = {
          inherit href;
          icon = metadata.icon;
          description = metadata.description;
        }
        // lib.optionalAttrs (siteMonitor != null) {
          inherit siteMonitor;
        };
      };
    }
  ) enabledApps;

  infrastructureEntries = lib.mapAttrsToList (_: entry: {
    category = entry.category;
    service = {
      "${entry.name}" = {
        inherit (entry) href icon description;
      };
    };
  }) cfg.infrastructureEntries;

  allEntries = appEntries ++ infrastructureEntries;
  groupedEntries = lib.foldl' (
    groups: entry:
    groups
    // {
      ${entry.category} = (groups.${entry.category} or [ ]) ++ [ entry.service ];
    }
  ) { } allEntries;
  categories =
    cfg.categoryOrder
    ++ lib.filter (category: !(builtins.elem category cfg.categoryOrder)) (
      builtins.attrNames groupedEntries
    );
  services = map (category: { "${category}" = groupedEntries.${category}; }) categories;
in
{
  options.homelab.infra.homepage = {
    enable = lib.mkEnableOption "Homepage homelab dashboard";

    port = lib.mkOption {
      type = lib.types.port;
      default = 8082;
      description = "Local port Homepage listens on";
    };

    categoryOrder = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = "Homepage service groups in display order";
    };

    infrastructureEntries = lib.mkOption {
      type = lib.types.attrsOf (
        lib.types.submodule {
          options = {
            category = lib.mkOption {
              type = lib.types.str;
              description = "Homepage service group";
            };
            name = lib.mkOption {
              type = lib.types.str;
              description = "Friendly service name";
            };
            href = lib.mkOption {
              type = lib.types.str;
              description = "Service URL";
            };
            icon = lib.mkOption {
              type = lib.types.str;
              default = "mdi-application";
              description = "Homepage icon identifier";
            };
            description = lib.mkOption {
              type = lib.types.str;
              default = "";
              description = "Short service description";
            };
          };
        }
      );
      default = { };
      description = "Manually declared infrastructure services for Homepage";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = edge.enable;
        message = "homelab.infra.homepage.enable requires homelab.infra.edge.enable";
      }
      {
        assertion = tinyauth.enable;
        message = "homelab.infra.homepage.enable requires homelab.infra.tinyauth.enable";
      }
    ];

    services.homepage-dashboard = {
      enable = true;
      listenPort = cfg.port;
      allowedHosts = domain;
      services = services;
      widgets = [
        {
          resources = {
            cpu = true;
            memory = true;
            uptime = true;
            disk = [
              "/mnt/fast"
              "/mnt/slow"
            ];
          };
        }
      ];
      settings = {
        title = "Leo's Homelab";
        headerStyle = "clean";
        statusStyle = "dot";
        hideVersion = true;
        layout = lib.genAttrs categories (_: {
          style = "row";
          columns = 4;
        });
      };
      customCSS = ''
        :root {
          --font-sans: "SF Pro Display", Helvetica, Arial, sans-serif;
        }

        body {
          font-family: var(--font-sans);
        }

        .font-bold {
          font-weight: 800;
        }

        .font-semibold {
          font-weight: 700;
        }

        .font-medium {
          font-weight: 600;
        }

        #information-widgets {
          padding-left: 1rem;
          padding-right: 1rem;
        }

        #information-widgets .widget-container > div {
          gap: 0.75rem;
        }

        #information-widgets .information-widget-resource {
          margin-right: 0;
          padding: 0.75rem 1rem;
          border: 1px solid rgb(var(--color-200) / 0.2);
          border-radius: 0.75rem;
          background-color: rgb(var(--color-100) / 0.2);
          box-shadow: 0 1px 2px rgb(0 0 0 / 0.08);
          transition: background-color 150ms ease;
        }

        #information-widgets .information-widget-resource:hover {
          background-color: rgb(var(--color-100) / 0.35);
        }

        .dark #information-widgets .information-widget-resource {
          border-color: rgb(var(--color-700) / 0.5);
          background-color: rgb(var(--color-800) / 0.5);
          box-shadow: 0 1px 2px rgb(0 0 0 / 0.2);
        }

        .dark #information-widgets .information-widget-resource:hover {
          background-color: rgb(var(--color-800) / 0.8);
        }

        #footer,
        footer {
          display: none;
        }

        .services-group,
        .service-group,
        #services > div {
          margin-bottom: 2rem;
        }
      '';
    };

    systemd.services.homepage-dashboard.environment.HOSTNAME = "127.0.0.1";

    homelab.infra.edge.rootProxy = {
      upstream = "http://127.0.0.1:${toString cfg.port}";
      auth = true;
      # Homepage validates the forwarded Host against HOMEPAGE_ALLOWED_HOSTS.
      headerUp.Host = domain;
    };
  };
}
