const GIT_HEAD_PATTERN = /^[0-9a-f]{40}$/;

export function resolveBuildGitHead(input: {
	environmentGitHead: string | undefined;
	resolveRepositoryGitHead: () => string;
}): string {
	if (input.environmentGitHead !== undefined) {
		const environmentGitHead = input.environmentGitHead.trim();
		if (!GIT_HEAD_PATTERN.test(environmentGitHead)) {
			throw new Error(
				"CEX_BROKER_BUILD_GIT_HEAD must be a 40-character lowercase Git commit",
			);
		}
		return environmentGitHead;
	}

	const repositoryGitHead = input.resolveRepositoryGitHead().trim();
	if (!GIT_HEAD_PATTERN.test(repositoryGitHead)) {
		throw new Error("build cannot resolve a pin-eligible git HEAD");
	}
	return repositoryGitHead;
}
