import { Router, Request, Response } from 'express';
import type { GraphData, GraphNode } from '../../shared/types.js';

export function createRouter(getGraphData: () => GraphData): Router {
  const router = Router();

  // GET /api/graph - Full graph with optional filters
  router.get('/graph', (req: Request, res: Response) => {
    const data = getGraphData();
    const { minScore, type, tag } = req.query;

    let filteredNodes = data.nodes;

    if (minScore) {
      const min = parseFloat(minScore as string);
      filteredNodes = filteredNodes.filter((n) => n.score.total >= min);
    }

    if (type) {
      filteredNodes = filteredNodes.filter((n) => n.type === type);
    }

    if (tag) {
      filteredNodes = filteredNodes.filter(
        (n) => n.metadata.tags?.includes(tag as string)
      );
    }

    const nodeIds = new Set(filteredNodes.map((n) => n.id));
    const filteredEdges = data.edges.filter(
      (e) => nodeIds.has(e.source) && nodeIds.has(e.target)
    );

    res.json({
      nodes: filteredNodes,
      edges: filteredEdges,
      stats: data.stats,
    });
  });

  // GET /api/graph/stats
  router.get('/graph/stats', (_req: Request, res: Response) => {
    const data = getGraphData();
    res.json(data.stats);
  });

  // GET /api/node/:id
  router.get('/node/:id', (req: Request, res: Response) => {
    const data = getGraphData();
    const id = decodeURIComponent(req.params.id);
    const node = data.nodes.find((n) => n.id === id);

    if (!node) {
      res.status(404).json({ error: 'Node not found' });
      return;
    }

    const connectedEdges = data.edges.filter(
      (e) => e.source === id || e.target === id
    );
    const neighborIds = new Set(
      connectedEdges.map((e) => (e.source === id ? e.target : e.source))
    );
    const neighbors = data.nodes.filter((n) => neighborIds.has(n.id));

    res.json({ node, neighbors, edges: connectedEdges });
  });

  // GET /api/node/:id/related
  router.get('/node/:id/related', (req: Request, res: Response) => {
    const data = getGraphData();
    const id = decodeURIComponent(req.params.id);
    const node = data.nodes.find((n) => n.id === id);

    if (!node) {
      res.status(404).json({ error: 'Node not found' });
      return;
    }

    // Find nodes connected within 2 hops
    const directEdges = data.edges.filter(
      (e) => e.source === id || e.target === id
    );
    const directNeighborIds = new Set(
      directEdges.map((e) => (e.source === id ? e.target : e.source))
    );

    // Also include nodes sharing the same tags
    const nodeTags = node.metadata.tags || [];
    const relatedByTags = data.nodes.filter(
      (n) =>
        n.id !== id &&
        n.metadata.tags?.some((t) => nodeTags.includes(t))
    );

    const relatedIds = new Set([
      ...directNeighborIds,
      ...relatedByTags.map((n) => n.id),
    ]);
    const related = data.nodes.filter((n) => relatedIds.has(n.id));

    res.json(related);
  });

  // GET /api/search?q=term
  router.get('/search', (req: Request, res: Response) => {
    const data = getGraphData();
    const q = ((req.query.q as string) || '').toLowerCase();

    if (!q) {
      res.json([]);
      return;
    }

    const results = data.nodes.filter(
      (n) =>
        n.label.toLowerCase().includes(q) ||
        n.metadata.headings?.some((h) => h.text.toLowerCase().includes(q)) ||
        n.metadata.tags?.some((t) => t.toLowerCase().includes(q))
    );

    res.json(results);
  });

  // GET /api/tags
  router.get('/tags', (_req: Request, res: Response) => {
    const data = getGraphData();
    const tagCounts = new Map<string, number>();

    for (const node of data.nodes) {
      if (node.metadata.tags) {
        for (const tag of node.metadata.tags) {
          tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
        }
      }
    }

    const tags = [...tagCounts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count);

    res.json(tags);
  });

  // GET /api/scores
  router.get('/scores', (_req: Request, res: Response) => {
    const data = getGraphData();
    const scores = data.nodes
      .map((n) => ({ id: n.id, label: n.label, type: n.type, score: n.score }))
      .sort((a, b) => b.score.total - a.score.total);

    res.json(scores);
  });

  // POST /api/reindex
  router.post('/reindex', async (_req: Request, res: Response) => {
    // This will be wired up to the reindex function in index.ts
    res.json({ status: 'reindex triggered' });
  });

  return router;
}
