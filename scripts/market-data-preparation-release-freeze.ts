const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const GIT_HEAD = /^[a-f0-9]{40}$/u;

export function assertFrozenMarketDataPreparationRelease(input: {
	packageVersion: string;
	reservedVersion: string;
	head: string;
	mergeCommit: string;
	tagCommit: string;
	registryGitHead: string;
	clean: boolean;
}): { version: string; gitHead: string } {
	if (
		!SEMVER.test(input.packageVersion) ||
		input.packageVersion !== input.reservedVersion
	) {
		throw new Error("release_reserved_version_mismatch");
	}
	if (!input.clean) throw new Error("release_checkout_not_clean");
	if (
		!GIT_HEAD.test(input.head) ||
		input.mergeCommit !== input.head ||
		input.tagCommit !== input.head ||
		input.registryGitHead !== input.head
	) {
		throw new Error("release_git_head_mismatch");
	}
	return { version: input.packageVersion, gitHead: input.head };
}
