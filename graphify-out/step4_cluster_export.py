#!/usr/bin/env python3
"""Step 4-9: Cluster graph, export to JSON + HTML, generate report, cleanup."""
import json
from pathlib import Path

# Use the correct Python that has graphify installed
import sys
sys.path.insert(0, '/Users/I570173/.local/share/uv/tools/graphifyy/lib/python3.13/site-packages')

from graphify import build_from_json, to_json, to_html
from graphify.cluster import cluster, score_all, cohesion_score
from graphify.analyze import god_nodes, surprising_connections, suggest_questions
from graphify.report import generate

# Paths
out = Path('/Users/I570173/Documents/Source/node-sdr/graphify-out')
extract_path = out / '.graphify_extract.json'
json_path = out / 'graph.json'
html_path = out / 'graph.html'
report_path = out / 'GRAPH_REPORT.md'
root = '/Users/I570173/Documents/Source/node-sdr'

# Load graph
print(f"[1/7] Loading graph from {extract_path}...")
with open(extract_path, 'r', encoding='utf-8') as f:
    extraction = json.load(f)
G = build_from_json(extraction)
print(f"  Graph: {G.number_of_nodes()} nodes, {G.number_of_edges()} edges")

# Cluster
print("[2/7] Clustering communities...")
communities = cluster(G)
n_communities = len(communities)
total_nodes = sum(len(v) for v in communities.values())
print(f"  Found {n_communities} communities covering {total_nodes} nodes")

# Compute scores for report
print("[3/7] Computing analysis scores...")
cohesion = {cid: cohesion_score(G, nodes) for cid, nodes in communities.items()}
community_labels = {cid: f"Community {cid}" for cid in communities.keys()}
god_list = god_nodes(G, top_n=10)
surprise_list = surprising_connections(G)
token_cost = {"input": 0, "output": 0}  # Not tracked in this run
detection_result = {"total_files": len(extraction.get("nodes", [])), "total_words": 0, "warning": None}
suggested = suggest_questions(G, communities, community_labels)

# Export JSON (force overwrite old file)
print(f"[4/7] Exporting to {json_path}...")
ok = to_json(G, communities, str(json_path), force=True)
print(f"  JSON export: {'OK' if ok else 'FAILED'}")

# Export HTML
print(f"[5/7] Exporting to {html_path}...")
to_html(G, communities, str(html_path))
print(f"  HTML export: OK")

# Generate report
print(f"[6/7] Generating report at {report_path}...")
report = generate(
    G, communities, cohesion, community_labels,
    god_list, surprise_list, detection_result,
    token_cost, root, suggested
)
with open(report_path, 'w', encoding='utf-8') as f:
    f.write(report)
print(f"  Report: OK")

# Cleanup temp files
print("[7/7] Cleaning up temporary files...")
temp_files = [
    '.graphify_ast.json',
    '.graphify_semantic_new.json',
    '.graphify_extract.json',
]
for fname in temp_files:
    fpath = out / fname
    if fpath.exists():
        fpath.unlink()
        print(f"  Deleted {fname}")

print("\nDone! Open graphify-out/graph.html to view the visualization.")
print(f"Report saved to {report_path}")
