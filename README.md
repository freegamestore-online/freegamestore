# FreeGameStore Storefront (ARCHIVED)

⚠️ **This repository is deprecated and no longer maintained.**

The storefront code has been consolidated into the **[freegamestore-online/platform](https://github.com/freegamestore-online/platform)** monorepo (issue #124).

## New Location

Storefront source code is now at: [`freegamestore-online/platform/sites/freegamestore/`](https://github.com/freegamestore-online/platform/tree/main/sites/freegamestore)

## Why

Consolidating all platform tools (apps, workers, packages, sites) into a single monorepo eliminates:
- Cross-repo drift (SDK/worker version mismatches)
- CI/deployment fragmentation
- Duplicate secret/dependency management

## What Happened

- Storefront source migrated to `sites/freegamestore/` via `git subtree add`
- CI now runs from the monorepo via `.github/workflows/deploy-storefront.yml`
- This standalone repo is read-only (archived)

## Old Build Instructions (Historical)

```bash
# These no longer apply — use platform monorepo instead
# node build.js     # Generates dist/ from templates + registry.json
# npm test          # Runs build + security regression tests
```

## References

- Platform consolidation plan: [PLAN-CONSOLIDATE-PLATFORM.md](https://github.com/freegamestore-online/platform/blob/main/PLAN-CONSOLIDATE-PLATFORM.md)
- Issue #124: [Fold storefront into platform monorepo](https://github.com/freegamestore-online/platform/issues/124)
- Issue #123: [Fleet CI migration](https://github.com/freegamestore-online/platform/issues/123)

---

This repository is archived and read-only. All future development happens in [freegamestore-online/platform](https://github.com/freegamestore-online/platform).
