export function runPodErrorText(code: string | null): string | null {
	if (!code) return null;
	const known: Record<string, string> = {
		credential_missing: "No RunPod API key is stored",
		credential_validation_failed: "RunPod rejected the stored API key",
		credential_recovery_failed:
			"The prior API key was restored, but account safety could not be verified",
		credential_rollback_failed:
			"The prior API key could not be safely restored",
		network_error: "RunPod could not be reached",
		invalid_response: "RunPod returned an unreadable response",
		owner_unavailable: "A configured owner project is unavailable",
		cleanup_pending: "Pod termination still needs confirmation",
		absence_not_confirmed: "RunPod has not yet confirmed the Pod is gone",
		ambiguous_ownership: "Pod ownership is ambiguous",
	};
	return known[code] ?? code.replaceAll("_", " ");
}

export function runPodDispatchStatus(input: {
	gateOpen: boolean;
	requestedPaused: boolean;
	gateReason: string | null;
}): string {
	if (input.gateOpen) return "Accepting tasks";
	if (input.requestedPaused) return "Paused";
	return `Blocked: ${input.gateReason ?? "account safety is not verified"}`;
}

export function runPodResumeDisabledReason(input: {
	enabled: boolean;
	credentialReady: boolean;
	credentialValidated: boolean;
	inventoryFresh: boolean;
	reconcileError: string | null;
}): string | null {
	if (!input.enabled) return "Enable RunPod safety limits before resuming.";
	if (!input.credentialReady) return "Store a RunPod API key before resuming.";
	if (!input.credentialValidated)
		return "Validate the stored RunPod API key before resuming.";
	if (input.reconcileError)
		return `Resolve the latest account check failure before resuming: ${runPodErrorText(input.reconcileError)}.`;
	if (!input.inventoryFresh)
		return "Check the live RunPod account before resuming.";
	return null;
}

export function runPodComputeText(shape: {
	computeType: string | null;
	gpuCount: number | null;
	vcpuCount: number | null;
}): string {
	return shape.computeType === "CPU"
		? `${shape.vcpuCount ?? "?"} vCPU`
		: `${shape.gpuCount ?? "?"} GPU`;
}

export function runPodPhaseText(phase: string): string {
	const phases: Record<string, string> = {
		intent: "Waiting to create",
		provisioning: "Creating Pod",
		ready: "Ready for work",
		staging: "Uploading work",
		executing: "Running task",
		collecting: "Downloading results",
		quarantined: "Held for inspection",
		terminating: "Terminating",
		cleanup_pending: "Termination pending",
		absent: "Gone",
		failed: "Lifecycle failed",
		observed: "Seen in RunPod account",
	};
	return phases[phase] ?? "Provider state needs review";
}

export function runPodTerminationDisabledReason(input: {
	inventoryFresh: boolean;
	live: boolean;
	owned: boolean;
	hasFingerprint: boolean;
}): string | null {
	if (!input.inventoryFresh) return "Check live inventory before terminating.";
	if (!input.live) return "This Pod is not currently running.";
	if (!input.owned) return "MFW ownership is not confirmed for this Pod.";
	if (!input.hasFingerprint)
		return "The ownership record is incomplete; termination is blocked.";
	return null;
}
