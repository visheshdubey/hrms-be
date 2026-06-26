import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../config.js';

export interface PaginationParams {
  page: number;
  pageSize: number;
  offset: number;
}

export function parsePagination(query: {
  page?: string | null;
  pageSize?: string | null;
}): PaginationParams {
  const page = Math.max(1, parseInt(query.page ?? '1', 10) || 1);
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, parseInt(query.pageSize ?? String(DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE),
  );

  return { page, pageSize, offset: (page - 1) * pageSize };
}

export function paginateInMemory<T>(
  items: T[],
  page: number,
  pageSize: number,
): { data: T[]; total: number; page: number; pageSize: number } {
  const total = items.length;
  const start = (page - 1) * pageSize;

  return {
    data: items.slice(start, start + pageSize),
    total,
    page,
    pageSize,
  };
}
