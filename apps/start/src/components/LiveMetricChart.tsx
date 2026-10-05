import { useEffect, useMemo, useState } from "react";

export interface LiveMetricSample {
	at: number;
	values: Record<string, number | null>;
}

export interface LiveMetricSeries {
	key: string;
	label: string;
	color?: string;
}

/** Bounded, page-local telemetry history. No value is presented as durable history. */
export function useRollingMetricSamples(
	sample: LiveMetricSample | null,
	maxSamples = 120,
): LiveMetricSample[] {
	const [samples, setSamples] = useState<LiveMetricSample[]>([]);
	const signature = sample ? JSON.stringify(sample.values) : "";
	useEffect(() => {
		if (!sample || !Number.isFinite(sample.at)) return;
		setSamples((current) => {
			const previous = current.at(-1);
			if (previous?.at === sample.at) {
				if (JSON.stringify(previous.values) === signature) return current;
				return [...current.slice(0, -1), sample];
			}
			if (previous && sample.at < previous.at) return current;
			return [...current, sample].slice(-maxSamples);
		});
	}, [maxSamples, sample, signature]);
	return samples;
}

function linePath(
	samples: readonly LiveMetricSample[],
	key: string,
	minimum: number,
	maximum: number,
): string {
	const span = Math.max(maximum - minimum, Number.EPSILON);
	return samples
		.map((sample, index) => {
			const value = sample.values[key];
			if (typeof value !== "number" || !Number.isFinite(value)) return "";
			const x =
				samples.length === 1 ? 50 : (index / (samples.length - 1)) * 100;
			const y = 32 - ((value - minimum) / span) * 28;
			const previous = samples[index - 1]?.values[key];
			return `${previous === null || previous === undefined ? "M" : "L"}${x.toFixed(2)} ${Math.max(4, Math.min(32, y)).toFixed(2)}`;
		})
		.filter(Boolean)
		.join(" ");
}

export function LiveMetricChart({
	label,
	samples,
	series,
	minimum = 0,
	maximum,
	formatValue = (value) => value.toFixed(1),
	sampleScope = "this page session",
}: {
	label: string;
	samples: readonly LiveMetricSample[];
	series: readonly LiveMetricSeries[];
	minimum?: number;
	maximum?: number;
	formatValue?: (value: number) => string;
	/** Human-readable provenance for the x-axis samples. */
	sampleScope?: string;
}) {
	const values = useMemo(
		() =>
			samples.flatMap((sample) =>
				series.flatMap((item) => {
					const value = sample.values[item.key];
					return typeof value !== "number" || !Number.isFinite(value)
						? []
						: [value];
				}),
			),
		[samples, series],
	);
	const top = maximum ?? Math.max(minimum + 1, ...values, 1);
	const latest = samples.at(-1);
	return (
		<figure aria-label={label} className="m-0 min-w-0">
			<svg
				role="img"
				aria-label={`${label}, ${sampleScope}`}
				viewBox="0 0 100 36"
				preserveAspectRatio="none"
				className="h-24 w-full overflow-visible border-y"
				style={{ borderColor: "var(--mfw-border)" }}
			>
				<title>{label}</title>
				<line x1="0" y1="4" x2="100" y2="4" stroke="var(--mfw-border)" />
				<line x1="0" y1="18" x2="100" y2="18" stroke="var(--mfw-border)" />
				<line x1="0" y1="32" x2="100" y2="32" stroke="var(--mfw-border)" />
				{series.map((item, index) => (
					<path
						key={item.key}
						d={linePath(samples, item.key, minimum, top)}
						fill="none"
						stroke={item.color ?? `var(--chart-${(index % 5) + 1})`}
						strokeWidth="1.5"
						vectorEffect="non-scaling-stroke"
					/>
				))}
			</svg>
			<figcaption className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
				{series.map((item, index) => {
					const value = latest?.values[item.key];
					return (
						<span key={item.key} className="inline-flex items-center gap-1">
							<span
								aria-hidden
								className="inline-block size-2"
								style={{
									background: item.color ?? `var(--chart-${(index % 5) + 1})`,
								}}
							/>
							{item.label}{" "}
							{value === null || value === undefined ? "-" : formatValue(value)}
						</span>
					);
				})}
				<span className="ml-auto" style={{ color: "var(--mfw-fg-faint)" }}>
					{samples.length < 2
						? sampleScope === "this page session"
							? "Collecting live samples…"
							: `${samples.length} sample · ${sampleScope}`
						: `${samples.length} samples · ${sampleScope}`}
				</span>
			</figcaption>
		</figure>
	);
}
