export const MAX_ARCHIVE_BODY_BYTES = 5 * 1024 * 1024;
export const MAX_ARCHIVE_ROWS = 1_000;

export function isArchiveBodyTooLarge(contentLength: string | null): boolean {
	if (!contentLength) {
		return false;
	}
	const parsed = Number.parseInt(contentLength, 10);
	return Number.isFinite(parsed) && parsed > MAX_ARCHIVE_BODY_BYTES;
}
