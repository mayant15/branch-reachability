#!/usr/bin/env python3
"""Correlation between static branch scores and dynamic V8 coverage hit counts.

Experiment
----------
The branch-reachability tool assigns every branch edge a *static score* in [0, 1]
that represents the type-theoretic entry probability under a counterfactual
parameter-type override. Each function is analyzed twice:

  *decl mode* — parameter types come from the package's ``.d.ts`` declarations.
  *any mode*  — every parameter is overridden to ``any``.

A random-input fuzzer then exercises the original JavaScript under
``NODE_V8_COVERAGE``, and the resulting V8 branch coverage is matched to edges
by source offset. The pipeline runs the fuzzer separately for each mode, so
``decl_hit_count`` and ``any_hit_count`` reflect independent random executions.

Hypotheses
----------
H₁ (within-mode):  Branches with a higher static score within a given mode are
   hit more often at runtime under that mode's coverage run.

H₂ (cross-mode):   Branches where ``any_score > decl_score`` show a larger
   positive difference in hit counts (``any_hit_count - decl_hit_count``) than
   branches where the scores are equal.  In other words, the score gap predicts
   the hit-count gap.

These are *structural* hypotheses — the score is a type-system heuristic
(constituent-count ratio), not a runtime probability.  The fuzzer exercises the
same JavaScript regardless of mode, so any hit-count differences between modes
are due to random sampling noise, not the parameter overrides.

Usage:
  python3 scripts/correlation.py [--db path/to/branch-reachability.sqlite]
"""

import math
import sqlite3
import sys
from argparse import ArgumentParser
from itertools import groupby


def pearson_r(xs: list[float], ys: list[float]) -> float | None:
    n = len(xs)
    if n < 2:
        return None
    sum_x = sum(xs)
    sum_y = sum(ys)
    denom = math.sqrt((n * sum(x * x for x in xs) - sum_x ** 2)
                      * (n * sum(y * y for y in ys) - sum_y ** 2))
    if denom == 0:
        return None
    return (n * sum(a * b for a, b in zip(xs, ys)) - sum_x * sum_y) / denom


def analyze_mode(cur, score_col: str, hit_col: str, label: str) -> None:
    """Within-mode test of H₁.

    Computes Pearson correlation between static scores and runtime hit counts
    for a single mode (decl or any).  Also shows the per-score-group mean,
    median, and how many edges were hit at least once.
    """
    cur.execute(f"""
      SELECT e.{score_col}, c.{hit_col}
      FROM edges e
      JOIN coverage c ON e.edge_id = c.edge_id
      WHERE e.{score_col} IS NOT NULL AND e.edge != 'baseline'
      ORDER BY e.{score_col}
    """)
    pairs = list(cur.fetchall())
    print(f"\n=== {label} ===")
    print(f"  Edges: {len(pairs)}")

    scores = [p[0] for p in pairs]
    hits = [p[1] for p in pairs]
    r = pearson_r(scores, hits)
    if r is not None:
        print(f"  Pearson r = {r:.4f}")
    else:
        print("  Pearson r = undefined (zero variance)")

    print(f"  Distinct scores: {len(set(scores))}")
    print(f"  Score range:     [{min(scores):.4f}, {max(scores):.4f}]")
    print(f"  Hit range:       [{min(hits)}, {max(hits)}]")

    for score_val, grp in groupby(sorted(pairs), key=lambda p: p[0]):
        grp_hits = [p[1] for p in grp]
        n = len(grp_hits)
        mean = sum(grp_hits) / n
        sorted_hits = sorted(grp_hits)
        median = (sorted_hits[n // 2] if n % 2
                  else (sorted_hits[n // 2 - 1] + sorted_hits[n // 2]) / 2)
        nonzero = sum(1 for h in grp_hits if h > 0)
        print(f"  score={score_val:.4f}  edges={n:>4d}  "
              f"mean_hits={mean:>8.2f}  median_hits={median:>7.1f}  nonzero={nonzero:>4d}")

    cur.execute(f"""
      SELECT
        CASE WHEN e.{score_col} = 0 THEN 'score=0' ELSE 'score>0' END,
        CASE WHEN c.{hit_col} > 0 THEN 'hit' ELSE 'unhit' END,
        COUNT(*)
      FROM edges e
      JOIN coverage c ON e.edge_id = c.edge_id
      WHERE e.{score_col} IS NOT NULL AND e.edge != 'baseline'
      GROUP BY 1, 2
    """)
    print("  Score > 0  vs  hit:")
    for row in cur.fetchall():
        print(f"    {row[0]:>8s}  {row[1]:>5s}  count={row[2]}")


def cross_mode_test(cur) -> None:
    """Cross-mode test of H₂.

    For each edge computes::

        score_diff = any_score - decl_score
        hit_diff   = any_hit_count - decl_hit_count

    If score_diff predicts hit_diff, edges where ``any_score > decl_score``
    should have systematically higher hit diffs than edges where scores are
    equal.  Tests this with Pearson correlation and a one-tailed Mann-Whitney U
    comparing the ``score_diff > 0`` and ``score_diff = 0`` groups.

    Limitations
    ~~~~~~~~~~~
    - The fuzzer runs the same JavaScript under both modes, so any hit-count
      difference is purely random sampling noise, not a causal effect of the
      parameter override.
    - With the current js-yaml data, only 3 of 758 edges have non-zero
      score_diff, making the test severely under-powered.
    """
    cur.execute("""
      SELECT
        e.any_score, e.decl_score,
        c.any_hit_count, c.decl_hit_count
      FROM edges e
      JOIN coverage c ON e.edge_id = c.edge_id
      WHERE e.any_score IS NOT NULL AND e.decl_score IS NOT NULL
        AND e.edge != 'baseline'
    """)
    rows = list(cur.fetchall())

    score_diffs = [r[0] - r[1] for r in rows]
    hit_diffs = [r[2] - r[3] for r in rows]

    print("\n=== Cross-mode test: does score difference explain hit difference? ===")
    print(f"  Edges: {len(rows)}")

    n = len(rows)
    any_hits = [r[2] for r in rows]
    decl_hits = [r[3] for r in rows]
    print(f"  Total any hits:  {sum(any_hits)}")
    print(f"  Total decl hits: {sum(decl_hits)}")

    # Correlation between score_diff and hit_diff
    r = pearson_r(score_diffs, hit_diffs)
    shr = "undefined (zero variance)" if r is None else f"{r:.4f}"
    print(f"  Pearson r (score_diff vs hit_diff) = {shr}")

    # Group by whether score diff is zero or positive
    groups: dict[str, list[float]] = {"score_diff=0": [], "score_diff>0": []}
    for sd, hd in zip(score_diffs, hit_diffs):
        if sd == 0:
            groups["score_diff=0"].append(hd)
        elif sd > 0:
            groups["score_diff>0"].append(hd)

    for label, hd_list in groups.items():
        n_edges = len(hd_list)
        mean_hd = sum(hd_list) / n_edges if n_edges else 0
        n_pos = sum(1 for h in hd_list if h > 0)
        n_neg = sum(1 for h in hd_list if h < 0)
        n_zero = sum(1 for h in hd_list if h == 0)
        print(f"  {label}:  edges={n_edges:>4d}  mean_hit_diff={mean_hd:>8.2f}  "
              f"pos={n_pos}  neg={n_neg}  zero={n_zero}")

    # Mann-Whitney U: do edges with score_diff>0 have higher hit_diff?
    if groups["score_diff=0"] and groups["score_diff>0"]:
        try:
            from scipy.stats import mannwhitneyu
            u_stat, p_val = mannwhitneyu(
                groups["score_diff>0"], groups["score_diff=0"], alternative="greater",
            )
            print(f"  Mann-Whitney U (score_diff>0 vs =0, greater) = {u_stat}, p = {p_val:.4f}  "
                  f"{'reject H₀' if p_val < 0.05 else 'fail to reject H₀'}")
        except ImportError:
            print("  (install scipy for Mann-Whitney U test)")

    # Show the edges where score_diff > 0
    print("\n  Edges where score_diff > 0 (any_score > decl_score):")
    cur.execute("""
      SELECT
        e.function_name, e.edge, e.classification,
        e.decl_score, e.any_score,
        c.decl_hit_count, c.any_hit_count
      FROM edges e
      JOIN coverage c ON e.edge_id = c.edge_id
      WHERE e.any_score > e.decl_score AND e.edge != 'baseline'
      ORDER BY e.function_name, e.edge
    """)
    diff_rows = cur.fetchall()
    if diff_rows:
        for r2 in diff_rows:
            print(f"    {r2[0]:>25s}  {r2[1]:>5s}  class={r2[2]:>20s}  "
                  f"decl={r2[3]:.4f}  any={r2[4]:.4f}  "
                  f"decl_hits={r2[5]}  any_hits={r2[6]}")
    else:
        print(f"    (none)")


def main() -> None:
    parser = ArgumentParser(description="Correlation between static scores and V8 coverage")
    parser.add_argument("--db", default="branch-reachability.sqlite",
                        help="Path to the SQLite database (default: branch-reachability.sqlite)")
    args = parser.parse_args()

    conn = sqlite3.connect(args.db)
    try:
        cur = conn.cursor()
        cur.execute("PRAGMA table_info(edges)")
        cols = [r[1] for r in cur.fetchall()]
        if "decl_score" in cols and "any_score" in cols:
            analyze_mode(cur, "decl_score", "decl_hit_count", "decl mode")
            analyze_mode(cur, "any_score", "any_hit_count", "any mode")
            cross_mode_test(cur)
        else:
            # Fallback for databases with the older single-score schema
            analyze_mode(cur, "prob_from_fn_entry", "decl_hit_count",
                         "single score (prob_from_fn_entry)")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
