export const MFW_RUNPOD_CPU_READY_PATH = "/run/mfw-ready";

const NODE_VERSION = "24.19.0";
const NODE_LINUX_X64_SHA256 =
	"14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647";

/** Idempotent, controller-observed bootstrap for the pinned RunPod CPU base.
 * The image's own /start.sh establishes SSH first; this command then installs
 * the exact execution toolchain behind a cross-process lock. */
const MFW_RUNPOD_CPU_BOOTSTRAP = [
	"set -eu",
	`test -f ${MFW_RUNPOD_CPU_READY_PATH} && exit 0`,
	"umask 022",
	"tmp=$(mktemp -d)",
	"trap 'rm -rf \"$tmp\"' EXIT",
	`curl -fsSLo "$tmp/node.tar.xz" https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz`,
	`printf '%s  %s\\n' '${NODE_LINUX_X64_SHA256}' "$tmp/node.tar.xz" | sha256sum -c -`,
	'tar -xJf "$tmp/node.tar.xz" -C /usr/local --strip-components=1',
	"npm install --global --no-audit --no-fund bun@1.3.13 @openai/codex@0.149.0 @anthropic-ai/claude-code@2.1.238",
	"node --version >/dev/null",
	"bun --version >/dev/null",
	"git --version >/dev/null",
	"codex --version >/dev/null",
	"claude --version >/dev/null",
	`touch ${MFW_RUNPOD_CPU_READY_PATH}`,
].join("; ");

export function mfwRunPodCpuBootstrapCommand(): readonly string[] {
	return [
		"flock",
		"-x",
		"/run/mfw-bootstrap.lock",
		"/bin/bash",
		"-lc",
		MFW_RUNPOD_CPU_BOOTSTRAP,
	];
}
