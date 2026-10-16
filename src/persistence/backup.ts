import type { WorkspaceState } from '../state/workspace';
export const FORMAT='data-garden-project';
export interface Backup {format:typeof FORMAT;formatVersion:1;exportedAt:string;workspace:WorkspaceState}
export function makeBackup(workspace:WorkspaceState):Backup {return {format:FORMAT,formatVersion:1,exportedAt:new Date().toISOString(),workspace:structuredClone(workspace)};}
