export const MAX_ARCHIVE_BODY_BYTES = 5 * 1024 * 1024;
export const MAX_ARCHIVE_ROWS = 1_000;

export function isArchiveBodyTooLarge(contentLength: string | null): boolean {
	if (!contentLength) {
		return false;
	}
	const parsed = Number.parseInt(contentLength, 10);
	return Number.isFinite(parsed) && parsed > MAX_ARCHIVE_BODY_BYTES;
}

export type BoundedBodyReadResult =
	| { ok: true; text: string }
	| { ok: false; status: 413 | 400 };

export async function readBoundedArchiveBody(
	request: Request,
	maxBytes: number = MAX_ARCHIVE_BODY_BYTES,
): Promise<BoundedBodyReadResult> {
	if (!request.body) {
		return { ok: true, text: "" };
	}

	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			totalBytes += value.byteLength;
			if (totalBytes > maxBytes) {
				await reader.cancel();
				return { ok: false, status: 413 };
			}
			chunks.push(value);
		}
	} catch {
		return { ok: false, status: 400 };
	}

	const bodyBytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
	return { ok: true, text: new TextDecoder().decode(bodyBytes) };
}
