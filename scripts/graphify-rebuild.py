"""Rebuild the graphify knowledge graph (graphify-out/) for this repo.

graphify's `_rebuild_code(Path('.'))` has no ignore list, so in a JavaScript
workspace it crawls ~11k files under node_modules and build output and never
finishes. This wrapper filters those folders out, then runs the same rebuild.

Usage (from the repo root):  npm run graph
"""
from pathlib import Path

import graphify.extract as extract
from graphify.watch import _rebuild_code

SKIP = {"node_modules", "dist", "coverage", "test-results", "playwright-report", "graphify-out", "data"}
_collect = extract.collect_files


def collect_project_files(target: Path, **kwargs) -> list[Path]:
    root = len(target.resolve().parts)
    return [p for p in _collect(target, **kwargs) if not SKIP.intersection(p.resolve().parts[root:])]


extract.collect_files = collect_project_files

if __name__ == "__main__":
    files = collect_project_files(Path("."))
    print(f"[graphify] {len(files)} project source files")
    raise SystemExit(0 if _rebuild_code(Path(".")) else 1)
