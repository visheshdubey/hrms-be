export const DEFAULT_STAGE_COLORS = [
  '#6366f1',
  '#3b82f6',
  '#10b981',
  '#f59e0b',
  '#f43f5e',
  '#8b5cf6',
  '#64748b',
] as const;

export function defaultStageColor(orderIndex: number): string {
  return DEFAULT_STAGE_COLORS[orderIndex % DEFAULT_STAGE_COLORS.length];
}
