#!/bin/bash

bun run scripts/patch-protobufjs.js
bunx proto-loader-gen-types --grpcLib=@grpc/grpc-js --outDir=proto/ proto/*.proto

echo "✓ Done"