import { lstat, unlink } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJsonResult } from "../src/helpers/market-data-preparation/file-job";

const SHA256 = /^[a-f0-9]{64}$/u;
const STABLE_REASON = /^[a-z][a-z0-9_]{0,127}$/u;
const PAIRS = ["ARB-USDC", "ARB-USDT"] as const;
type Pair = (typeof PAIRS)[number];

export type TwoPairSourceQualificationRun =
	| {
			pair: Pair;
			status: "passed";
			manifest_file_name: string;
			manifest_sha256: string;
			artifact_sha256s: string[];
			partial_evidence_sha256s: string[];
	  }
	| {
			pair: Pair;
			status: "failed";
			reason: string;
			artifact_sha256s: [];
			partial_evidence_sha256s: string[];
	  };

export type TwoPairSourceQualificationGateResult =
	| {
			schema_id: "https://schemas.usher.so/market-data-source-qualification-gate/v1";
			status: "passed";
			created_at: string;
			pairs: Array<{
				pair: Pair;
				manifest_file_name: string;
				manifest_sha256: string;
				artifact_sha256s: string[];
			}>;
	  }
	| {
			schema_id: "https://schemas.usher.so/market-data-source-qualification-gate/v1";
			status: "failed";
			created_at: string;
			failed_pair: Pair;
			reason: string;
			retained_partial_evidence_sha256s: string[];
	  };

function assertHashes(values: readonly string[]): void {
	if (values.some((value) => !SHA256.test(value))) {
		throw new Error("qualification_gate_hash_invalid");
	}
}

async function assertOutputDirectory(outputDirectory: string): Promise<void> {
	const stats = await lstat(outputDirectory);
	if (!stats.isDirectory() || stats.isSymbolicLink()) {
		throw new Error("qualification_gate_output_directory_invalid");
	}
}

export async function runTwoPairSourceQualificationGate(input: {
	outputDirectory: string;
	createdAt: string;
	runPair(pair: Pair): Promise<TwoPairSourceQualificationRun>;
}): Promise<TwoPairSourceQualificationGateResult> {
	await assertOutputDirectory(input.outputDirectory);
	if (new Date(input.createdAt).toISOString() !== input.createdAt) {
		throw new Error("qualification_gate_created_at_invalid");
	}
	const passed: Extract<TwoPairSourceQualificationRun, { status: "passed" }>[] =
		[];
	for (const pair of PAIRS) {
		const result = await input.runPair(pair);
		if (result.pair !== pair) {
			throw new Error("qualification_gate_pair_mismatch");
		}
		assertHashes(result.artifact_sha256s);
		assertHashes(result.partial_evidence_sha256s);
		if (result.status === "failed") {
			if (!STABLE_REASON.test(result.reason)) {
				throw new Error("qualification_gate_failure_reason_invalid");
			}
			const failure = {
				schema_id:
					"https://schemas.usher.so/market-data-source-qualification-gate/v1" as const,
				status: "failed" as const,
				created_at: input.createdAt,
				failed_pair: pair,
				reason: result.reason,
				retained_partial_evidence_sha256s: [
					...new Set([
						...passed.flatMap((pairResult) => [
							pairResult.manifest_sha256,
							...pairResult.artifact_sha256s,
						]),
						...result.partial_evidence_sha256s,
					]),
				].sort(),
			};
			await unlink(
				path.join(input.outputDirectory, "qualification-success.json"),
			).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
			});
			await atomicWriteJsonResult(
				path.join(input.outputDirectory, "qualification-verdict.json"),
				failure,
			);
			return failure;
		}
		if (
			!result.manifest_file_name ||
			path.basename(result.manifest_file_name) !== result.manifest_file_name ||
			!SHA256.test(result.manifest_sha256) ||
			result.artifact_sha256s.length !== 2
		) {
			throw new Error("qualification_gate_pair_success_invalid");
		}
		passed.push(result);
	}
	const success = {
		schema_id:
			"https://schemas.usher.so/market-data-source-qualification-gate/v1" as const,
		status: "passed" as const,
		created_at: input.createdAt,
		pairs: passed.map((result) => ({
			pair: result.pair,
			manifest_file_name: result.manifest_file_name,
			manifest_sha256: result.manifest_sha256,
			artifact_sha256s: [...result.artifact_sha256s].sort(),
		})),
	};
	await unlink(
		path.join(input.outputDirectory, "qualification-verdict.json"),
	).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") throw error;
	});
	await atomicWriteJsonResult(
		path.join(input.outputDirectory, "qualification-success.json"),
		success,
	);
	return success;
}
