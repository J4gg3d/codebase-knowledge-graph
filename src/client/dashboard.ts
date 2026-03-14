import { focusNode } from './graph-renderer.js';
import { showNodeDetails } from './sidebar.js';

const BASE = '/api/analytics';

const dashboard = document.getElementById('dashboard')!;
const toggle = document.getElementById('dashboard-toggle')!;
const closeBtn = document.getElementById('dashboard-close')!;
const content = document.getElementById('dashboard-content')!;
const tabs = document.querySelectorAll('.tab');

let currentTab = 'summary';

export function initDashboard() {
  toggle.addEventListener('click', () => {
    dashboard.classList.toggle('hidden');
    if (!dashboard.classList.contains('hidden')) {
      loadTab(currentTab);
    }
  });

  closeBtn.addEventListener('click', () => {
    dashboard.classList.add('hidden');
  });

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      currentTab = (tab as HTMLElement).dataset.tab || 'summary';
      loadTab(currentTab);
    });
  });
}

export function refreshDashboard() {
  if (!dashboard.classList.contains('hidden')) {
    loadTab(currentTab);
  }
}

async function loadTab(tab: string) {
  content.innerHTML = '<div style="color:#666;padding:20px;text-align:center">Lade...</div>';

  try {
    switch (tab) {
      case 'summary': await renderSummary(); break;
      case 'hotspots': await renderHotspots(); break;
      case 'orphans': await renderOrphans(); break;
      case 'cochange': await renderCoChange(); break;
    }
  } catch (err) {
    content.innerHTML = `<div style="color:#e74c3c;padding:20px">Fehler beim Laden</div>`;
  }
}

async function renderSummary() {
  const data = await fetch(`${BASE}/summary`).then((r) => r.json());

  content.innerHTML = `
    <div class="stat-grid">
      <div class="stat-box">
        <div class="number">${data.totalFiles}</div>
        <div class="label">Dateien</div>
      </div>
      <div class="stat-box">
        <div class="number">${data.avgScore}</div>
        <div class="label">Avg Score</div>
      </div>
      <div class="stat-box">
        <div class="number">${data.totalEdges}</div>
        <div class="label">Verbindungen</div>
      </div>
      <div class="stat-box">
        <div class="number">${data.hiddenDependencies}</div>
        <div class="label">Hidden Deps</div>
      </div>
    </div>

    <div class="analytics-card">
      <h4>Projekt-Gesundheit</h4>
      <div class="analytics-row">
        <span class="name">Kopplungsrisiko</span>
        <span class="health-indicator ${data.healthIndicators.couplingRisk}">${data.healthIndicators.couplingRisk}</span>
      </div>
      <div class="analytics-row">
        <span class="name">Verwaiste Dateien</span>
        <span class="health-indicator ${data.healthIndicators.orphanRisk}">${data.healthIndicators.orphanRisk}</span>
      </div>
      <div class="analytics-row">
        <span class="name">Aktualitaet</span>
        <span class="health-indicator ${data.healthIndicators.freshness}">${data.healthIndicators.freshness}</span>
      </div>
    </div>

    <div class="analytics-card">
      <h4>Wichtigste Datei</h4>
      <div style="font-size:14px;color:#4ecca3;padding:4px 0">${data.topFile}</div>
    </div>

    <div class="analytics-card">
      <h4>Dateitypen</h4>
      ${Object.entries(data.typeBreakdown)
        .sort((a: any, b: any) => b[1] - a[1])
        .map(([type, count]) => `
          <div class="analytics-row">
            <span class="name">${type}</span>
            <span class="value">${count}</span>
          </div>
        `).join('')}
    </div>

    <div class="analytics-card">
      <h4>Zahlen</h4>
      <div class="analytics-row"><span class="name">Veraltete Dateien (90+ Tage)</span><span class="value">${data.staleFiles}</span></div>
      <div class="analytics-row"><span class="name">Isolierte Dateien</span><span class="value">${data.isolatedFiles}</span></div>
    </div>
  `;
}

async function renderHotspots() {
  const data = await fetch(`${BASE}/hotspots`).then((r) => r.json());

  content.innerHTML = `
    <div class="analytics-card">
      <h4>Hot Spots — Risikobereiche</h4>
      <div class="subtitle">Dateien die oft geaendert werden UND stark vernetzt sind</div>
    </div>
    ${data.map((h: any, i: number) => `
      <div class="analytics-row" data-node-id="${h.id}" style="padding:8px 10px;border-radius:6px;margin-bottom:4px;background:rgba(255,255,255,0.02)">
        <div style="flex:1">
          <div style="color:#ccc;font-size:12px">${i + 1}. ${h.label}</div>
          <div style="color:#666;font-size:10px;margin-top:2px">${h.reason}</div>
        </div>
        <div style="text-align:right">
          <div class="${h.risk > 100 ? 'risk-high' : h.risk > 30 ? 'risk-medium' : 'risk-low'}" style="font-size:14px;font-weight:700">${h.risk}</div>
          <div style="color:#555;font-size:9px">${h.gitCommits} commits · ${h.connections} links</div>
        </div>
      </div>
    `).join('')}
  `;

  addNodeClickHandlers();
}

async function renderOrphans() {
  const data = await fetch(`${BASE}/orphans`).then((r) => r.json());

  content.innerHTML = `
    <div class="analytics-card">
      <h4>Verwaiste Dateien</h4>
      <div class="subtitle">Niedriger Score, kaum Verbindungen — toter Code?</div>
    </div>
    ${data.map((o: any) => `
      <div class="analytics-row" data-node-id="${o.id}" style="padding:6px 10px;border-radius:6px;margin-bottom:3px;background:rgba(255,255,255,0.02)">
        <div style="flex:1">
          <div style="color:#aaa;font-size:12px">${o.label}</div>
          <div style="color:#555;font-size:10px">${o.reason}</div>
        </div>
        <div style="text-align:right">
          <div style="color:#666;font-size:11px">Score ${o.score}</div>
          <div style="color:#444;font-size:9px">${o.daysSinceModified}d alt</div>
        </div>
      </div>
    `).join('')}
  `;

  addNodeClickHandlers();
}

async function renderCoChange() {
  const data = await fetch(`${BASE}/co-change`).then((r) => r.json());

  content.innerHTML = `
    <div class="stat-grid">
      <div class="stat-box">
        <div class="number">${data.total}</div>
        <div class="label">Co-Change Paare</div>
      </div>
      <div class="stat-box">
        <div class="number" style="color:#e74c3c">${data.hiddenDependencies}</div>
        <div class="label">Hidden Deps</div>
      </div>
    </div>

    ${data.hiddenDependencies > 0 ? `
      <div class="analytics-card">
        <h4>Versteckte Abhaengigkeiten</h4>
        <div class="subtitle">Dateien die zusammen geaendert werden OHNE Import-Beziehung</div>
      </div>
    ` : ''}

    ${data.pairs.slice(0, 30).map((p: any) => `
      <div class="analytics-row" style="padding:6px 10px;border-radius:6px;margin-bottom:3px;background:rgba(255,255,255,0.02)">
        <div style="flex:1">
          <div style="font-size:11px">
            <span style="color:#bbb" class="clickable-node" data-node-id="${p.source.id}">${p.source.label}</span>
            <span style="color:#444"> ↔ </span>
            <span style="color:#bbb" class="clickable-node" data-node-id="${p.target.id}">${p.target.label}</span>
            ${p.hiddenDependency ? '<span class="hidden-dep-badge">hidden</span>' : ''}
          </div>
        </div>
        <div style="color:#888;font-size:11px;white-space:nowrap">${p.label || ''}</div>
      </div>
    `).join('')}
  `;

  // Click handlers for node names
  content.querySelectorAll('.clickable-node').forEach((el) => {
    (el as HTMLElement).style.cursor = 'pointer';
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = (el as HTMLElement).dataset.nodeId!;
      focusNode(id);
      showNodeDetails(id);
    });
  });
}

function addNodeClickHandlers() {
  content.querySelectorAll('[data-node-id]').forEach((el) => {
    el.addEventListener('click', () => {
      const id = (el as HTMLElement).dataset.nodeId!;
      focusNode(id);
      showNodeDetails(id);
    });
  });
}
