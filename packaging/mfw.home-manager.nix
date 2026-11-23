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
#   tailscale serve --bg --https=8443 --set-path /mfw http://127.0.0.1:7777/mfw
# The target repeats the prefix on purpose, Serve strips the mount path. See
# docs/exposure.md for why mfw needs its own origin.
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

  # First boot self-builds when the Nitro output is missing; re-run
  # `bun run build` (then restart the service) to pick up new commits.
  buildIfMissing = pkgs.writeShellScript "mfw-build-if-missing" ''
    set -eu
    cd ${dir}
    if [ ! -f ${out} ]; then
      ${pkgs.bun}/bin/bun install --frozen-lockfile || ${pkgs.bun}/bin/bun install
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
        # Behind a TLS proxy on this machine, name the proxy and the exact external
        # host:port (no wildcards). Forwarded headers are ignored without the first.
        # "MFW_TRUSTED_PROXIES=127.0.0.1"
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
