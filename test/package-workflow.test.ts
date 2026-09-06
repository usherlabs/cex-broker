import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");

test("ordinary prepack builds without recursively packing", () => {
	const manifest = JSON.parse(read("package.json"));
	expect(manifest.scripts.prepack).toBe("bun run build");
	expect(manifest.scripts.build).not.toContain("check:package");
	expect(manifest.scripts.build).not.toContain("npm pack");
	expect(manifest.scripts["copy:dts"]).toBeUndefined();
	expect(manifest.devDependencies["dts-bundle-generator"]).toBe("9.5.1");
	expect(manifest.devDependencies["bun-plugin-dts"]).toBeUndefined();
	expect(Object.keys(manifest.exports)).toEqual([
		".",
		"./proto/node.proto",
		"./proto/node.descriptor",
		"./build-metadata.json",
	]);
	for (const value of Object.values(manifest.exports)) {
		if (typeof value === "object" && value !== null && "types" in value) {
			expect(Object.keys(value)[0]).toBe("types");
		}
	}
});

test("CI gates a real tarball and publishing uses exactly those verified bytes with OIDC", () => {
	const publish = read(".github/workflows/publish.yml");
	const ci = read(".github/workflows/ci.yml");
	for (const workflow of [ci, publish]) {
		expect(workflow).toContain("npm pack --pack-destination");
		expect(workflow).toContain(
			`bun run check:package --tarball "\${{ steps.package.outputs.tarball }}" --expected-git-head "\${{ github.sha }}"`,
		);
		expect(workflow).toContain("bun install --frozen-lockfile");
	}
	expect(publish).toContain(
		`npm publish "\${{ steps.package.outputs.tarball }}" --ignore-scripts --provenance --access public`,
	);
	expect(publish).toContain("id-token: write");
	expect(publish).toContain("npm install -g npm@12");
	expect(publish.indexOf("bun run check:package")).toBeLessThan(
		publish.indexOf("run: npm publish"),
	);
	expect(publish).not.toContain("run: npm publish --");
});

test("manual releases default to npm only while tag releases retain Docker publication", () => {
	const publish = read(".github/workflows/publish.yml");
	expect(publish).toContain(
		"      publish_docker:\n        description: Also publish the broker Docker image (including latest)\n        required: false\n        type: boolean\n        default: false",
	);
	expect(publish).toContain(
		"  publish-docker:\n    if: github.event_name == 'push' || inputs.publish_docker\n    runs-on: ubuntu-latest\n    needs: publish-npm",
	);
});

test("manual release revision guard fails closed before build or publication", () => {
	const publish = read(".github/workflows/publish.yml");
	expect(publish).toContain(
		"      expected_git_head:\n        description: Approved full Git commit to publish\n        required: true\n        type: string",
	);
	const step = publish
		.split("      - name: Verify requested release revision\n")[1]
		?.split("\n      - name:")[0];
	expect(step).toContain("if: github.event_name == 'workflow_dispatch'");
	expect(step).toContain(`EXPECTED_GIT_HEAD: \${{ inputs.expected_git_head }}`);
	expect(step).toContain(`ACTUAL_GIT_HEAD: \${{ github.sha }}`);
	const script = step?.split("        run: |\n")[1];
	if (!script) throw new Error("Missing manual release revision guard");
	expect(
		publish.indexOf("name: Verify requested release revision"),
	).toBeLessThan(publish.indexOf("name: Install Bun"));
	const approved = "0123456789abcdef0123456789abcdef01234567";
	for (const [expected, actual, status] of [
		[approved, approved, 0],
		[approved, "f".repeat(40), 1],
		["", approved, 1],
		["short", "short", 1],
		[approved.toUpperCase(), approved.toUpperCase(), 1],
		["$(exit 9)", approved, 1],
	] as const) {
		const result = spawnSync("bash", ["-e", "-c", script], {
			env: {
				PATH: process.env.PATH,
				EXPECTED_GIT_HEAD: expected,
				ACTUAL_GIT_HEAD: actual,
			},
			encoding: "utf8",
		});
		expect(result.status).toBe(status);
	}
});
