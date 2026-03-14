import { Router, Request, Response } from 'express';
import type { GraphData, GraphNode } from '../../shared/types.js';

export function createAnalyticsRouter(getGraphData: () => GraphData): Router {
  const router = Router();

  /**
   * GET /api/analytics/hotspots
   * Files with high edit frequency + high centrality = risk areas.
   * These are heavily used AND frequently changed — most likely to cause bugs.
   */
  router.get('/hotspots', (_req: Request, res: Response) => {
    const data = getGraphData();
    const hotspots = data.nodes
      .filter((n) => n.type !== 'tag')
      .map((n) => {
        const meta = n.metadata as any;
        const editFreq = meta.gitCommitCount || 0;
        const connections = (n.metadata.linkCount || 0) + (n.metadata.backLinkCount || 0);
        const coChangePartners = meta.gitCoChangePartners || 0;
        // Risk = edit frequency * connectivity (files that change a lot AND are central)
        const risk = editFreq * (connections + 1) * (1 + coChangePartners * 0.3);
        return {
          id: n.id,
          label: n.label,
          type: n.type,
          category: n.metadata.category,
          score: n.score.total,
          gitCommits: editFreq,
          connections,
          coChangePartners,
          risk: Math.round(risk * 10) / 10,
          reason: getRiskReason(editFreq, connections, coChangePartners),
        };
      })
      .filter((h) => h.risk > 0)
      .sort((a, b) => b.risk - a.risk)
      .slice(0, 20);

    res.json(hotspots);
  });

  /**
   * GET /api/analytics/orphans
   * Files with very low score, no imports, no recent git activity.
   * Candidates for cleanup or investigation.
   */
  router.get('/orphans', (_req: Request, res: Response) => {
    const data = getGraphData();
    const now = Date.now();

    const orphans = data.nodes
      .filter((n) => n.type !== 'tag')
      .map((n) => {
        const meta = n.metadata as any;
        const connections = (n.metadata.linkCount || 0) + (n.metadata.backLinkCount || 0);
        const imports = n.metadata.importCount || 0;
        const gitCommits = meta.gitCommitCount || 0;
        const daysSinceModified = n.metadata.lastModified
          ? (now - new Date(n.metadata.lastModified).getTime()) / (1000 * 60 * 60 * 24)
          : 999;

        return {
          id: n.id,
          label: n.label,
          type: n.type,
          category: n.metadata.category,
          score: n.score.total,
          connections,
          imports,
          gitCommits,
          daysSinceModified: Math.round(daysSinceModified),
          reason: getOrphanReason(connections, imports, gitCommits, daysSinceModified),
        };
      })
      .filter((o) => o.score < 15 && o.connections <= 1)
      .sort((a, b) => a.score - b.score)
      .slice(0, 30);

    res.json(orphans);
  });

  /**
   * GET /api/analytics/co-change
   * Files that are frequently changed together but have no direct import.
   * = hidden dependencies, refactoring candidates.
   */
  router.get('/co-change', (_req: Request, res: Response) => {
    const data = getGraphData();

    // Find co-change edges
    const coChangeEdges = data.edges.filter((e) => e.type === 'co-change');

    // Check which co-change pairs also have a direct import
    const importEdges = new Set(
      data.edges
        .filter((e) => e.type === 'import')
        .map((e) => `${e.source}|||${e.target}`)
    );

    const pairs = coChangeEdges
      .map((e) => {
        const sourceNode = data.nodes.find((n) => n.id === e.source);
        const targetNode = data.nodes.find((n) => n.id === e.target);
        const hasImport =
          importEdges.has(`${e.source}|||${e.target}`) ||
          importEdges.has(`${e.target}|||${e.source}`);
        const weight = e.weight || 1;

        return {
          source: { id: e.source, label: sourceNode?.label || e.source, type: sourceNode?.type },
          target: { id: e.target, label: targetNode?.label || e.target, type: targetNode?.type },
          coChangeCount: Math.round(weight * 3), // undo the weight normalization
          hasDirectImport: hasImport,
          hiddenDependency: !hasImport,
          label: e.label,
        };
      })
      .sort((a, b) => {
        // Hidden dependencies first, then by count
        if (a.hiddenDependency !== b.hiddenDependency) return a.hiddenDependency ? -1 : 1;
        return b.coChangeCount - a.coChangeCount;
      });

    res.json({
      total: pairs.length,
      hiddenDependencies: pairs.filter((p) => p.hiddenDependency).length,
      pairs,
    });
  });

  /**
   * GET /api/analytics/impact/:id
   * Impact analysis: if you change file X, what else is likely affected?
   * Combines import graph (direct) + co-change (behavioral).
   */
  router.get('/impact/:id', (req: Request, res: Response) => {
    const data = getGraphData();
    const id = decodeURIComponent(req.params.id);
    const node = data.nodes.find((n) => n.id === id);

    if (!node) {
      res.status(404).json({ error: 'Node not found' });
      return;
    }

    // Direct dependents: files that import this file
    const directDependents = data.edges
      .filter((e) => e.target === id && e.type === 'import')
      .map((e) => {
        const n = data.nodes.find((n) => n.id === e.source);
        return { id: e.source, label: n?.label || e.source, type: n?.type, relation: 'imports-this' as const, confidence: 1.0 };
      });

    // Files this file imports (if changed, may need changes here)
    const directDeps = data.edges
      .filter((e) => e.source === id && e.type === 'import')
      .map((e) => {
        const n = data.nodes.find((n) => n.id === e.target);
        return { id: e.target, label: n?.label || e.target, type: n?.type, relation: 'imported-by-this' as const, confidence: 0.7 };
      });

    // Co-change partners (behavioral coupling)
    const coChangePartners = data.edges
      .filter((e) => e.type === 'co-change' && (e.source === id || e.target === id))
      .map((e) => {
        const partnerId = e.source === id ? e.target : e.source;
        const n = data.nodes.find((n) => n.id === partnerId);
        const weight = e.weight || 1;
        return { id: partnerId, label: n?.label || partnerId, type: n?.type, relation: 'co-changed' as const, confidence: Math.min(weight / 3, 0.9) };
      });

    // 2nd-degree: files that import the direct dependents
    const secondDegree: typeof directDependents = [];
    const directIds = new Set(directDependents.map((d) => d.id));
    for (const dep of directDependents) {
      const transitive = data.edges
        .filter((e) => e.target === dep.id && e.type === 'import' && e.source !== id && !directIds.has(e.source))
        .map((e) => {
          const n = data.nodes.find((n) => n.id === e.source);
          return { id: e.source, label: n?.label || e.source, type: n?.type, relation: 'transitive' as const, confidence: 0.4 };
        });
      secondDegree.push(...transitive);
    }

    // Merge and deduplicate
    const allImpacted = new Map<string, typeof directDependents[0]>();
    for (const item of [...directDependents, ...directDeps, ...coChangePartners, ...secondDegree]) {
      const existing = allImpacted.get(item.id);
      if (!existing || item.confidence > existing.confidence) {
        allImpacted.set(item.id, item);
      }
    }

    const impactList = [...allImpacted.values()]
      .sort((a, b) => b.confidence - a.confidence);

    res.json({
      file: { id: node.id, label: node.label, type: node.type, score: node.score.total },
      totalImpacted: impactList.length,
      directDependents: directDependents.length,
      coChangePartners: coChangePartners.length,
      transitiveImpact: secondDegree.length,
      impacted: impactList,
    });
  });

  /**
   * GET /api/analytics/summary
   * Project health overview.
   */
  router.get('/summary', (_req: Request, res: Response) => {
    const data = getGraphData();
    const nodes = data.nodes.filter((n) => n.type !== 'tag');
    const now = Date.now();

    const scores = nodes.map((n) => n.score.total);
    const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;

    const staleCount = nodes.filter((n) => {
      if (!n.metadata.lastModified) return true;
      const days = (now - new Date(n.metadata.lastModified).getTime()) / (1000 * 60 * 60 * 24);
      return days > 90;
    }).length;

    const isolatedCount = nodes.filter((n) => {
      const links = (n.metadata.linkCount || 0) + (n.metadata.backLinkCount || 0);
      return links === 0;
    }).length;

    const coChangeEdges = data.edges.filter((e) => e.type === 'co-change');
    const importEdgeSet = new Set(
      data.edges.filter((e) => e.type === 'import').map((e) => `${e.source}|||${e.target}`)
    );
    const hiddenDeps = coChangeEdges.filter((e) =>
      !importEdgeSet.has(`${e.source}|||${e.target}`) &&
      !importEdgeSet.has(`${e.target}|||${e.source}`)
    ).length;

    const typeBreakdown: Record<string, number> = {};
    for (const n of nodes) {
      typeBreakdown[n.type] = (typeBreakdown[n.type] || 0) + 1;
    }

    res.json({
      totalFiles: nodes.length,
      avgScore: Math.round(avgScore * 10) / 10,
      topFile: nodes.sort((a, b) => b.score.total - a.score.total)[0]?.label || '-',
      staleFiles: staleCount,
      isolatedFiles: isolatedCount,
      hiddenDependencies: hiddenDeps,
      totalEdges: data.edges.length,
      typeBreakdown,
      healthIndicators: {
        couplingRisk: hiddenDeps > 10 ? 'high' : hiddenDeps > 3 ? 'medium' : 'low',
        orphanRisk: isolatedCount > nodes.length * 0.4 ? 'high' : isolatedCount > nodes.length * 0.2 ? 'medium' : 'low',
        freshness: staleCount > nodes.length * 0.5 ? 'stale' : staleCount > nodes.length * 0.2 ? 'aging' : 'fresh',
      },
    });
  });

  return router;
}

function getRiskReason(editFreq: number, connections: number, coChange: number): string {
  const reasons = [];
  if (editFreq > 10) reasons.push('sehr oft geaendert');
  else if (editFreq > 5) reasons.push('haeufig geaendert');
  if (connections > 10) reasons.push('stark vernetzt');
  if (coChange > 5) reasons.push('viele Co-Changes');
  return reasons.join(', ') || 'aktive Datei';
}

function getOrphanReason(connections: number, imports: number, gitCommits: number, days: number): string {
  const reasons = [];
  if (connections === 0) reasons.push('keine Verbindungen');
  if (imports === 0) reasons.push('keine Imports');
  if (gitCommits === 0) reasons.push('nie committed');
  if (days > 180) reasons.push('seit 6+ Monaten unberuehrt');
  else if (days > 90) reasons.push('seit 3+ Monaten unberuehrt');
  return reasons.join(', ') || 'niedriger Score';
}
