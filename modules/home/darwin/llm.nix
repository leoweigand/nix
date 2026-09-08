{ lib, pkgs, ... }:

let
  # `llm <model><effort>` — the model letter also picks the harness, so the
  # harness never has to be typed. Order here drives the order in `llm --help`.
  models = [
    { letter = "o"; harness = "claude"; id = "opus"; label = "opus (latest)"; }
    { letter = "f"; harness = "claude"; id = "fable"; label = "fable (latest)"; }
    { letter = "n"; harness = "claude"; id = "sonnet"; label = "sonnet (latest)"; }
    { letter = "s"; harness = "opencode"; id = "openai/gpt-5.6-sol"; label = "gpt-5.6-sol"; }
    { letter = "t"; harness = "opencode"; id = "openai/gpt-5.6-terra"; label = "gpt-5.6-terra"; }
    { letter = "l"; harness = "opencode"; id = "openai/gpt-5.6-luna"; label = "gpt-5.6-luna"; }
    # Astra is not offered by opencode's OpenAI provider, so it runs on codex.
    { letter = "a"; harness = "codex"; id = "gpt-6-astra"; label = "gpt-6-astra"; }
  ];

  efforts = [
    { letter = ""; id = "high"; }
    { letter = "h"; id = "high"; }
    { letter = "m"; id = "medium"; }
    { letter = "x"; id = "xhigh"; }
  ];

  # opencode's TUI has no CLI flag for reasoning effort: it is a `variant` on
  # the agent, and it only takes effect when that agent's model is set in
  # config too — passing `--model` on the command line silently drops the
  # variant. So each model/effort pair gets a config file, merged over the
  # global ~/.config/opencode/opencode.json (MCP servers and the rest survive).
  opencodeAgents = [ "build" "plan" "general" "explore" ];

  opencodeConfig = model: effort:
    pkgs.writeText
      "opencode-${lib.replaceStrings [ "/" "." ] [ "-" "-" ] model}-${effort}.json"
      (builtins.toJSON {
        agent = lib.genAttrs opencodeAgents (_: { inherit model; variant = effort; });
      });

  # Permissions are bypassed by default; each harness spells that differently.
  mkCommand = m: e:
    if m.harness == "claude" then
      "claude --model ${m.id} --effort ${e.id} --dangerously-skip-permissions"
    else if m.harness == "codex" then
      "codex -m ${m.id} -c model_reasoning_effort=${e.id} --dangerously-bypass-approvals-and-sandbox"
    else
      "OPENCODE_CONFIG=${opencodeConfig m.id e.id} opencode --auto";

  pairs = lib.concatMap (m: map (e: { inherit m e; }) efforts) models;

  # The TUI also keeps its own per-model variant in ~/.local/state/opencode/
  # model.json and sends that with every message, which beats the agent config
  # above. Pinning it there as well is what makes the effort actually stick.
  variantPairs = lib.filter ({ m, ... }: m.harness == "opencode") pairs;

  pad = n: s: s + lib.concatStrings (lib.genList (_: " ") (n - lib.stringLength s));

  # zsh's flat `key value` form for associative arrays, which every zsh accepts.
  specEntries = lib.concatMapStringsSep "\n"
    ({ m, e }: "  ${pad 4 (m.letter + e.letter)}${lib.escapeShellArg (mkCommand m e)}")
    pairs;

  variantEntries = lib.concatMapStringsSep "\n"
    ({ m, e }: "  ${pad 4 (m.letter + e.letter)}${lib.escapeShellArg "${m.id} ${e.id}"}")
    variantPairs;

  helpText = ''
    llm [<model><effort>] [args...]

      model   o opus   f fable   n sonnet   s sol   t terra   l luna   a astra
      effort  <omitted>/h high   m medium   x xhigh

  '' + lib.concatMapStringsSep "\n"
    ({ m, e }: "  llm ${pad 6 (m.letter + e.letter)}${pad 16 m.label}${pad 8 e.id}${m.harness}")
    pairs;
in
{
  programs.zsh.initContent = ''
    typeset -gA _llm_specs
    _llm_specs=(
    ${specEntries}
    )
    typeset -gA _llm_variants
    _llm_variants=(
    ${variantEntries}
    )
    typeset -g _llm_help=${lib.escapeShellArg helpText}

    # The opencode TUI reads the variant from its own state file and sends it
    # with every message, so the agent config alone is not enough.
    _llm_pin_variant() {
      local model=$1 variant=$2
      local state=''${XDG_STATE_HOME:-$HOME/.local/state}/opencode/model.json
      local json='{}'
      [[ -r $state ]] && json=$(<$state)
      mkdir -p ''${state:h}
      if print -r -- $json \
        | ${pkgs.jq}/bin/jq --arg m "$model" --arg v "$variant" '.variant[$m] = $v' \
        > $state.llm; then
        mv $state.llm $state
      else
        rm -f $state.llm
        print -ru2 -- "llm: could not pin $model to variant $variant"
      fi
    }

    # llm [<model><effort>] [args...] — omit the effort for high, omit the
    # whole spec for opus. Anything else is passed through to the harness.
    llm() {
      if [[ ''${1-} == (-h|--help) ]]; then
        print -r -- "$_llm_help"
        return 0
      fi

      local spec=o
      if [[ -n ''${1-} && -n ''${_llm_specs[''${1}]-} ]]; then
        spec=$1
        shift
      elif [[ ''${1-} == [a-z](|[a-z]) ]]; then
        print -ru2 -- "llm: unknown spec '$1' (try: llm --help)"
        return 2
      fi

      if [[ -n ''${_llm_variants[$spec]-} ]]; then
        _llm_pin_variant ''${(z)_llm_variants[$spec]}
      fi

      command env ''${(z)_llm_specs[$spec]} "$@"
    }
  '';
}
