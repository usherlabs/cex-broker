import assert from "node:assert/strict";

const GIT_HEAD_PATTERN = /^[0-9a-f]{40}$/;

export function verifyReleaseRevision(input: {
	expectedGitHead: string;
	repositoryGitHead: string;
	repositoryStatus: string;
}): void {
	assert.match(
		input.expectedGitHead,
		GIT_HEAD_PATTERN,
		"Expected release commit is required",
	);
	assert.equal(
		input.expectedGitHead,
		input.repositoryGitHead,
		"Verifier checkout must match the expected release revision",
	);
	assert.equal(
		input.repositoryStatus,
		"",
		"Package release evidence requires clean committed source",
	);
}

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
