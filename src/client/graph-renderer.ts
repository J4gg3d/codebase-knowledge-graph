import cytoscape, { Core, NodeSingular, EdgeSingular } from 'cytoscape';
// @ts-ignore
import fcose from 'cytoscape-fcose';
import type { GraphData } from '../shared/types.js';

cytoscape.use(fcose);

let cy: Core | null = null;

export function getCy(): Core | null {
  return cy;
}

const CLUSTER_PALETTE = [
  { fill: 'rgba(100,160,255,0.75)',  glow: 'rgba(100,160,255,0.35)',  edge: 'rgba(100,160,255,0.18)',  edgeBright: 'rgba(100,160,255,0.5)' },
  { fill: 'rgba(240,120,140,0.75)',  glow: 'rgba(240,120,140,0.35)',  edge: 'rgba(240,120,140,0.18)',  edgeBright: 'rgba(240,120,140,0.5)' },
  { fill: 'rgba(160,120,220,0.75)',  glow: 'rgba(160,120,220,0.35)',  edge: 'rgba(160,120,220,0.18)',  edgeBright: 'rgba(160,120,220,0.5)' },
  { fill: 'rgba(100,210,160,0.75)',  glow: 'rgba(100,210,160,0.35)',  edge: 'rgba(100,210,160,0.18)',  edgeBright: 'rgba(100,210,160,0.5)' },
  { fill: 'rgba(240,200,80,0.75)',   glow: 'rgba(240,200,80,0.35)',   edge: 'rgba(240,200,80,0.18)',   edgeBright: 'rgba(240,200,80,0.5)' },
  { fill: 'rgba(240,160,80,0.75)',   glow: 'rgba(240,160,80,0.35)',   edge: 'rgba(240,160,80,0.18)',   edgeBright: 'rgba(240,160,80,0.5)' },
  { fill: 'rgba(80,200,220,0.75)',   glow: 'rgba(80,200,220,0.35)',   edge: 'rgba(80,200,220,0.18)',   edgeBright: 'rgba(80,200,220,0.5)' },
  { fill: 'rgba(200,200,200,0.55)',  glow: 'rgba(200,200,200,0.25)',  edge: 'rgba(200,200,200,0.12)',  edgeBright: 'rgba(200,200,200,0.4)' },
];

let nodeScores = new Map<string, number>();

/**
 * Compute connected components, ignoring tag edges.
 * Returns components sorted by size (largest first).
 */
function computeComponents(data: GraphData): { components: string[][]; clusterMap: Map<string, number> } {
  const adj = new Map<string, Set<string>>();
  for (const n of data.nodes) adj.set(n.id, new Set());

  for (const e of data.edges) {
    if (e.type === 'shared-tag') continue;
    adj.get(e.source)?.add(e.target);
    adj.get(e.target)?.add(e.source);
  }

  const visited = new Set<string>();
  const components: string[][] = [];

  for (const node of data.nodes) {
    if (visited.has(node.id)) continue;
    const queue = [node.id];
    const component: string[] = [];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      component.push(current);
      for (const neighbor of adj.get(current) || []) {
        if (!visited.has(neighbor)) queue.push(neighbor);
      }
    }
    components.push(component);
  }

  // Sort largest first
  components.sort((a, b) => b.length - a.length);

  const clusterMap = new Map<string, number>();
  components.forEach((comp, idx) => {
    for (const id of comp) clusterMap.set(id, idx);
  });

  return { components, clusterMap };
}

export function renderGraph(
  container: HTMLElement,
  data: GraphData,
  onNodeClick: (nodeId: string) => void
): Core {
  if (cy) cy.destroy();

  nodeScores = new Map();
  for (const n of data.nodes) nodeScores.set(n.id, n.score.total);

  const { components, clusterMap } = computeComponents(data);

  // Split into connected groups (>=2 nodes) and isolates (1 node)
  const connectedGroups: string[][] = [];
  const isolateIds: string[] = [];

  for (const comp of components) {
    if (comp.length >= 2) {
      connectedGroups.push(comp);
    } else {
      isolateIds.push(comp[0]);
    }
  }

  // Sort isolates by score descending for the grid
  isolateIds.sort((a, b) => (nodeScores.get(b) || 0) - (nodeScores.get(a) || 0));

  const elements: cytoscape.ElementDefinition[] = [];

  for (const node of data.nodes) {
    const cluster = clusterMap.get(node.id) || 0;
    elements.push({
      group: 'nodes',
      data: {
        id: node.id,
        label: node.label,
        type: node.type,
        score: node.score.total,
        cluster,
        category: node.metadata.category,
        isIsolate: isolateIds.includes(node.id),
      },
    });
  }

  for (const edge of data.edges) {
    const sourceCluster = clusterMap.get(edge.source) || 0;
    const srcScore = nodeScores.get(edge.source) || 0;
    const tgtScore = nodeScores.get(edge.target) || 0;
    const edgeImportance = (srcScore + tgtScore) / 2;

    elements.push({
      group: 'edges',
      data: {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: edge.type,
        weight: edge.weight,
        cluster: sourceCluster,
        importance: edgeImportance,
      },
    });
  }

  cy = cytoscape({
    container,
    elements,
    style: getStyles(),
    // Start with no layout — we do custom positioning
    layout: { name: 'preset' },
    minZoom: 0.05,
    maxZoom: 5,
    wheelSensitivity: 0.3,
  });

  // Two-zone layout: connected clusters on top, isolates grid below
  runTwoZoneLayout(connectedGroups, isolateIds);

  cy.on('zoom', () => updateEdgeWidthsOnZoom());

  cy.on('tap', 'node', (evt) => {
    onNodeClick(evt.target.id());
    highlightNode(evt.target);
  });

  cy.on('tap', (evt) => {
    if (evt.target === cy) resetHighlight();
  });

  updateEdgeWidthsOnZoom();

  return cy;
}

/**
 * Two-zone layout:
 * Zone 1 (top): Connected groups — each group laid out individually, then packed with gaps
 * Zone 2 (bottom): Isolates — sorted by score, arranged in a grid
 */
function runTwoZoneLayout(groups: string[][], isolateIds: string[]): void {
  if (!cy) return;

  // === ZONE 1: Groups — layout each separately, then pack them ===
  interface GroupBox { ids: string[]; width: number; height: number }
  const groupBoxes: GroupBox[] = [];

  for (const group of groups) {
    const groupNodes = cy.nodes().filter((n) => group.includes(n.id()));
    const groupEdges = groupNodes.connectedEdges().filter((e) =>
      group.includes(e.data('source')) && group.includes(e.data('target'))
    );
    const groupEles = groupNodes.union(groupEdges);

    // Run fcose on this group — high-score nodes get more repulsion/space
    groupEles.layout({
      name: 'fcose',
      quality: 'default',
      animate: false,
      fit: false,
      // Per-node repulsion: big nodes push harder
      nodeRepulsion: (node: any) => {
        const score = node.data('score') || 0;
        return score > 30 ? 12000 + score * 200 : 4500;
      },
      // Longer edges between important nodes
      idealEdgeLength: (edge: any) => {
        const srcScore = nodeScores.get(edge.data('source')) || 0;
        const tgtScore = nodeScores.get(edge.data('target')) || 0;
        const maxScore = Math.max(srcScore, tgtScore);
        return maxScore > 30 ? 130 + maxScore * 1.5 : 80;
      },
      edgeElasticity: () => 0.4,
      gravity: 0.4,
      gravityRange: 1.5,
      packComponents: false,
      tile: false,
      numIter: 2500,
      randomize: true,
      nodeSeparation: 75,
    } as any).run();

    const bb = groupNodes.boundingBox({});
    groupBoxes.push({ ids: group, width: bb.w, height: bb.h });
  }

  // Pack groups in a row, sorted by size (largest first), with gaps
  const GROUP_GAP = 120;
  let cursorX = 0;
  let maxGroupBottom = 0;
  // Group rows: wrap to new row if too wide
  const MAX_ROW_WIDTH = 2500;
  let rowStartX = 0;
  let rowY = 0;
  let rowMaxHeight = 0;

  for (const box of groupBoxes) {
    const groupNodes = cy!.nodes().filter((n) => box.ids.includes(n.id()));
    const bb = groupNodes.boundingBox({});

    // Check if we need a new row
    if (cursorX > rowStartX && cursorX + bb.w > MAX_ROW_WIDTH) {
      rowY += rowMaxHeight + GROUP_GAP;
      cursorX = rowStartX;
      rowMaxHeight = 0;
    }

    // Shift the entire group to its position
    const offsetX = cursorX - bb.x1;
    const offsetY = rowY - bb.y1;
    groupNodes.forEach((n) => {
      const pos = n.position();
      n.position({ x: pos.x + offsetX, y: pos.y + offsetY });
    });

    cursorX += bb.w + GROUP_GAP;
    rowMaxHeight = Math.max(rowMaxHeight, bb.h);
    maxGroupBottom = Math.max(maxGroupBottom, rowY + bb.h);
  }

  // === ZONE 2: Isolates — sorted by score, grid below groups ===
  if (isolateIds.length > 0) {
    const ISOLATE_GAP = 60;
    const ZONE_GAP = 150;
    const startY = maxGroupBottom + ZONE_GAP;
    const totalWidth = Math.max(cursorX, 800);
    const cols = Math.max(Math.floor(totalWidth / ISOLATE_GAP), 6);

    isolateIds.forEach((id, i) => {
      const node = cy!.getElementById(id);
      if (!node.length) return;
      const col = i % cols;
      const row = Math.floor(i / cols);
      node.position({
        x: col * ISOLATE_GAP + ISOLATE_GAP / 2,
        y: startY + row * ISOLATE_GAP,
      });
    });
  }

  // Fit everything
  cy.animate({
    fit: { eles: cy.elements(), padding: 50 },
  } as any, { duration: 600 } as any);
}

function updateEdgeWidthsOnZoom(): void {
  if (!cy) return;
  const zoom = cy.zoom();
  const scaleFactor = 1 / Math.pow(zoom, 0.4);

  cy.batch(() => {
    cy!.edges().forEach((edge) => {
      const base = getEdgeBaseWidth(edge);
      edge.style('width', Math.max(base * scaleFactor, 0.15));
    });
  });
}

function getEdgeBaseWidth(edge: EdgeSingular): number {
  const type = edge.data('type');
  const importance = edge.data('importance') || 0;

  let base = 0.5;
  if (type === 'import') base = 1.0;
  else if (type === 'co-change') base = 0.8;
  else if (type === 'wiki-link' || type === 'md-link') base = 0.8;
  else if (type === 'shared-tag') base = 0.25;

  if (importance > 30) {
    base += (importance - 30) / 70 * 3;
  }

  return base;
}

export function highlightNode(node: NodeSingular): void {
  if (!cy) return;
  cy.elements().removeClass('highlighted dimmed');
  const neighborhood = node.closedNeighborhood();
  neighborhood.addClass('highlighted');
  cy.elements().not(neighborhood).addClass('dimmed');
}

export function resetHighlight(): void {
  if (!cy) return;
  cy.elements().removeClass('highlighted dimmed');
}

export function focusNode(nodeId: string): void {
  if (!cy) return;
  const node = cy.getElementById(nodeId);
  if (node.length) {
    cy.animate({ center: { eles: node }, zoom: 2 } as cytoscape.AnimateOptions);
    highlightNode(node as NodeSingular);
  }
}

export function searchHighlight(nodeIds: string[]): void {
  if (!cy) return;
  cy.elements().removeClass('search-match dimmed');
  if (nodeIds.length === 0) return;
  const matchedNodes = cy.nodes().filter((n) => nodeIds.includes(n.id()));
  matchedNodes.addClass('search-match');
  cy.elements().not(matchedNodes).not(matchedNodes.connectedEdges()).addClass('dimmed');
}

export function clearSearch(): void {
  if (!cy) return;
  cy.elements().removeClass('search-match dimmed');
}

function clusterColor(ele: { data: (key: string) => unknown }) {
  const cluster = (ele.data('cluster') as number) || 0;
  return CLUSTER_PALETTE[cluster % CLUSTER_PALETTE.length];
}

function getStyles(): cytoscape.Stylesheet[] {
  return [
    {
      selector: 'node',
      style: {
        label: 'data(label)',
        'font-size': '8px',
        color: '#888',
        'text-valign': 'bottom',
        'text-margin-y': 5,
        'text-outline-width': 2,
        'text-outline-color': '#000',
        'background-color': (ele: NodeSingular) => clusterColor(ele).fill,
        'background-opacity': 0.85,
        width: (ele: NodeSingular) => getNodeSize(ele),
        height: (ele: NodeSingular) => getNodeSize(ele),
        'border-width': (ele: NodeSingular) => getGlowWidth(ele),
        'border-color': (ele: NodeSingular) => clusterColor(ele).glow,
        'border-opacity': (ele: NodeSingular) => getGlowOpacity(ele),
        'overlay-opacity': 0,
        'transition-property': 'opacity, border-width',
        'transition-duration': 200,
      } as cytoscape.Css.Node,
    },
    {
      selector: 'node[type="tag"]',
      style: { shape: 'diamond', 'font-size': '7px', 'background-opacity': 0.5, 'border-width': 0 } as cytoscape.Css.Node,
    },
    {
      selector: 'node[type="config"]',
      style: { shape: 'round-rectangle' } as cytoscape.Css.Node,
    },
    {
      selector: 'node[score < 15]',
      style: { label: '' } as cytoscape.Css.Node,
    },
    {
      selector: 'node[score >= 15][score < 40]',
      style: { 'font-size': '8px', color: '#999' } as cytoscape.Css.Node,
    },
    {
      selector: 'node[score >= 40]',
      style: { 'font-size': '10px', color: '#ddd', 'font-weight': 'bold', 'text-outline-width': 3 } as cytoscape.Css.Node,
    },

    // Edges
    {
      selector: 'edge',
      style: {
        width: 0.5,
        'line-color': (ele: EdgeSingular) => clusterColor(ele).edge,
        'curve-style': 'bezier',
        'target-arrow-shape': 'none',
        'overlay-opacity': 0,
        opacity: 0.5,
        'transition-property': 'opacity',
        'transition-duration': 200,
      } as cytoscape.Css.Edge,
    },
    {
      selector: 'edge[type="import"]',
      style: {
        'line-color': (ele: EdgeSingular) => {
          const imp = ele.data('importance') || 0;
          return imp > 30 ? clusterColor(ele).edgeBright : clusterColor(ele).edge;
        },
        'target-arrow-shape': 'triangle',
        'target-arrow-color': (ele: EdgeSingular) => {
          const imp = ele.data('importance') || 0;
          return imp > 30 ? clusterColor(ele).edgeBright : clusterColor(ele).edge;
        },
        'arrow-scale': 0.6,
        opacity: (ele: EdgeSingular) => (ele.data('importance') || 0) > 30 ? 0.85 : 0.5,
      } as cytoscape.Css.Edge,
    },
    {
      selector: 'edge[type="wiki-link"], edge[type="md-link"]',
      style: {
        'line-color': (ele: EdgeSingular) => {
          const imp = ele.data('importance') || 0;
          return imp > 30 ? clusterColor(ele).edgeBright : clusterColor(ele).edge;
        },
        'target-arrow-shape': 'triangle',
        'target-arrow-color': (ele: EdgeSingular) => {
          const imp = ele.data('importance') || 0;
          return imp > 30 ? clusterColor(ele).edgeBright : clusterColor(ele).edge;
        },
        'arrow-scale': 0.5,
        opacity: (ele: EdgeSingular) => (ele.data('importance') || 0) > 30 ? 0.75 : 0.45,
      } as cytoscape.Css.Edge,
    },
    {
      selector: 'edge[type="shared-tag"]',
      style: { width: 0.25, opacity: 0.15 } as cytoscape.Css.Edge,
    },
    // Co-change edges — dashed, shows git behavioral coupling
    {
      selector: 'edge[type="co-change"]',
      style: {
        'line-style': 'dashed',
        'line-dash-pattern': [6, 4],
        'line-color': 'rgba(241,196,15,0.35)',
        'target-arrow-shape': 'none',
        opacity: 0.6,
      } as cytoscape.Css.Edge,
    },

    // Interaction
    {
      selector: '.highlighted',
      style: { opacity: 1, 'z-index': 10 } as cytoscape.Css.Node,
    },
    {
      selector: 'edge.highlighted',
      style: { width: 2.5, opacity: 0.9 } as cytoscape.Css.Edge,
    },
    {
      selector: '.dimmed',
      style: { opacity: 0.04 } as cytoscape.Css.Node,
    },
    {
      selector: '.search-match',
      style: { 'border-width': 4, 'border-color': '#fff', 'border-opacity': 1, opacity: 1, 'z-index': 10 } as cytoscape.Css.Node,
    },
    {
      selector: 'node:active',
      style: { 'overlay-opacity': 0 } as cytoscape.Css.Node,
    },
  ];
}

function getNodeSize(ele: NodeSingular): number {
  const type = ele.data('type') as string;
  if (type === 'tag') return 10;
  const score = ele.data('score') || 0;
  return Math.min(6 + (score / 100) * 44, 40);
}

function getGlowWidth(ele: NodeSingular): number {
  const score = ele.data('score') || 0;
  if (score < 40) return 1;
  return 4 + ((score - 40) / 60) * 18;
}

function getGlowOpacity(ele: NodeSingular): number {
  const score = ele.data('score') || 0;
  if (score < 40) return 0.1;
  return 0.25 + ((score - 40) / 60) * 0.45;
}
