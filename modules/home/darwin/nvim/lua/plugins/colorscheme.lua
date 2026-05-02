return {
  -- add sonokai theme plugin
  { "sainnhe/sonokai" },

  -- Configure LazyVim to load sonokai
  {
    "LazyVim/LazyVim",
    opts = {
      colorscheme = "sonokai",
    },
  },
}
