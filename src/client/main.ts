import { fetchGraph, searchNodes, getProjectPath, changeProject } from './api-client.js';
import { renderGraph, searchHighlight, clearSearch, focusNode, getCy } from './graph-renderer.js';
import { showNodeDetails, closeSidebar } from './sidebar.js';
import { initDashboard, refreshDashboard } from './dashboard.js';
import type { GraphData } from '../shared/types.js';

const container = document.getElementById('graph-container')!;
const searchInput = document.getElementById('search-input') as HTMLInputElement;
const statsBar = document.getElementById('stats-bar')!;
const projectPath = document.getElementById('project-path') as HTMLInputElement;
const projectLoad = document.getElementById('project-load') as HTMLButtonElement;

async function loadGraph() {
  statsBar.textContent = 'Lade Graph...';
  const data = await fetchGraphWithRetry();
  displayGraph(data);
}

function displayGraph(data: GraphData) {
  statsBar.textContent = `${data.stats.fileCount} Dateien | ${data.stats.tagCount} Tags | ${data.stats.totalNodes} Nodes | ${data.stats.totalEdges} Verbindungen | Avg Score: ${data.stats.avgScore}`;

  renderGraph(container, data, async (nodeId: string) => {
    await showNodeDetails(nodeId);
  });

  setupZoomControls();
}

async function switchProject(newPath: string) {
  projectPath.classList.remove('error');
  projectPath.classList.add('loading');
  projectLoad.disabled = true;
  projectLoad.textContent = '...';
  statsBar.textContent = 'Indexiere Projekt...';

  try {
    const result = await changeProject(newPath);
    if (result.error) {
      projectPath.classList.remove('loading');
      projectPath.classList.add('error');
      statsBar.textContent = result.error;
      return;
    }

    projectPath.classList.remove('loading');
    projectPath.value = result.path;
    document.title = `Graph: ${result.path.split(/[/\\]/).pop()}`;

    const data = await fetchGraph();
    displayGraph(data);
    refreshDashboard();
  } catch (err) {
    projectPath.classList.remove('loading');
    projectPath.classList.add('error');
    statsBar.textContent = 'Fehler beim Laden des Projekts';
  } finally {
    projectLoad.disabled = false;
    projectLoad.textContent = 'Laden';
  }
}

// Project path controls
projectLoad.addEventListener('click', () => {
  const val = projectPath.value.trim();
  if (val) switchProject(val);
});

projectPath.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const val = projectPath.value.trim();
    if (val) switchProject(val);
  }
  projectPath.classList.remove('error');
});

// Search
let searchTimeout: ReturnType<typeof setTimeout>;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimeout);
  const q = searchInput.value.trim();

  if (!q) {
    clearSearch();
    closeSidebar();
    return;
  }

  searchTimeout = setTimeout(async () => {
    const results = await searchNodes(q);
    const ids = results.map((n) => n.id);
    searchHighlight(ids);

    if (ids.length === 1) {
      focusNode(ids[0]);
      await showNodeDetails(ids[0]);
    }
  }, 300);
});

// Escape to clear
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    searchInput.value = '';
    clearSearch();
    closeSidebar();
  }
});

function setupZoomControls() {
  const slider = document.getElementById('zoom-slider') as HTMLInputElement;
  const zoomIn = document.getElementById('zoom-in')!;
  const zoomOut = document.getElementById('zoom-out')!;
  const zoomFit = document.getElementById('zoom-fit')!;

  function updateSlider() {
    const cy = getCy();
    if (!cy) return;
    slider.value = String(Math.round(cy.zoom() * 100));
  }

  const cy = getCy();
  if (cy) {
    cy.on('zoom', updateSlider);
    updateSlider();
  }

  slider.oninput = () => {
    const cy = getCy();
    if (!cy) return;
    cy.zoom({ level: parseInt(slider.value) / 100, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
  };

  zoomIn.onclick = () => {
    const cy = getCy();
    if (!cy) return;
    cy.animate({ zoom: { level: Math.min(cy.zoom() * 1.3, 5), renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } } } as any, { duration: 200 } as any);
  };

  zoomOut.onclick = () => {
    const cy = getCy();
    if (!cy) return;
    cy.animate({ zoom: { level: Math.max(cy.zoom() / 1.3, 0.1), renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } } } as any, { duration: 200 } as any);
  };

  zoomFit.onclick = () => {
    const cy = getCy();
    if (!cy) return;
    cy.animate({ fit: { eles: cy.elements(), padding: 50 } } as any, { duration: 400 } as any);
  };
}

async function fetchGraphWithRetry(maxRetries = 10): Promise<GraphData> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const data = await fetchGraph();
      if (data && data.nodes) return data;
    } catch { /* server not ready */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Server nicht erreichbar');
}

// Init
async function init() {
  // Load current project path from server
  try {
    const currentPath = await getProjectPath();
    projectPath.value = currentPath;
    document.title = `Graph: ${currentPath.split(/[/\\]/).pop()}`;
  } catch { /* will be set after graph loads */ }

  await loadGraph();
  initDashboard();
}

init().catch(console.error);
