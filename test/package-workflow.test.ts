import { expect, test } from "bun:test";
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
