#!/usr/bin/env python3
"""Independent stdlib verifier for the Maker-facing preparation v3 fixture.

The published fixture uses integers only. Rejecting floats keeps this compact
canonicalizer honest rather than pretending Python's float rendering is a full
RFC 8785 implementation.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any


def reject_floats(value: Any) -> None:
    if isinstance(value, float):
        raise ValueError("cross-language fixture must not contain floats")
    if isinstance(value, dict):
        for child in value.values():
            reject_floats(child)
    elif isinstance(value, list):
        for child in value:
            reject_floats(child)


def canonical_bytes(value: Any) -> bytes:
    reject_floats(value)
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def sha256(value: Any) -> str:
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def without_digest(document: dict[str, Any], field: str) -> dict[str, Any]:
    return {key: value for key, value in document.items() if key != field}


def assert_self_hash(document: dict[str, Any], field: str) -> str:
    expected = sha256(without_digest(document, field))
    if document.get(field) != expected:
        raise ValueError(f"{field} does not reproduce in Python")
    return expected


def load(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} is not a JSON object")
    return value


def verify(assets: Path, fixture_path: Path) -> dict[str, Any]:
    fixture = load(fixture_path)
    if fixture.get("fixture_id") != "cex-market-data-preparation-conformance/v3":
        raise ValueError("fixture is not preparation conformance v3")
    documents = fixture["documents"]
    identities = fixture["identities"]
    backfill = documents["backfill_result"]
    export_request = documents["canonical_orderbook_export_request"]
    export_result = documents["canonical_orderbook_export_result"]
    product_pin = documents["preparation_product_pin"]
    library_operations = documents["library_operations"]

    backfill_hash = assert_self_hash(backfill, "result_sha256")
    export_hash = assert_self_hash(export_result, "result_sha256")
    selection_hash = assert_self_hash(export_request["selection"], "selection_sha256")
    receipt_hash = assert_self_hash(backfill["outcome"]["receipt"], "receipt_id")
    product_pin_hash = sha256(product_pin)
    library_operations_hash = sha256(library_operations)
    if identities != {
        "manifest_sha256": identities["manifest_sha256"],
        "backfill_result_sha256": backfill_hash,
        "selection_sha256": selection_hash,
        "export_result_sha256": export_hash,
        "product_pin_sha256": product_pin_hash,
        "library_operations_sha256": library_operations_hash,
    }:
        raise ValueError("fixture identity summary does not reproduce in Python")

    manifest = load(assets / "schema-manifest.json")
    manifest_hash = assert_self_hash(manifest, "manifest_sha256")
    if manifest_hash != identities["manifest_sha256"]:
        raise ValueError("fixture and manifest identities disagree")
    schema_pins: list[dict[str, str]] = []
    for artifact in manifest["artifacts"]:
        schema = load(assets / artifact["path"])
        schema_hash = sha256(schema)
        if schema.get("$id") != artifact["schema_id"] or schema_hash != artifact["schema_sha256"]:
            raise ValueError(f"schema identity mismatch: {artifact['path']}")
        schema_pins.append(
            {"schema_id": artifact["schema_id"], "schema_sha256": schema_hash}
        )
    if len(schema_pins) != 12 or sorted(
        schema_pins, key=lambda item: item["schema_id"]
    ) != sorted(product_pin["schema_pins"], key=lambda item: item["schema_id"]):
        raise ValueError("product pin does not bind the twelve Python-verified schemas")

    policy_hashes: dict[str, str] = {}
    for name, pin_name in (
        ("capability", "capability_policy"),
        ("resource", "resource_policy"),
    ):
        policy = load(assets / "policies" / f"{name}-policy.json")
        policy_hash = assert_self_hash(policy, "policy_sha256")
        if product_pin[pin_name] != {
            "policy_id": policy["policy_id"],
            "policy_sha256": policy_hash,
        }:
            raise ValueError(f"product pin {name} policy identity disagrees")
        policy_hashes[name] = policy_hash

    source_tape_policy = load(assets / "policies" / "source-tape-capability-v1.json")
    source_tape_policy_hash = assert_self_hash(source_tape_policy, "policy_sha256")
    if product_pin["source_tape_capability"] != {
        "policy_id": source_tape_policy["policy_id"],
        "policy_sha256": source_tape_policy_hash,
    }:
        raise ValueError("product pin source-tape policy identity disagrees")
    policy_hashes["source_tape"] = source_tape_policy_hash

    descriptors = export_result["outcome"]["artifacts"]
    pins_by_id = {pin["schema_id"]: pin["schema_sha256"] for pin in schema_pins}
    for descriptor in descriptors.values():
        if pins_by_id.get(descriptor["projection_schema_id"]) != descriptor["projection_schema_sha256"]:
            raise ValueError("export descriptor projection identity disagrees")

    if backfill["capability_policy"] != product_pin["capability_policy"] or backfill["resource_policy"] != product_pin["resource_policy"]:
        raise ValueError("result and product-pin policy chains disagree")
    receipt_policies = backfill["outcome"]["receipt"]["effective_policies"]
    if receipt_policies["capability_policy"] != product_pin["capability_policy"] or receipt_policies["resource_policy"] != product_pin["resource_policy"]:
        raise ValueError("receipt and product-pin policy chains disagree")

    return {
        "fixture_id": fixture["fixture_id"],
        "manifest_sha256": manifest_hash,
        "backfill_result_sha256": backfill_hash,
        "selection_sha256": selection_hash,
        "receipt_id": receipt_hash,
        "export_result_sha256": export_hash,
        "product_pin_sha256": product_pin_hash,
        "library_operations_sha256": library_operations_hash,
        "schema_count": len(schema_pins),
        "policy_sha256": policy_hashes,
        "projection_descriptor_count": len(descriptors),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--assets", required=True, type=Path)
    parser.add_argument("--fixture", required=True, type=Path)
    arguments = parser.parse_args()
    print(
        json.dumps(
            verify(arguments.assets, arguments.fixture),
            sort_keys=True,
            separators=(",", ":"),
        )
    )


if __name__ == "__main__":
    main()
