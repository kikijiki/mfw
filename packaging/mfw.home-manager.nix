# mfw-server: home-manager systemd user service (unit `mfw-server`).
#
# A per-user service (mfw needs your home, your tmux, and your Claude
# subscription auth). The single TanStack Start app is one Bun process: it boots
# the orchestrator in-process, serves the UI, and exposes tRPC on :7777.
#
# Usage: import this module from your home-manager config and adjust `dir`:
#   imports = [ /path/to/mfw/packaging/mfw.home-manager.nix ];
# then `home-manager switch`. The app answers at http://127.0.0.1:7777/mfw, the
# `/mfw` prefix is Vite's `base`, baked in at build time (`/` redirects to it).
# Rebuild with MFW_BASE_PATH=/ to mount at the root instead.
#
# To reach it from another device, keep this loopback bind and publish it through
# a TLS proxy on its own origin. Set the two variables below, then run:
#   sudo tailscale serve --bg --https=8443 unix:$HOME/.local/share/mfw/serve/mfw.sock
# The private socket stops local processes from forging client addresses. See
# docs/exposure.md, including why mfw needs its own origin.
#
# First run: the setup token is in $MFW_HOME/setup-token (never in the log), or
# run `mfw auth setup-token`.
#
# Safety: it starts with the scheduler OFF (no task dispatch until you enable it
# in the UI; that choice is persisted + restored on reboot) and binds LOOPBACK
# ONLY. mfw runs agents with full repo access, and the server refuses a
# non-loopback bind that has neither TLS nor a trusted proxy.
{
  config,
  lib,
  pkgs,
  ...
}: let
  # Adjust to your checkout.
  dir = "${config.home.homeDirectory}/dev/mfw";
  out = "${dir}/apps/start/.output/server/index.mjs";

  # bun is required; tmux hosts agent runs; git/bash/coreutils/direnv are used by
  # the per-run scripts. `claude` is found via the profile bin below. bubblewrap
  # sandboxes agent runs (`agentIsolation: "bwrap"`, the default); without it
  # autonomous runs are refused with a fix, never run unsandboxed.
  binPath = lib.makeBinPath [pkgs.bun pkgs.tmux pkgs.git pkgs.bash pkgs.coreutils pkgs.direnv pkgs.bubblewrap];

  # First boot self-builds when the Nitro output or its host script manifest is
  # missing (the server refuses to launch agents without the manifest); re-run
  # `bun run build` (then restart the service) to pick up new commits.
  buildIfMissing = pkgs.writeShellScript "mfw-build-if-missing" ''
    set -eu
    cd ${dir}
    if [ ! -f ${out} ] || [ ! -f ${dir}/apps/start/.output/server/host-scripts/manifest.json ]; then
      # Fail closed: exactly the committed lockfile, and no dependency
      # lifecycle scripts (they would run arbitrary code as this user). If the
      # lockfile is out of date the unit fails; fix the lockfile, never fall
      # back to an unfrozen, script-running install.
      ${pkgs.bun}/bin/bun install --frozen-lockfile --ignore-scripts
      ${pkgs.bun}/bin/bun run build
    fi
  '';
in {
  systemd.user.services.mfw-server = {
    Unit = {
      Description = "mfw: local autonomous project orchestrator (loopback)";
      After = ["network.target"];
    };
    Service = {
      Type = "simple";
      WorkingDirectory = dir;
      Environment = [
        "PATH=${binPath}:${config.home.profileDirectory}/bin:/run/current-system/sw/bin"
        "MFW_HOME=%h/.local/share/mfw"
        "PORT=7777"
        "HOST=127.0.0.1"
        # Behind a TLS proxy on this machine, give it a private socket and name the
        # exact external host:port (no wildcards).
        # "MFW_LISTEN_SOCKET=%h/.local/share/mfw/serve/mfw.sock"
        # "MFW_ALLOWED_HOSTS=mybox.tail1234.ts.net:8443"
      ];
      ExecStartPre = "${buildIfMissing}";
      ExecStart = "${pkgs.bun}/bin/bun run ${out}";
      Restart = "on-failure";
      RestartSec = 5;

      # Agent runs are detached tmux sessions meant to survive a daemon restart,
      # the supervisor re-adopts them on boot. systemd's default KillMode of
      # control-group silently broke that: every restart killed the in-flight
      # runs, which then finalized as "session ended without recording an exit".
      # `process` signals only the daemon.
      #
      # Trade-off: `systemctl --user stop mfw-server` leaves running agents alive. Stop
      # them from the UI, or `tmux -L mfw kill-server` to clear them by hand.
      KillMode = "process";

      # A child being OOM-killed must not tear the orchestrator down with it.
      OOMPolicy = "continue";

      # Agent runs are accounted to this unit's cgroup. Uncomment to cap, leaving
      # generous headroom, a legitimate agent may run a full build or test suite.
      # MemoryHigh = "24G";
      # MemoryMax = "32G";
    };
    Install.WantedBy = ["default.target"];
  };
}
