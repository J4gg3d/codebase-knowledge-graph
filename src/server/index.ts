import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { parseProjectDirectory } from './parser/markdown-parser.js';
import { analyzeGitHistory } from './parser/git-analyzer.js';
import { buildGraph } from './graph/graph-builder.js';
import { computeScores } from './graph/scoring.js';
import { createRouter } from './api/routes.js';
import { createAnalyticsRouter } from './api/analytics-controller.js';
import type { GraphData } from '../shared/types.js';

let currentDir = config.markdownDir;
let graphData: GraphData = { nodes: [], edges: [], stats: { totalNodes: 0, totalEdges: 0, fileCount: 0, tagCount: 0, avgScore: 0, topNodes: [], lastIndexed: new Date().toISOString() } };

async function reindex(): Promise<GraphData> {
  console.log(`Indexing project from: ${currentDir}`);

  // Parse files
  const parsed = await parseProjectDirectory(currentDir);
  console.log(`Parsed ${parsed.length} files`);

  // Analyze git history
  const gitData = analyzeGitHistory(currentDir);

  // Build graph with co-change edges
  graphData = buildGraph(parsed, gitData);

  // Compute scores with git data
  computeScores(graphData, gitData);

  console.log(`Graph built: ${graphData.stats.totalNodes} nodes, ${graphData.stats.totalEdges} edges (git: ${gitData.isGitRepo ? gitData.fileStats.size + ' files tracked' : 'no repo'})`);
  return graphData;
}

const app = express();
app.use(cors());
app.use(express.json());

const apiRouter = createRouter(() => graphData);

apiRouter.post('/reindex', async (_req, res) => {
  const start = Date.now();
  await reindex();
  res.json({ status: 'ok', duration: Date.now() - start, path: currentDir, stats: graphData.stats });
});

apiRouter.get('/project', (_req, res) => {
  res.json({ path: currentDir });
});

apiRouter.post('/project', async (req, res) => {
  const newPath = req.body.path;
  if (!newPath || typeof newPath !== 'string') {
    res.status(400).json({ error: 'path is required' });
    return;
  }

  const resolved = path.resolve(newPath);

  try {
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) {
      res.status(400).json({ error: 'Pfad ist kein Verzeichnis' });
      return;
    }
  } catch {
    res.status(400).json({ error: 'Verzeichnis nicht gefunden: ' + resolved });
    return;
  }

  currentDir = resolved;
  console.log(`Project changed to: ${currentDir}`);

  const start = Date.now();
  await reindex();
  res.json({ status: 'ok', path: currentDir, duration: Date.now() - start, stats: graphData.stats });
});

app.use('/api', apiRouter);
app.use('/api/analytics', createAnalyticsRouter(() => graphData));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(__dirname, '../../dist/client');
app.use(express.static(clientDir));

app.listen(config.port, () => {
  console.log(`Server running at http://localhost:${config.port}`);
  reindex().catch(console.error);
});
