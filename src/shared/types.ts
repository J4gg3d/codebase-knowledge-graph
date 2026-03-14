export type NodeType = 'source' | 'component' | 'page' | 'layout' | 'content' | 'config' | 'style' | 'tag' | 'concept';
export type EdgeType = 'import' | 'content-ref' | 'wiki-link' | 'md-link' | 'shared-tag' | 'config-dep' | 'co-change';

export interface Heading {
  depth: number;
  text: string;
}

export interface NodeMetadata {
  filePath?: string;
  fileType?: string;
  headings?: Heading[];
  tags?: string[];
  wordCount?: number;
  codeBlockCount?: number;
  lineCount?: number;
  linkCount?: number;
  backLinkCount?: number;
  importCount?: number;
  lastModified?: string;
  frontmatter?: Record<string, unknown>;
  imports?: string[];
  category?: string; // e.g. 'component', 'page', 'blog', 'config'
}

export interface RelevanceScore {
  total: number;
  connectivity: number;
  centrality: number;
  contentDepth: number;
  recency: number;
  tagDiversity: number;
}

export interface GraphNode {
  id: string;
  type: NodeType;
  label: string;
  metadata: NodeMetadata;
  score: RelevanceScore;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: EdgeType;
  label?: string;
  weight: number;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: GraphStats;
}

export interface GraphStats {
  totalNodes: number;
  totalEdges: number;
  fileCount: number;
  tagCount: number;
  avgScore: number;
  topNodes: GraphNode[];
  lastIndexed: string;
}

export interface ParsedFile {
  filePath: string;
  relativePath: string;
  fileName: string;
  fileType: string;
  nodeType: NodeType;
  headings: Heading[];
  tags: string[];
  imports: string[];
  wikiLinks: string[];
  mdLinks: { text: string; target: string }[];
  frontmatter: Record<string, unknown>;
  wordCount: number;
  lineCount: number;
  codeBlockCount: number;
  lastModified: string;
  category: string;
}

export function defaultScore(): RelevanceScore {
  return {
    total: 0,
    connectivity: 0,
    centrality: 0,
    contentDepth: 0,
    recency: 0,
    tagDiversity: 0,
  };
}
