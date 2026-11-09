export type CategoryColor = 'blue' | 'green' | 'amber' | 'purple' | 'pink' | 'slate' | 'coral';
export interface Category { id: string; name: string; color: CategoryColor }
export interface Project {
  id: string; name: string; path: string; description: string; categoryId: string;
  tags: string[]; language: string; branch: string; updatedAt: string; addedAt: string;
  lastOpenedAt: string | null; starred: boolean; archived: boolean; source: string;
}
export interface Workspace {
  token: string; platform: string; workspaceRoot: string; desktop?: boolean; executablePath?: string; dataDirectory?: string;
  projects: Project[]; categories: Category[];
  settings: { roots: string[]; maxDepth: number; terminal: 'powershell' | 'cmd' };
  lastScan?: { at: string; count: number; directoryCount: number; roots: string[] };
}
export interface ScanResult {
  scanId: string; roots: string[]; directoryCount: number; warnings: string[];
  projects: (Project & { imported: boolean })[];
}
