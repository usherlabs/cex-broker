import { parquetMetadata, type SchemaElement } from "hyparquet";
import {
	ORDER_BOOK_DEPTH_SUMMARY_PARQUET_PROJECTION,
	ORDER_BOOK_LEVELS_PARQUET_PROJECTION,
} from "../market-data-preparation/contracts";
import { ExactOrderBookExportError } from "./exact-selection";

type ProjectionColumn = {
	name: string;
	physical_type: string;
	logical_type: string | null;
	nullable: boolean;
};

type ProjectionDocument = {
	$id: string;
	canonical_schema_id: string;
	file_name: string;
	parquet_metadata: { key_value_metadata: unknown[] };
	columns: ProjectionColumn[];
};

type ParsedNode = {
	element: SchemaElement;
	children: ParsedNode[];
};

function parseNode(
	schema: readonly SchemaElement[],
	start: number,
): { node: ParsedNode; next: number } {
	const element = schema[start];
	if (!element) throw new Error("Parquet schema node is missing");
	const children: ParsedNode[] = [];
	let next = start + 1;
	for (let index = 0; index < (element.num_children ?? 0); index += 1) {
		const parsed = parseNode(schema, next);
		children.push(parsed.node);
		next = parsed.next;
	}
	return { node: { element, children }, next };
}

function topLevelColumns(schema: readonly SchemaElement[]): ParsedNode[] {
	const root = parseNode(schema, 0).node;
	if (root.element.name !== "schema") {
		throw new Error("Parquet root schema is invalid");
	}
	return root.children;
}

function normalizedLogicalType(element: SchemaElement): string | null {
	if (element.converted_type === "UTF8") return "UTF8";
	if (element.converted_type?.startsWith("UINT_")) {
		return element.converted_type;
	}
	if (element.converted_type === "DECIMAL") {
		return `DECIMAL(${element.precision},${element.scale})`;
	}
	return element.converted_type ?? null;
}

function firstLeaf(node: ParsedNode): SchemaElement | undefined {
	if (node.element.type) return node.element;
	for (const child of node.children) {
		const leaf = firstLeaf(child);
		if (leaf) return leaf;
	}
	return undefined;
}

function actualColumn(node: ParsedNode): ProjectionColumn {
	if (node.element.converted_type === "LIST") {
		const leaf = firstLeaf(node);
		if (!leaf) throw new Error("Parquet LIST column has no physical element");
		return {
			name: node.element.name,
			physical_type: "LIST",
			logical_type: `LIST<${normalizedLogicalType(leaf) ?? leaf.type}>`,
			nullable: node.element.repetition_type === "OPTIONAL",
		};
	}
	if (!node.element.type)
		throw new Error("Parquet column has no physical type");
	return {
		name: node.element.name,
		physical_type: node.element.type,
		logical_type: normalizedLogicalType(node.element),
		nullable: node.element.repetition_type === "OPTIONAL",
	};
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	) as ArrayBuffer;
}

export function assertParquetProjection(
	bytes: Uint8Array,
	projection: ProjectionDocument,
): void {
	try {
		if (projection.canonical_schema_id !== "cex-order-book-canonical/v1") {
			throw new Error("projection canonical identity is invalid");
		}
		const metadata = parquetMetadata(asArrayBuffer(bytes));
		if (
			JSON.stringify(metadata.key_value_metadata ?? []) !==
			JSON.stringify(projection.parquet_metadata.key_value_metadata)
		) {
			throw new Error(
				"Parquet key-value metadata differs from pinned document",
			);
		}
		const actual = topLevelColumns(metadata.schema).map(actualColumn);
		if (JSON.stringify(actual) !== JSON.stringify(projection.columns)) {
			throw new Error("Parquet projection differs from pinned document");
		}
	} catch {
		throw new ExactOrderBookExportError("parquet_projection_schema_mismatch");
	}
}

export function assertLevelsParquetProjection(bytes: Uint8Array): void {
	assertParquetProjection(
		bytes,
		ORDER_BOOK_LEVELS_PARQUET_PROJECTION as ProjectionDocument,
	);
}

export function assertDepthSummaryParquetProjection(bytes: Uint8Array): void {
	assertParquetProjection(
		bytes,
		ORDER_BOOK_DEPTH_SUMMARY_PARQUET_PROJECTION as ProjectionDocument,
	);
}
