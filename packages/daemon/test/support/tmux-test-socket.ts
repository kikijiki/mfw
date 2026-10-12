/**
 * Import this FIRST in any test that launches real runs. `agent-host.ts` reads
 * `MFW_TMUX_SOCKET` once at module load, and the default socket (`mfw`) is the
 * running service's: a test daemon would see, and could kill, its sessions.
 */
const current = process.env.MFW_TMUX_SOCKET;
if (!current || current === "mfw") {
	process.env.MFW_TMUX_SOCKET = `mfw-test-brain-${process.pid}`;
}
export const TEST_TMUX_SOCKET = process.env.MFW_TMUX_SOCKET as string;
