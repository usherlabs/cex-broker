import type { RowInserter } from "../../../../services/archive-forwarder/insert";
import {
	type InserterController,
	LifecycleBarrier,
} from "./archive-e2e-contracts";

export function createBlockedInserter(
	delegate: RowInserter,
): InserterController {
	const requestStarted = new LifecycleBarrier<void>();
	const releaseBarrier = new LifecycleBarrier<void>();
	let attempts = 0;
	return {
		inserter: async (table, rows) => {
			attempts += 1;
			requestStarted.resolve();
			await releaseBarrier.promise;
			await delegate(table, rows);
		},
		requestStarted,
		release: () => releaseBarrier.resolve(),
		get attempts() {
			return attempts;
		},
	};
}

export function createScriptedInserter(
	delegate: RowInserter,
	failuresBeforeSuccess: number,
): InserterController {
	const requestStarted = new LifecycleBarrier<void>();
	let attempts = 0;
	return {
		inserter: async (table, rows) => {
			attempts += 1;
			requestStarted.resolve();
			if (attempts <= failuresBeforeSuccess) {
				throw new Error(
					`scripted ClickHouse Local insertion failure ${attempts}`,
				);
			}
			await delegate(table, rows);
		},
		requestStarted,
		release: () => {},
		get attempts() {
			return attempts;
		},
	};
}
