import { z } from "zod";
import {
	type CallContext,
	type ContractSpec,
	EpochMs,
	Id,
	LIMITS,
	method,
	Text,
} from "./common.ts";

/**
 * `mfw.notify/v1` (sinks) and `mfw.action/v1` (trigger actions).
 *
 * A sink receives host-rendered text, never transcripts or secrets; agent
 * text arrives separately and marked as quoted. `NOTIFICATION_TYPES` stays a
 * core list, so `type` is an opaque string here.
 *
 * An external trigger action receives a narrowed view. Today's
 * `TriggerDispatch` carries `projectRoot` and secret names and cannot cross
 * the boundary. `script`, `agent` and `create_task` stay core built-ins.
 */

export const AttentionClassSchema = z.enum(["act", "know", "ambient"]);

export const RenderedNotificationSchema = z.object({
	type: Id,
	attentionClass: AttentionClassSchema,
	project: Id.optional(),
	/** Rendered by the host; safe to show as-is. */
	text: z.string().max(LIMITS.text),
	/** Agent-authored text, to be shown quoted and never interpreted. */
	quoted: z.string().max(LIMITS.text).optional(),
	link: z.string().max(LIMITS.url).optional(),
	at: EpochMs,
});
export type RenderedNotification = z.infer<typeof RenderedNotificationSchema>;

export const DeliveryResultSchema = z.object({
	status: z.enum(["delivered", "failed", "rejected"]),
	retryable: z.boolean().default(false),
	detail: Text.optional(),
});
export type DeliveryResult = z.infer<typeof DeliveryResultSchema>;

export const notifyContract = {
	kind: "notify",
	methods: {
		send: method(
			z.object({ notification: RenderedNotificationSchema }),
			DeliveryResultSchema,
			{ mutating: true },
		),
	},
} satisfies ContractSpec;

export interface NotifySink {
	send(
		params: { notification: RenderedNotification },
		ctx: CallContext,
	): Promise<DeliveryResult>;
}

export const NarrowedTriggerViewSchema = z.object({
	definitionId: Id,
	deliveryId: Id,
	projectName: Id,
	event: z.object({
		type: Id,
		at: EpochMs,
		subject: Id.optional(),
		summary: z.string().max(LIMITS.text),
	}),
});
export type NarrowedTriggerView = z.infer<typeof NarrowedTriggerViewSchema>;

export const ActionResultSchema = z.object({
	status: z.enum(["ok", "failed"]),
	retryable: z.boolean().default(false),
	summary: Text.optional(),
});
export type ActionResult = z.infer<typeof ActionResultSchema>;

export const actionContract = {
	kind: "action",
	methods: {
		run: method(
			z.object({ view: NarrowedTriggerViewSchema }),
			ActionResultSchema,
			{ mutating: true },
		),
	},
} satisfies ContractSpec;

export interface TriggerActionPlugin {
	run(
		params: { view: NarrowedTriggerView },
		ctx: CallContext,
	): Promise<ActionResult>;
}
