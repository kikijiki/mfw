import { type ImgHTMLAttributes, useEffect, useRef, useState } from "react";
import { authedFetch, isAuthedAssetUrl } from "~/lib/auth-client";

/**
 * `<img>` for this app's raw-bytes routes, which need the request key header
 * that a plain `src` cannot send. The bytes load through a blob URL (allowed
 * by the CSP's `img-src`); in an `<img>` even an SVG cannot run script. Any
 * other URL renders as a normal image.
 */
export function AuthImage({
	src,
	alt,
	onError,
	...rest
}: ImgHTMLAttributes<HTMLImageElement>) {
	const authed = typeof src === "string" && isAuthedAssetUrl(src);
	const [objectUrl, setObjectUrl] = useState<string | undefined>();
	// A ref: a new `onError` closure must not refetch the image.
	const notifyError = useRef(onError);
	notifyError.current = onError;

	useEffect(() => {
		if (!authed) return;
		let cancelled = false;
		let created: string | undefined;
		authedFetch(src as string)
			.then(async (res) => {
				if (!res.ok) throw new Error(`image failed (${res.status})`);
				const blob = await res.blob();
				if (cancelled) return;
				created = URL.createObjectURL(blob);
				setObjectUrl(created);
			})
			.catch(() => {
				if (!cancelled)
					notifyError.current?.(
						new Event("error") as unknown as Parameters<
							NonNullable<typeof onError>
						>[0],
					);
			});
		return () => {
			cancelled = true;
			if (created) URL.revokeObjectURL(created);
			setObjectUrl(undefined);
		};
	}, [authed, src]);

	return (
		<img
			src={authed ? objectUrl : src}
			data-asset-src={authed ? src : undefined}
			alt={alt}
			onError={onError}
			{...rest}
		/>
	);
}
