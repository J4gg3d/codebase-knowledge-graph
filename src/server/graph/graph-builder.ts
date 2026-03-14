import path from 'path';
import type { ParsedFile, GraphNode, GraphEdge, GraphData, GraphStats } from '../../shared/types.js';
import { defaultScore } from '../../shared/types.js';
import type { GitAnalysis } from '../parser/git-analyzer.js';

export function buildGraph(parsedFiles: ParsedFile[], gitData?: GitAnalysis): GraphData {
  const nodes: Map<string, GraphNode> = new Map();
  const edges: GraphEdge[] = [];
  const edgeSet = new Set<string>();

  // Build a lookup: relative path -> node id, and filename -> node id
  const pathToId = new Map<string, string>();
  const nameToId = new Map<string, string>();

  // Create file nodes
  for (const file of parsedFiles) {
    const id = normalizeId(file.relativePath);
    pathToId.set(file.relativePath.replace(/\\/g, '/'), id);
    nameToId.set(file.fileName.toLowerCase(), id);
    // Also map without extension
    const nameNoExt = file.fileName.replace(/\.[^.]+$/, '').toLowerCase();
    if (!nameToId.has(nameNoExt)) nameToId.set(nameNoExt, id);

    nodes.set(id, {
      id,
      type: file.nodeType,
      label: formatLabel(file),
      metadata: {
        filePath: file.filePath,
        fileType: file.fileType,
        headings: file.headings,
        tags: file.tags,
        wordCount: file.wordCount,
        lineCount: file.lineCount,
        codeBlockCount: file.codeBlockCount,
        linkCount: 0,
        backLinkCount: 0,
        importCount: file.imports.length,
        lastModified: file.lastModified,
        frontmatter: file.frontmatter,
        imports: file.imports,
        category: file.category,
      },
      score: defaultScore(),
    });
  }

  // Create import edges
  for (const file of parsedFiles) {
    const sourceId = normalizeId(file.relativePath);

    for (const imp of file.imports) {
      const targetId = resolveImport(imp, file.relativePath, pathToId, nameToId);
      if (!targetId || targetId === sourceId) continue;
      if (!nodes.has(targetId)) continue; // skip external packages

      addEdge(edges, edgeSet, sourceId, targetId, 'import', imp, nodes);
    }
  }

  // Create tag nodes and file->tag edges
  for (const file of parsedFiles) {
    const fileId = normalizeId(file.relativePath);

    for (const tag of file.tags) {
      const tagId = `tag:${tag}`;
      if (!nodes.has(tagId)) {
        nodes.set(tagId, {
          id: tagId,
          type: 'tag',
          label: `#${tag}`,
          metadata: { tags: [tag] },
          score: defaultScore(),
        });
      }
      addEdge(edges, edgeSet, fileId, tagId, 'shared-tag', undefined, nodes);
    }
  }

  // Create edges for wiki-links and md-links (content files)
  for (const file of parsedFiles) {
    const sourceId = normalizeId(file.relativePath);

    for (const link of file.wikiLinks) {
      const targetId = resolveContentLink(link, nameToId);
      if (!targetId || targetId === sourceId) continue;
      if (!nodes.has(targetId)) {
        // Create placeholder for unresolved references
        nodes.set(targetId, {
          id: targetId,
          type: 'content',
          label: link,
          metadata: {},
          score: defaultScore(),
        });
      }
      addEdge(edges, edgeSet, sourceId, targetId, 'wiki-link', undefined, nodes);
    }

    for (const link of file.mdLinks) {
      const targetId = resolveContentLink(link.target, nameToId) ||
        resolveImport(link.target, file.relativePath, pathToId, nameToId);
      if (!targetId || targetId === sourceId) continue;
      if (!nodes.has(targetId)) continue;
      addEdge(edges, edgeSet, sourceId, targetId, 'md-link', link.text, nodes);
    }
  }

  // Create co-change edges from git history
  if (gitData && gitData.coChanges.size > 0) {
    // Build reverse lookup: git path -> node id
    const gitPathToNodeId = new Map<string, string>();
    for (const file of parsedFiles) {
      const nodeId = normalizeId(file.relativePath);
      gitPathToNodeId.set(file.relativePath.replace(/\\/g, '/'), nodeId);
      // Also try lowercase
      gitPathToNodeId.set(file.relativePath.replace(/\\/g, '/').toLowerCase(), nodeId);
    }

    for (const [key, count] of gitData.coChanges) {
      if (count < 2) continue; // Only if changed together 2+ times
      const [pathA, pathB] = key.split('|||');

      const idA = gitPathToNodeId.get(pathA) || gitPathToNodeId.get(pathA.toLowerCase());
      const idB = gitPathToNodeId.get(pathB) || gitPathToNodeId.get(pathB.toLowerCase());

      if (idA && idB && nodes.has(idA) && nodes.has(idB) && idA !== idB) {
        const edgeId = `${idA}--co-change--${idB}`;
        if (!edgeSet.has(edgeId)) {
          edgeSet.add(edgeId);
          edges.push({
            id: edgeId,
            source: idA,
            target: idB,
            type: 'co-change',
            label: `${count}x together`,
            weight: Math.min(count / 3, 3), // Weight by frequency
          });
        }
      }
    }
  }

  const nodeArray = [...nodes.values()];
  const fileNodes = nodeArray.filter((n) => n.type !== 'tag');
  const tagNodes = nodeArray.filter((n) => n.type === 'tag');

  const stats: GraphStats = {
    totalNodes: nodeArray.length,
    totalEdges: edges.length,
    fileCount: fileNodes.length,
    tagCount: tagNodes.length,
    avgScore: 0,
    topNodes: [],
    lastIndexed: new Date().toISOString(),
  };

  return { nodes: nodeArray, edges, stats };
}

function addEdge(
  edges: GraphEdge[],
  edgeSet: Set<string>,
  source: string,
  target: string,
  type: GraphEdge['type'],
  label: string | undefined,
  nodes: Map<string, GraphNode>,
): void {
  const edgeId = `${source}--${type}--${target}`;
  if (edgeSet.has(edgeId)) return;
  edgeSet.add(edgeId);

  edges.push({ id: edgeId, source, target, type, label, weight: 1 });

  // Update link counts
  const sourceNode = nodes.get(source);
  const targetNode = nodes.get(target);
  if (sourceNode) sourceNode.metadata.linkCount = (sourceNode.metadata.linkCount || 0) + 1;
  if (targetNode) targetNode.metadata.backLinkCount = (targetNode.metadata.backLinkCount || 0) + 1;
}

function resolveImport(
  importPath: string,
  sourceRelPath: string,
  pathToId: Map<string, string>,
  nameToId: Map<string, string>,
): string | null {
  // Skip external packages
  if (!importPath.startsWith('.') && !importPath.startsWith('@/') && !importPath.startsWith('~/')) {
    return null;
  }

  // Handle @/ alias -> src/
  let resolved = importPath;
  if (resolved.startsWith('@/')) {
    resolved = 'src/' + resolved.slice(2);
  }

  // Resolve relative path
  if (resolved.startsWith('.')) {
    const sourceDir = path.dirname(sourceRelPath).replace(/\\/g, '/');
    resolved = path.posix.join(sourceDir, resolved);
  }

  // Try exact match, then with common extensions
  const normalized = resolved.replace(/\\/g, '/');
  const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '.astro', '.mjs', '.css', '.json'];

  for (const ext of extensions) {
    const tryPath = normalized + ext;
    const id = pathToId.get(tryPath);
    if (id) return id;
  }

  // Try index files
  for (const ext of extensions) {
    const tryPath = normalized + '/index' + ext;
    const id = pathToId.get(tryPath);
    if (id) return id;
  }

  // Fallback: match by filename
  const baseName = path.basename(normalized).toLowerCase();
  return nameToId.get(baseName) || null;
}

function resolveContentLink(linkTarget: string, nameToId: Map<string, string>): string | null {
  const normalized = linkTarget.toLowerCase().replace(/\.md$/, '').trim();
  return nameToId.get(normalized) || null;
}

function formatLabel(file: ParsedFile): string {
  // For blog posts with frontmatter title, show that
  if (file.frontmatter.title && typeof file.frontmatter.title === 'string') {
    const title = file.frontmatter.title;
    return title.length > 40 ? title.slice(0, 37) + '...' : title;
  }
  // For source files, show relative path for clarity
  if (['component', 'page', 'layout'].includes(file.category)) {
    return file.fileName;
  }
  // For configs, show filename
  if (file.category === 'config') {
    return file.fileName;
  }
  return file.fileName.replace(/\.[^.]+$/, '');
}

function normalizeId(relativePath: string): string {
  return relativePath
    .replace(/\\/g, '/')
    .toLowerCase()
    .trim();
}
