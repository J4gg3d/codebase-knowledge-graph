import type { GraphData, GraphNode } from '../../shared/types.js';
import type { GitAnalysis } from '../parser/git-analyzer.js';

/**
 * Claude Code Relevance Score — 7 factors, total 0-100.
 *
 * Structural (from code):
 *   1. Connectivity   (PageRank)            0-15
 *   2. Centrality     (degree centrality)   0-15
 *   3. Content Depth  (size, complexity)     0-10
 *
 * Behavioral (from git — how Claude/devs actually use files):
 *   4. Edit Frequency (commit count)        0-20
 *   5. Recency        (git last commit)     0-15
 *   6. Co-Change Hub  (changed with many)   0-15
 *
 * Metadata:
 *   7. Tag Diversity                        0-10
 */
export function computeScores(graphData: GraphData, gitData?: GitAnalysis): void {
  const { nodes, edges } = graphData;
  if (nodes.length === 0) return;

  // Build adjacency
  const neighbors = new Map<string, Set<string>>();
  for (const node of nodes) neighbors.set(node.id, new Set());
  for (const edge of edges) {
    neighbors.get(edge.source)?.add(edge.target);
    neighbors.get(edge.target)?.add(edge.source);
  }

  // 1. Connectivity: PageRank
  const pageRank = computePageRank(nodes, edges);
  const maxPR = Math.max(...pageRank.values(), 0.001);

  // 2. Centrality: degree
  const maxDC = Math.max(...[...neighbors.values()].map((s) => s.size), 1);

  // 3. Content depth
  const maxLines = Math.max(...nodes.map((n) => n.metadata.lineCount || n.metadata.wordCount || 0), 1);

  // 4+5+6. Git-based factors
  const maxCommits = gitData
    ? Math.max(...[...gitData.fileStats.values()].map((s) => s.commitCount), 1)
    : 1;

  // Co-change hub score: how many unique files does this file get changed with?
  const coChangePartners = new Map<string, number>();
  if (gitData) {
    for (const [key, count] of gitData.coChanges) {
      if (count < 2) continue; // Only count if changed together 2+ times
      const [a, b] = key.split('|||');
      coChangePartners.set(a, (coChangePartners.get(a) || 0) + 1);
      coChangePartners.set(b, (coChangePartners.get(b) || 0) + 1);
    }
  }
  const maxCoChange = Math.max(...coChangePartners.values(), 1);

  // 7. Tags
  const maxTags = Math.max(...nodes.map((n) => n.metadata.tags?.length || 0), 1);

  const now = Date.now();

  for (const node of nodes) {
    // --- Structural ---
    const connectivity = 15 * ((pageRank.get(node.id) || 0) / maxPR);
    const centrality = 15 * ((neighbors.get(node.id)?.size || 0) / maxDC);

    const lines = node.metadata.lineCount || node.metadata.wordCount || 0;
    const hd = Math.min((node.metadata.headings?.length || 0) / 4, 1);
    const lc = Math.min((node.metadata.linkCount || 0) / 20, 1);
    const imp = Math.min((node.metadata.importCount || 0) / 10, 1);
    const contentDepth = 10 * Math.min(1,
      0.3 * Math.min(lines / 300, 1) +
      0.25 * hd +
      0.2 * lc +
      0.25 * imp
    );

    // --- Git behavioral ---
    let editFrequency = 0;
    let recency = 0;
    let coChangeHub = 0;

    // Try matching file in git stats (normalize paths)
    const gitStats = findGitStats(node, gitData);

    if (gitStats) {
      // Edit frequency: logarithmic scale (1 commit = low, 20+ = max)
      editFrequency = 20 * Math.min(Math.log(gitStats.commitCount + 1) / Math.log(maxCommits + 1), 1);

      // Recency from git (more accurate than filesystem)
      recency = 15 * Math.exp(-gitStats.daysSinceLastCommit / 30);
    } else {
      // Fallback: filesystem recency
      if (node.metadata.lastModified) {
        const daysSince = (now - new Date(node.metadata.lastModified).getTime()) / (1000 * 60 * 60 * 24);
        recency = 15 * Math.exp(-daysSince / 30);
      }
    }

    // Co-change hub: how many other files is this regularly changed with?
    const nodeRelPath = node.metadata.filePath
      ? getRelativePath(node.metadata.filePath, node.id)
      : node.id;
    const partners = coChangePartners.get(nodeRelPath) || coChangePartners.get(node.id) || 0;
    coChangeHub = 15 * Math.min(partners / maxCoChange, 1);

    // --- Metadata ---
    const tagDiversity = 10 * ((node.metadata.tags?.length || 0) / maxTags);

    const total = connectivity + centrality + contentDepth + editFrequency + recency + coChangeHub + tagDiversity;

    node.score = {
      total: round(total),
      connectivity: round(connectivity),
      centrality: round(centrality),
      contentDepth: round(contentDepth),
      recency: round(recency),
      tagDiversity: round(tagDiversity),
    };

    // Store git-specific scores in metadata for the sidebar
    if (gitStats || partners > 0) {
      (node.metadata as any).gitEditFrequency = round(editFrequency);
      (node.metadata as any).gitCoChangeHub = round(coChangeHub);
      (node.metadata as any).gitCommitCount = gitStats?.commitCount || 0;
      (node.metadata as any).gitCoChangePartners = partners;
    }
  }

  // Update stats
  const scores = nodes.map((n) => n.score.total);
  graphData.stats.avgScore = round(scores.reduce((a, b) => a + b, 0) / scores.length);
  graphData.stats.topNodes = [...nodes]
    .sort((a, b) => b.score.total - a.score.total)
    .slice(0, 10);
}

/**
 * Match a graph node to its git file stats.
 * Tries multiple path formats since git and our parser may normalize differently.
 */
function findGitStats(node: GraphNode, gitData?: GitAnalysis) {
  if (!gitData) return null;
  const stats = gitData.fileStats;

  // Try the node id directly
  if (stats.has(node.id)) return stats.get(node.id)!;

  // Try relative path variations
  const tryPaths = [
    node.id,
    node.id.replace(/\//g, '\\'),
    node.metadata.filePath?.replace(/\\/g, '/'),
  ];

  for (const p of tryPaths) {
    if (p && stats.has(p)) return stats.get(p)!;
  }

  // Fuzzy: match by filename suffix
  const nodeEnd = '/' + node.id.split('/').pop();
  for (const [gitPath, s] of stats) {
    if (gitPath.endsWith(nodeEnd)) return s;
  }

  return null;
}

function getRelativePath(filePath: string, nodeId: string): string {
  return nodeId.replace(/\\/g, '/');
}

function computePageRank(
  nodes: GraphNode[],
  edges: { source: string; target: string }[],
  dampingFactor = 0.85,
  iterations = 20
): Map<string, number> {
  const n = nodes.length;
  const rank = new Map<string, number>();
  const outLinks = new Map<string, string[]>();

  for (const node of nodes) {
    rank.set(node.id, 1 / n);
    outLinks.set(node.id, []);
  }

  for (const edge of edges) {
    outLinks.get(edge.source)?.push(edge.target);
  }

  for (let i = 0; i < iterations; i++) {
    const newRank = new Map<string, number>();
    for (const node of nodes) {
      newRank.set(node.id, (1 - dampingFactor) / n);
    }

    for (const node of nodes) {
      const out = outLinks.get(node.id) || [];
      if (out.length === 0) {
        const share = (rank.get(node.id) || 0) * dampingFactor / n;
        for (const other of nodes) {
          newRank.set(other.id, (newRank.get(other.id) || 0) + share);
        }
      } else {
        const share = (rank.get(node.id) || 0) * dampingFactor / out.length;
        for (const target of out) {
          newRank.set(target, (newRank.get(target) || 0) + share);
        }
      }
    }

    for (const [id, val] of newRank) {
      rank.set(id, val);
    }
  }

  return rank;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
