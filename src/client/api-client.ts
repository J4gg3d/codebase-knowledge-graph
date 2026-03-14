import type { GraphData, GraphNode, GraphStats } from '../shared/types.js';

const BASE = '/api';

export async function fetchGraph(): Promise<GraphData> {
  const res = await fetch(`${BASE}/graph`);
  return res.json();
}

export async function fetchNode(id: string): Promise<{ node: GraphNode; neighbors: GraphNode[]; edges: unknown[] }> {
  const res = await fetch(`${BASE}/node/${encodeURIComponent(id)}`);
  return res.json();
}

export async function searchNodes(query: string): Promise<GraphNode[]> {
  const res = await fetch(`${BASE}/search?q=${encodeURIComponent(query)}`);
  return res.json();
}

export async function getProjectPath(): Promise<string> {
  const res = await fetch(`${BASE}/project`);
  const data = await res.json();
  return data.path;
}

export async function changeProject(newPath: string): Promise<{ status: string; path: string; stats: GraphStats; error?: string }> {
  const res = await fetch(`${BASE}/project`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: newPath }),
  });
  return res.json();
}
