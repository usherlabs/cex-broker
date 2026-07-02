export function isArchiveAuthConfigured(token: string | undefined): boolean {
	return Boolean(token?.trim());
}

export function isArchiveRequestAuthorized(
	request: Request,
	expectedToken: string | undefined,
): boolean {
	if (!isArchiveAuthConfigured(expectedToken)) {
		return true;
	}
	const header = request.headers.get("authorization")?.trim();
	if (!header?.startsWith("Bearer ")) {
		return false;
	}
	const provided = header.slice("Bearer ".length).trim();
	return provided.length > 0 && provided === expectedToken?.trim();
}
