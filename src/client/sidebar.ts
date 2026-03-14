import type { GraphNode } from '../shared/types.js';
import { fetchNode } from './api-client.js';
import { focusNode } from './graph-renderer.js';

const TYPE_COLORS: Record<string, string> = {
  page:      '#4ecca3',
  component: '#3498db',
  layout:    '#9b59b6',
  content:   '#e67e22',
  config:    '#f1c40f',
  style:     '#e91e63',
  source:    '#00bcd4',
  tag:       '#7f8c8d',
};

const sidebar = document.getElementById('sidebar')!;
const titleEl = document.getElementById('sidebar-title')!;
const typeEl = document.getElementById('sidebar-type')!;
const scoreEl = document.getElementById('sidebar-score')!;
const metaEl = document.getElementById('sidebar-meta')!;
const neighborsEl = document.getElementById('sidebar-neighbors')!;
const closeBtn = document.getElementById('sidebar-close')!;

closeBtn.addEventListener('click', closeSidebar);

export function closeSidebar(): void {
  sidebar.classList.add('hidden');
}

export async function showNodeDetails(nodeId: string): Promise<void> {
  const data = await fetchNode(nodeId);
  const { node, neighbors } = data;

  sidebar.classList.remove('hidden');

  titleEl.textContent = node.label;

  const typeColor = TYPE_COLORS[node.type] || '#888';
  typeEl.textContent = node.type;
  typeEl.className = 'sidebar-badge';
  typeEl.style.background = typeColor + '33';
  typeEl.style.color = typeColor;

  // Score section
  const s = node.score;
  const meta = node.metadata as any;
  const hasGit = meta.gitCommitCount > 0 || meta.gitCoChangePartners > 0;

  scoreEl.innerHTML = `
    <h3>Relevance Score: ${s.total}</h3>
    <div style="font-size:10px;color:#555;margin-bottom:8px;text-transform:uppercase">Struktur</div>
    ${scoreBar('Connectivity', s.connectivity, 15, '#4ecca3')}
    ${scoreBar('Centrality', s.centrality, 15, '#3498db')}
    ${scoreBar('Content', s.contentDepth, 10, '#e67e22')}
    ${hasGit ? `
      <div style="font-size:10px;color:#555;margin:8px 0;text-transform:uppercase">Git-Verhalten</div>
      ${scoreBar('Edit-Freq.', meta.gitEditFrequency || 0, 20, '#f39c12')}
      ${scoreBar('Recency', s.recency, 15, '#9b59b6')}
      ${scoreBar('Co-Change', meta.gitCoChangeHub || 0, 15, '#1abc9c')}
    ` : `
      ${scoreBar('Recency', s.recency, 15, '#9b59b6')}
    `}
    <div style="font-size:10px;color:#555;margin:8px 0;text-transform:uppercase">Metadata</div>
    ${scoreBar('Tags', s.tagDiversity, 10, '#e74c3c')}
  `;

  // Metadata section
  const nodeMeta = node.metadata as any;
  let metaHtml = '<h3>Metadata</h3>';
  if (nodeMeta.filePath) metaHtml += metaItem('Pfad', nodeMeta.filePath.split(/[/\\]/).slice(-3).join('/'));
  if (nodeMeta.fileType) metaHtml += metaItem('Typ', '.' + nodeMeta.fileType);
  if (nodeMeta.category) metaHtml += metaItem('Kategorie', nodeMeta.category);
  if (nodeMeta.lineCount) metaHtml += metaItem('Zeilen', nodeMeta.lineCount);
  if (nodeMeta.wordCount) metaHtml += metaItem('Woerter', nodeMeta.wordCount);
  if (nodeMeta.headings?.length) metaHtml += metaItem('Headings', nodeMeta.headings.length);
  if (nodeMeta.linkCount) metaHtml += metaItem('Links out', nodeMeta.linkCount);
  if (nodeMeta.backLinkCount) metaHtml += metaItem('Backlinks', nodeMeta.backLinkCount);
  if (nodeMeta.importCount) metaHtml += metaItem('Imports', nodeMeta.importCount);
  if (nodeMeta.codeBlockCount) metaHtml += metaItem('Code-Bloecke', nodeMeta.codeBlockCount);
  if (nodeMeta.tags?.length) metaHtml += metaItem('Tags', nodeMeta.tags.join(', '));
  if (nodeMeta.gitCommitCount) metaHtml += metaItem('Git Commits', nodeMeta.gitCommitCount);
  if (nodeMeta.gitCoChangePartners) metaHtml += metaItem('Co-Change Partners', nodeMeta.gitCoChangePartners);
  if (nodeMeta.lastModified) metaHtml += metaItem('Geaendert', new Date(nodeMeta.lastModified).toLocaleDateString('de-DE'));
  metaEl.innerHTML = metaHtml;

  // Neighbors section
  if (neighbors.length > 0) {
    const sorted = [...neighbors].sort((a, b) => b.score.total - a.score.total);
    neighborsEl.innerHTML = `
      <h3>Verbindungen (${neighbors.length})</h3>
      ${sorted.map((n) => {
        const c = TYPE_COLORS[n.type] || '#888';
        return `
          <div class="neighbor-item" data-id="${n.id}">
            <span style="color: ${c}">${n.label}</span>
            <span style="color: #666; font-size: 11px; float: right;">${n.type} · ${n.score.total}</span>
          </div>
        `;
      }).join('')}
    `;

    neighborsEl.querySelectorAll('.neighbor-item').forEach((el) => {
      el.addEventListener('click', () => {
        const id = (el as HTMLElement).dataset.id!;
        focusNode(id);
        showNodeDetails(id);
      });
    });
  } else {
    neighborsEl.innerHTML = '';
  }
}

function scoreBar(label: string, value: number, max: number, color: string): string {
  const pct = (value / max) * 100;
  return `
    <div class="score-bar">
      <span class="label">${label}</span>
      <div class="bar">
        <div class="bar-fill" style="width: ${pct}%; background: ${color};"></div>
      </div>
      <span class="value">${value}</span>
    </div>
  `;
}

function metaItem(key: string, value: unknown): string {
  return `
    <div class="meta-item">
      <span class="key">${key}</span>
      <span class="val">${value}</span>
    </div>
  `;
}
