import fs from 'fs/promises';
import path from 'path';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkFrontmatter from 'remark-frontmatter';
import { visit } from 'unist-util-visit';
import { parse as parseYaml } from 'yaml';
import type { ParsedFile, Heading, NodeType } from '../../shared/types.js';

// File extensions Claude Code would actually work with
const RELEVANT_EXTENSIONS = new Set([
  '.md', '.astro', '.ts', '.tsx', '.js', '.jsx', '.mjs',
  '.css', '.json', '.yml', '.yaml', '.html', '.svg',
  '.py', '.sh', '.sql', '.env',
]);

// Directories to skip — not useful for understanding a project
const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.claude', 'dist', 'build', '.next', '.astro',
  '.vercel', '.output', 'vendor', '__pycache__', '.svelte-kit', '.cache',
]);

// Files to skip
const IGNORE_FILES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
]);

interface MdAstNode {
  type: string;
  depth?: number;
  value?: string;
  url?: string;
  children?: MdAstNode[];
}

function extractText(node: MdAstNode): string {
  if (node.value) return node.value;
  if (node.children) return node.children.map(extractText).join('');
  return '';
}

function classifyFile(relativePath: string, ext: string): { nodeType: NodeType; category: string } {
  const rel = relativePath.replace(/\\/g, '/').toLowerCase();

  // Configs at root
  if (rel.split('/').length <= 2 && ['.json', '.mjs', '.js', '.ts', '.yml', '.yaml'].includes(ext)) {
    return { nodeType: 'config', category: 'config' };
  }
  if (rel.endsWith('.env') || rel.includes('.env.')) {
    return { nodeType: 'config', category: 'config' };
  }

  // Astro/React/Vue components
  if (rel.includes('/components/')) return { nodeType: 'component', category: 'component' };
  if (rel.includes('/layouts/')) return { nodeType: 'layout', category: 'layout' };
  if (rel.includes('/pages/')) return { nodeType: 'page', category: 'page' };

  // Content/blog
  if (rel.includes('/content/') && ext === '.md') return { nodeType: 'content', category: 'blog' };
  if (ext === '.md') return { nodeType: 'content', category: 'docs' };

  // Styles
  if (ext === '.css') return { nodeType: 'style', category: 'style' };

  // Source code
  return { nodeType: 'source', category: 'source' };
}

function extractImports(content: string): string[] {
  const imports: string[] = [];

  // ES import: import X from './path' or import './path'
  const esImports = content.matchAll(/import\s+(?:(?:[\w{}\s,*]+)\s+from\s+)?['"]([^'"]+)['"]/g);
  for (const match of esImports) {
    imports.push(match[1]);
  }

  // require()
  const requires = content.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g);
  for (const match of requires) {
    imports.push(match[1]);
  }

  // Astro component imports (same as ES but just to be thorough)
  // CSS @import
  const cssImports = content.matchAll(/@import\s+(?:url\()?['"]([^'"]+)['"]\)?/g);
  for (const match of cssImports) {
    imports.push(match[1]);
  }

  return imports;
}

function extractTagsFromContent(content: string, frontmatter: Record<string, unknown>): string[] {
  const tags = new Set<string>();

  // From frontmatter
  if (frontmatter.tags) {
    const fmTags = Array.isArray(frontmatter.tags) ? frontmatter.tags : [frontmatter.tags];
    fmTags.forEach((t: unknown) => { if (typeof t === 'string') tags.add(t); });
  }
  if (frontmatter.categories) {
    const cats = Array.isArray(frontmatter.categories) ? frontmatter.categories : [frontmatter.categories];
    cats.forEach((c: unknown) => { if (typeof c === 'string') tags.add(c); });
  }

  // Inline #tags from markdown
  const tagMatches = content.matchAll(/(?:^|\s)#([a-zA-Z0-9_-]+)/g);
  for (const match of tagMatches) {
    // Skip CSS color codes and common non-tags
    if (!/^[0-9a-f]{3,6}$/i.test(match[1])) {
      tags.add(match[1]);
    }
  }

  return [...tags];
}

async function parseMarkdownContent(content: string): Promise<{ headings: Heading[]; wikiLinks: string[]; mdLinks: { text: string; target: string }[]; frontmatter: Record<string, unknown>; wordCount: number; codeBlockCount: number }> {
  const tree = unified()
    .use(remarkParse)
    .use(remarkFrontmatter, ['yaml'])
    .parse(content);

  const headings: Heading[] = [];
  const wikiLinks: string[] = [];
  const mdLinks: { text: string; target: string }[] = [];
  let frontmatter: Record<string, unknown> = {};
  let wordCount = 0;
  let codeBlockCount = 0;

  visit(tree, (node: MdAstNode) => {
    switch (node.type) {
      case 'yaml':
        try { frontmatter = parseYaml(node.value || '') || {}; } catch { frontmatter = {}; }
        break;
      case 'heading':
        headings.push({ depth: node.depth || 1, text: extractText(node) });
        break;
      case 'text': {
        const text = node.value || '';
        wordCount += text.split(/\s+/).filter(Boolean).length;
        const wikiMatches = text.matchAll(/\[\[([^\]]+)\]\]/g);
        for (const match of wikiMatches) {
          wikiLinks.push(match[1].split('|')[0].trim());
        }
        break;
      }
      case 'link': {
        const url = node.url || '';
        if (url.endsWith('.md') || (!url.startsWith('http') && !url.startsWith('#') && !url.startsWith('mailto:'))) {
          mdLinks.push({ text: extractText(node), target: url.replace(/\.md$/, '') });
        }
        break;
      }
      case 'code':
        codeBlockCount++;
        break;
    }
  });

  return { headings, wikiLinks, mdLinks, frontmatter, wordCount, codeBlockCount };
}

async function parseSourceContent(content: string): Promise<{ wordCount: number; lineCount: number }> {
  const lines = content.split('\n');
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  const wordCount = content.split(/\s+/).filter(Boolean).length;
  return { wordCount, lineCount: nonEmpty.length };
}

export async function parseFile(filePath: string, basePath: string): Promise<ParsedFile> {
  const content = await fs.readFile(filePath, 'utf-8');
  const stat = await fs.stat(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const relativePath = path.relative(basePath, filePath);
  const fileName = path.basename(filePath);
  const { nodeType, category } = classifyFile(relativePath, ext);

  let headings: Heading[] = [];
  let wikiLinks: string[] = [];
  let mdLinks: { text: string; target: string }[] = [];
  let frontmatter: Record<string, unknown> = {};
  let wordCount = 0;
  let codeBlockCount = 0;
  let lineCount = content.split('\n').filter((l) => l.trim()).length;
  let tags: string[] = [];

  if (ext === '.md') {
    const md = await parseMarkdownContent(content);
    headings = md.headings;
    wikiLinks = md.wikiLinks;
    mdLinks = md.mdLinks;
    frontmatter = md.frontmatter;
    wordCount = md.wordCount;
    codeBlockCount = md.codeBlockCount;
    tags = extractTagsFromContent(content, frontmatter);
  } else {
    const src = await parseSourceContent(content);
    wordCount = src.wordCount;
    lineCount = src.lineCount;
  }

  // Extract imports from any text-based file
  const imports = extractImports(content);

  // For JSON config files, extract key info
  if (ext === '.json' && fileName !== 'package-lock.json') {
    try {
      const json = JSON.parse(content);
      if (json.dependencies) tags.push('has-dependencies');
      if (json.scripts) tags.push('has-scripts');
      if (json.name) frontmatter.name = json.name;
    } catch { /* ignore */ }
  }

  return {
    filePath,
    relativePath: relativePath.replace(/\\/g, '/'),
    fileName,
    fileType: ext.replace('.', ''),
    nodeType,
    headings,
    tags,
    imports,
    wikiLinks,
    mdLinks,
    frontmatter,
    wordCount,
    lineCount,
    codeBlockCount,
    lastModified: stat.mtime.toISOString(),
    category,
  };
}

export async function parseProjectDirectory(dirPath: string): Promise<ParsedFile[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true, recursive: true });

  const relevantFiles = entries
    .filter((e) => {
      if (!e.isFile()) return false;
      const fullPath = path.join(e.parentPath || e.path, e.name);
      const relativePath = path.relative(dirPath, fullPath);
      const parts = relativePath.split(path.sep);

      // Skip ignored directories
      if (parts.some((p) => IGNORE_DIRS.has(p))) return false;
      // Skip ignored files
      if (IGNORE_FILES.has(e.name)) return false;
      // Skip backup files
      if (e.name.endsWith('.bak') || e.name.endsWith('.orig')) return false;

      const ext = path.extname(e.name).toLowerCase();
      return RELEVANT_EXTENSIONS.has(ext);
    })
    .map((e) => path.join(e.parentPath || e.path, e.name));

  console.log(`Found ${relevantFiles.length} relevant project files`);
  const parsed = await Promise.all(relevantFiles.map((f) => parseFile(f, dirPath)));
  return parsed;
}

// Keep backward compatibility
export const parseMarkdownDirectory = parseProjectDirectory;
export const parseMarkdownFile = (filePath: string) => parseFile(filePath, path.dirname(filePath));
