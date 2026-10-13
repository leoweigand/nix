{ landrun }:

landrun.overrideAttrs (old: {
  postPatch = (old.postPatch or "") + ''
    # Require the full filesystem/TCP/IPC policy on Picard's ABI 6+ kernel.
    # These scripts use no pathname UNIX sockets; upstream's ABI 9 right would
    # otherwise make the sandbox fail on Linux 6.18. Do not use best-effort mode.
    substituteInPlace internal/sandbox/sandbox.go \
      --replace-fail $'syscall.AccessFSIoctlDev |\n\t\tsyscall.AccessFSResolveUnix' 'syscall.AccessFSIoctlDev'
  '';
})
