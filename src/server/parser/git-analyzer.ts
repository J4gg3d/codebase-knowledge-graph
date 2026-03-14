import { execSync } from 'child_process';
import path from 'path';

export interface GitFileStats {
  /** How many commits touched this file */
  commitCount: number;
  /** Last commit date (ISO) */
  lastCommitDate: string | null;
  /** Days since last commit */
  daysSinceLastCommit: number;
}

export interface GitAnalysis {
  /** Per-file stats: relativePath -> stats */
  fileStats: Map<string, GitFileStats>;
  /** Co-change pairs: "fileA|||fileB" -> count of commits they share */
  coChanges: Map<string, number>;
  /** Is this directory a git repo? */
  isGitRepo: boolean;
}

/**
 * Analyze git history for scoring and co-change edges.
 * Runs git commands against the given directory.
 */
export function analyzeGitHistory(dirPath: string, maxCommits = 200): GitAnalysis {
  const result: GitAnalysis = {
    fileStats: new Map(),
    coChanges: new Map(),
    isGitRepo: false,
  };

  // Check if it's a git repo
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: dirPath, stdio: 'pipe' });
    result.isGitRepo = true;
  } catch {
    console.log('Not a git repository, skipping git analysis');
    return result;
  }

  const now = Date.now();

  // 1. Get commit log with files: each commit's changed files
  try {
    const log = execSync(
      `git log --name-only --format="COMMIT_SEP %aI" -${maxCommits}`,
      { cwd: dirPath, stdio: 'pipe', maxBuffer: 10 * 1024 * 1024 }
    ).toString();

    let currentDate = '';
    let currentFiles: string[] = [];

    const lines = log.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed.startsWith('COMMIT_SEP ')) {
        // Process previous commit's files
        if (currentFiles.length > 0) {
          processCommit(result, currentFiles, currentDate, now);
        }
        currentDate = trimmed.replace('COMMIT_SEP ', '');
        currentFiles = [];
      } else if (trimmed.length > 0) {
        // Normalize path
        const normalized = trimmed.replace(/\\/g, '/');
        currentFiles.push(normalized);
      }
    }

    // Process last commit
    if (currentFiles.length > 0) {
      processCommit(result, currentFiles, currentDate, now);
    }
  } catch (err) {
    console.error('Error reading git log:', err);
  }

  console.log(`Git analysis: ${result.fileStats.size} files tracked, ${result.coChanges.size} co-change pairs`);
  return result;
}

function processCommit(
  result: GitAnalysis,
  files: string[],
  commitDate: string,
  now: number
): void {
  const daysSince = commitDate
    ? (now - new Date(commitDate).getTime()) / (1000 * 60 * 60 * 24)
    : 999;

  // Update per-file stats
  for (const file of files) {
    const existing = result.fileStats.get(file);
    if (existing) {
      existing.commitCount++;
      // Keep the most recent date
      if (daysSince < existing.daysSinceLastCommit) {
        existing.daysSinceLastCommit = daysSince;
        existing.lastCommitDate = commitDate;
      }
    } else {
      result.fileStats.set(file, {
        commitCount: 1,
        lastCommitDate: commitDate,
        daysSinceLastCommit: daysSince,
      });
    }
  }

  // Co-change: every pair of files in this commit
  // Only track if commit has 2-15 files (skip huge commits like initial imports)
  if (files.length >= 2 && files.length <= 15) {
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        const key = makeCoChangeKey(files[i], files[j]);
        result.coChanges.set(key, (result.coChanges.get(key) || 0) + 1);
      }
    }
  }
}

export function makeCoChangeKey(a: string, b: string): string {
  // Consistent ordering
  return a < b ? `${a}|||${b}` : `${b}|||${a}`;
}
