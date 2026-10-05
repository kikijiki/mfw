# mfw: home-manager systemd user service.
#
# A per-user service (mfw needs your home, your tmux, and your Claude
# subscription auth). The single TanStack Start app is one Bun process: it boots
# the orchestrator in-process, serves the UI, and exposes tRPC on :7777.
#
# Usage: import this module from your home-manager config and adjust `dir`:
#   imports = [ /path/to/mfw/packaging/mfw.home-manager.nix ];
# then `home-manager switch`. The app answers at http://<tailnet-ip>:7777/mfw,
# the `/mfw` prefix is Vite's `base`, baked in at build time (`/` redirects to
# it). Rebuild with MFW_BASE_PATH=/ to mount at the root instead.
#
# To put it behind HTTPS on the tailnet, bind loopback (HOST=127.0.0.1, dropping
# the wrapper below) and run:
#   tailscale serve --bg --set-path /mfw http://127.0.0.1:7777/mfw
# The target repeats the prefix on purpose, Serve strips the mount path.
#
# Safety: it starts with the scheduler OFF (no task dispatch until you enable it
# in the UI; that choice is persisted + restored on reboot) and binds the HTTP
# listener to your TAILNET IP ONLY, mfw runs agents with
# --dangerously-skip-permissions and full repo access, so it must never be
# exposed on the LAN. Drop the tailscale wrapper for HOST=0.0.0.0 only if you
# understand that risk (see the comment below).
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
  # is optional, only used when a project sets `agentIsolation: "bwrap"`
  # (MFW-33 item 3); its absence degrades runs to unsandboxed, not a failure.
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

  # Bind to the tailnet IP only (Nitro honors $HOST). Refuse to start until the
  # tailscale IP is up (systemd retries) instead of binding 0.0.0.0.
  startTailscaleBound = pkgs.writeShellScript "mfw-start" ''
    set -eu
    ip="$(${pkgs.tailscale}/bin/tailscale ip -4 2>/dev/null | head -n1 || true)"
    if [ -z "''${ip}" ]; then
      echo "mfw: no tailnet IPv4 yet (is tailscaled up?), refusing to bind, will retry"
      exit 1
    fi
    export HOST="''${ip}"
    exec ${pkgs.bun}/bin/bun run ${out}
    # LAN/all-interfaces alternative (NOT recommended): replace the two lines
    # above with `export HOST=0.0.0.0; exec ${pkgs.bun}/bin/bun run ${out}`.
  '';
in {
  systemd.user.services.mfw = {
    Unit = {
      Description = "mfw: local autonomous project orchestrator (tailnet-only)";
      After = ["network-online.target" "tailscaled.service"];
      Wants = ["network-online.target"];
      StartLimitIntervalSec = 0; # retry indefinitely while waiting for the tailnet IP
    };
    Service = {
      Type = "simple";
      WorkingDirectory = dir;
      Environment = [
        "PATH=${binPath}:${config.home.profileDirectory}/bin:/run/current-system/sw/bin"
        "MFW_HOME=%h/.local/share/mfw"
        "PORT=7777"
      ];
      ExecStartPre = "${buildIfMissing}";
      ExecStart = "${startTailscaleBound}";
      Restart = "on-failure";
      RestartSec = 5;

      # Agent runs are detached tmux sessions meant to survive a daemon restart,
      # the supervisor re-adopts them on boot. systemd's default KillMode of
      # control-group silently broke that: every restart killed the in-flight
      # runs, which then finalized as "session ended without recording an exit".
      # `process` signals only the daemon.
      #
      # Trade-off: `systemctl --user stop mfw` leaves running agents alive. Stop
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
