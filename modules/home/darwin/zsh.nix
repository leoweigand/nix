{ lib, pkgs, ... }:

{
  programs.zsh = {
    enable = true;

    plugins = [
      {
        name = "zsh-autosuggestions";
        src = pkgs.zsh-autosuggestions;
        file = "share/zsh-autosuggestions/zsh-autosuggestions.zsh";
      }
      {
        name = "zsh-syntax-highlighting";
        src = pkgs.zsh-syntax-highlighting;
        file = "share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh";
      }
    ];

    shellAliases = {
      l = "ls -l";
      la = "ls -la";
      cat = "bat";
      f = "fzf";
      o = "open .";
      oprun = "op run --env-file=./.env";
      gs = "git status";
      gp = "git pull";
      lfg = "claude --dangerously-skip-permissions";
    };

    initContent = lib.mkMerge [
      # Before compinit so completions are available
      (lib.mkBefore ''
        fpath+=${pkgs.zsh-completions}/share/zsh/site-functions
      '')
      ''
        zstyle ':completion:*' matcher-list 'm:{a-z}={A-Za-z}'
        zstyle ':completion:*' menu select
        zstyle ':completion:*' group-name ""
        zstyle ':completion:*:descriptions' format '[%d]'

        # Must be a function: lazygit signals directory changes via
        # LAZYGIT_NEW_DIR_FILE; the wrapper cd's into the chosen path on exit.
        lg() {
          export LAZYGIT_NEW_DIR_FILE=~/.lazygit/newdir
          lazygit "$@"
          if [[ -f "$LAZYGIT_NEW_DIR_FILE" ]]; then
            cd "$(cat "$LAZYGIT_NEW_DIR_FILE")"
            rm -f "$LAZYGIT_NEW_DIR_FILE"
          fi
        }

        web-convert() {
          if [ -z "$1" ]; then
            echo "Usage: web-convert <input_video>"
            return 1
          fi
          local input="$1"
          local dir="$(dirname "$input")"
          local filename="$(basename "$input")"
          local name="''${filename%.*}"
          local output="$dir/''${name}_compressed.mp4"
          ffmpeg -i "$input" \
            -c:v libx264 \
            -preset medium \
            -crf 23 \
            -c:a aac \
            -b:a 128k \
            -movflags +faststart \
            -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" \
            "$output" && echo "Done: $output"
        }

        [ -s "$HOME/.bun/_bun" ] && source "$HOME/.bun/_bun"

        eval "$(fnm env --use-on-cd --shell zsh)"
      ''
    ];
  };

  home.packages = [ pkgs.fnm ];

  home.sessionPath = [
    "$HOME/.lmstudio/bin"
    "$HOME/.local/bin"
  ];
}
