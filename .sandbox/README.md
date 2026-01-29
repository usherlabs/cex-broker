# Sandbox

The `CEX Broker` is one of the services running in `Fiet Sandbox`. A sandbox-specific Docker image is published to GHCR (GitHub Container Registry) and can be pulled as `ghcr.io/usherlabs/fiet-sandbox/cex-broker:[version]`

To publish a new version of the Docker image just push a tag in the format `sandbox-v0.1.0` to the repository and the corresponding workflow [publish-sandbox.yml](../.github/workflows/publish-sandbox.yml) will do its job.

The `.sandbox` directory contains all the resources needed to build a sandbox-specific image.
