import { normalizeCompanyName } from './companyHistory';

export const COMPANY_CAP_K = 3;

const BLANK_BUCKET = '__blank__';

function getDateMs(postedDate: unknown): number {
  if (postedDate instanceof Date) {
    const t = postedDate.getTime();
    return Number.isNaN(t) ? -Infinity : t;
  }
  return -Infinity;
}

function jobComparator<T extends { _id: unknown; postedDate?: unknown }>(a: T, b: T): number {
  const dateA = getDateMs(a.postedDate);
  const dateB = getDateMs(b.postedDate);
  if (dateA !== dateB) {
    if (dateA === -Infinity) return 1;  // b (valid date) before a (sentinel)
    if (dateB === -Infinity) return -1; // a (valid date) before b (sentinel)
    return dateB - dateA;               // DESC: newer date first
  }
  const idA = String(a._id);
  const idB = String(b._id);
  if (idA > idB) return -1; // a comes first (newer _id)
  if (idA < idB) return 1;  // b comes first
  return 0;
}

export function capNewJobsByCompany<T extends { _id: unknown; company: string; postedDate?: unknown }>(
  jobs: T[],
  k: number = COMPANY_CAP_K
): T[] {
  const sorted = [...jobs].sort(jobComparator);
  const bucketCounts = new Map<string, number>();
  const retained: T[] = [];
  for (const job of sorted) {
    const key = normalizeCompanyName(job.company) || BLANK_BUCKET;
    const count = bucketCounts.get(key) ?? 0;
    if (count < k) {
      retained.push(job);
      bucketCounts.set(key, count + 1);
    }
  }
  return retained;
}
