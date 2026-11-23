/**
 * The bypass spellings from the harness security review (F1 and F2), one argv
 * per row, without the command. Shared by the detector test and the frozen
 * equivalence snapshot.
 */
export const BYPASS_CORPUS: Readonly<Record<string, readonly string[][]>> = {
	"attached short values": [
		["-anever"],
		["-a=never"],
		["-sdanger-full-access"],
		["-s=danger-full-access"],
		["-capproval_policy=never"],
		["-csandbox_mode=danger-full-access"],
		['-capproval_policy="never"'],
	],
	"TOML forms in -c": [
		["-c", 'approval_policy="never" # x'],
		["-c", 'approval_policy="""never"""'],
		["-c", "approval_policy='''never'''"],
		["-c", "approval_policy='never'"],
		["-c", '"approval_policy"=never'],
		["-c", '"approval_policy"="never"'],
		["-c", "'approval_policy'=\"never\""],
		["-c", 'approval_policy="nev\\u0065r"'],
		["-c", 'approval_policy = "never"'],
		["-c", 'a=1\napproval_policy="never"'],
		["-c", 'sandbox_mode="""danger-full-access"""'],
		["--config", '"sandbox_mode"="danger-full-access" # x'],
		['--config=approval_policy="never" # x'],
	],
	"config indirection": [
		["--settings", '{"permissions":{"defaultMode":"bypassPermissions"}}'],
		["--settings=/tmp/settings.json"],
		["--profile", "x"],
		["--profile=x"],
		["-c", "profile=x"],
		["-c", 'profiles.x.approval_policy="never"'],
		["-c", '"profiles"."x".approval_policy="never"'],
		["-cprofile=x"],
		["-c", "approvals_reviewer=agent"],
		["-c", "sandbox_workspace_write.network_access=true"],
	],
	"clustered short flags": [["-yd"], ["-fp"], ["-py"], ["-pf"]],
	"case and separator variants": [
		["--FULL-AUTO"],
		["--full_auto"],
		["--Full_Auto"],
		["--YOLO"],
		["--FORCE"],
		["--Dangerously_Skip_Permissions"],
		["--approval-mode", "YOLO"],
		["--approval_mode", "yolo"],
		["--approval-mode=YOLO"],
		["--approval-mode", "auto-edit"],
		["--sandbox", "DANGER-FULL-ACCESS"],
		["--sandbox", "danger_full_access"],
		["--ask-for-approval", "NEVER"],
		["--permission-mode", "BYPASSPERMISSIONS"],
	],
	"flag-like model values": [
		["--model", "-f"],
		["--model", "-y"],
		["--model", "--force"],
		["--model", "--yolo"],
	],
};

/** A whole command that hides the CLI behind another program. */
export const WRAPPER_ARGV: readonly string[][] = [
	["sh", "-c", "claude --dangerously-skip-permissions"],
	["bash", "-lc", "claude --dangerously-skip-permissions"],
	["/bin/sh", "-c", "codex --yolo"],
	["env", "claude", "--dangerously-skip-permissions"],
	["/usr/bin/env", "FOO=1", "claude"],
	["xargs", "claude"],
	["dash", "-c", "claude"],
	["zsh", "-c", "claude"],
	["nohup", "claude"],
	["setsid", "claude"],
	["timeout", "5", "claude"],
	["busybox", "sh", "-c", "claude"],
];

/** Close to a bypass and still asks: must stay undetected. */
export const NOT_BYPASS: readonly string[][] = [
	["--sandbox", "read-only"],
	["-s", "read-only"],
	["-sread-only"],
	["-a", "on-request"],
	["-aon-request"],
	["-c", 'approval_policy="on-request"'],
	["-c", 'sandbox_mode="read-only"'],
	["-c", 'model_reasoning_effort="high"'],
	["--approval-mode", "plan"],
	["--permission-mode", "plan"],
	["--no-approve"],
	["-p"],
	["--print"],
	["--model", "opus"],
	["--skip-git-repo-check"],
];
