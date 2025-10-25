// scripts/patch-protobufjs.js
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

const file = resolve(process.cwd(), "node_modules/protobufjs/src/field.js");

let src = readFileSync(file, "utf8");
src = src.replace(/gitlookupTypeOrEnum/g, "lookupTypeOrEnum");
writeFileSync(file, src);
console.log("✓ protobufjs field.js patched");
