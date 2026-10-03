import { ProjectStates } from './types.ts';

export function adjustStageForCompleted(ps: any, cp: number | null) {
  if (ps === ProjectStates.COMPLETED) return 100;
  if (ps === ProjectStates.DOWNLOAD_READY) return 100;
  return cp;
}
