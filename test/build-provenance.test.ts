import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolveBuildGitHead } from "../scripts/build-provenance";

const REPOSITORY_HEAD = "f1d81afe22d3e750317f55b04fb4dcdf712dca36";
const RELEASE_HEAD = "0123456789abcdef0123456789abcdef01234567";

describe("build provenance", () => {
	test("uses an explicit release commit without invoking Git", () => {
		let gitInvocations = 0;
		expect(
			resolveBuildGitHead({
				environmentGitHead: RELEASE_HEAD,
				resolveRepositoryGitHead: () => {
					gitInvocations += 1;
					return REPOSITORY_HEAD;
				},
			}),
		).toBe(RELEASE_HEAD);
		expect(gitInvocations).toBe(0);
	});

	test("falls back to the repository commit for developer builds", () => {
		expect(
			resolveBuildGitHead({
				environmentGitHead: undefined,
				resolveRepositoryGitHead: () => REPOSITORY_HEAD,
			}),
		).toBe(REPOSITORY_HEAD);
	});

	test("rejects malformed explicit and repository commits", () => {
		expect(() =>
			resolveBuildGitHead({
				environmentGitHead: "not-a-commit",
				resolveRepositoryGitHead: () => REPOSITORY_HEAD,
			}),
		).toThrow("CEX_BROKER_BUILD_GIT_HEAD");
		expect(() =>
			resolveBuildGitHead({
				environmentGitHead: undefined,
				resolveRepositoryGitHead: () => "",
			}),
		).toThrow("build cannot resolve a pin-eligible git HEAD");
	});

	test("passes the GitHub release commit into the Docker build", () => {
		const buildSource = readFileSync(
			new URL("../build.ts", import.meta.url),
			"utf8",
		);
		const dockerfile = readFileSync(
			new URL("../Dockerfile", import.meta.url),
			"utf8",
		);
		const publishWorkflow = readFileSync(
			new URL("../.github/workflows/publish.yml", import.meta.url),
			"utf8",
		);

		expect(buildSource).toContain("CEX_BROKER_BUILD_GIT_HEAD");
		expect(dockerfile).toContain("ARG CEX_BROKER_BUILD_GIT_HEAD");
		expect(publishWorkflow).toContain(
			`CEX_BROKER_BUILD_GIT_HEAD=\${{ github.sha }}`,
		);
	});
});
