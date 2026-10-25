# measure/ — evaluation harness

Status: **draft**. The query set in `queries.jsonl` is a **draft** set used for
smoke-checking the harness only. It is **not** the held-out (final) set and must
not be used for tuning weights or thresholds (AC2). The final held-out set is
produced separately at stage M4 by a different agent and, once produced,
replaces this file.

## Files

- `queries.jsonl` — one JSON object per line:
  `{"id": N, "query": "...", "relevant": ["skill-name", ...]}`.
  One or two reference (qrel) skill names per query. Reference names that are
  absent from the index are skipped and reported.
- `baseline.mjs` — independent BM25 (k=1.2, b=0.7) implementation over the same
  skill data (no MiniSearch). It computes recall@k over the query set.

## Usage

```sh
node measure/baseline.mjs --k 5            # recall@5 on the draft set
node measure/baseline.mjs --k 5 --verbose  # per-query hit/miss detail
```

`recall@k` = share of eligible queries where at least one reference skill is in
the top-k of the baseline ranking. Eligible = queries with at least one
reference skill present in the index.

The product's own recall@5 (from `core/`) must be **>= baseline** (AC2).
