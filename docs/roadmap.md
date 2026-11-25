# Roadmap

中文：[路线图](路线图.md)。

> Directional, not a schedule or a commitment. Priorities change with host
> releases and community feedback. What shipped is recorded in
> [CHANGELOG.md](CHANGELOG.md); what a release contains is fixed in
> [PROVENANCE.md](PROVENANCE.md).

## Shipped

| Version | Content |
| --- | --- |
| 0.3.x | Native Rust file tools with confined PTC batching; Windows x64, Linux x64 and macOS arm64. |
| 0.4.0 | Separate Native/PTC projections, scoped discovery, typed PTC outcome schema, strict TypeScript source. |
| 0.5.x | Preset rows, result cache, disk reporting, Windows Bash payload and the `ops_bash` contract. |
| 0.6.0 | First release under the name `dsh-ops-pro`, beside `dsh-ops`. |
| 1.0.0 | Architecture release: single component row, `src/adapter/dsh` host boundary, smaller PTC outcome schema, batching notices, prefix-stability suite. |
| 1.1.0 | Vendored computer-use runtime (Windows), read-only sidebar console, usage statistics. |

## Next

### Computer use

- Port the remaining upstream desktop surfaces (overlay, background desktop lane).
- Stabilise the experimental Firefox lane or drop it in favour of documented Chromium attachment.
- Real-desktop acceptance runs recorded per release in
  [manual validation](manual-validation.md).

### Platform coverage

- Windows ARM64 and Linux ARM64 targets.
- macOS 12 `CLONE_ACL` fallback, after the macOS 13+ support this release ships.

### Tool surface

- Document formats beyond the bounded DOCX/PDF subsets.
- More PTC projections and bounded result shapes.

### Release engineering

- `bin/check-release.mjs` currently needs all four staged runtimes; make a partial local run report which targets are missing instead of failing outright.
- Complete the `bench/cli.mjs tracks` subcommand, which is listed but not implemented.
- Optional detached signatures over `SHA256SUMS`; today provenance is a receipt plus checksums.

## How to influence it

Open an issue with the scenario and the tool calls it needs; the process is in
[CONTRIBUTING.md](CONTRIBUTING.md).
