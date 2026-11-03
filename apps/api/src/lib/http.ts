import type { z, ZodTypeAny } from 'zod';
import { badRequest } from './errors';

export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.output<S> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const first = r.error.issues[0];
    throw badRequest(`${first.path.join('.') || 'dados'}: ${first.message}`);
  }
  return r.data;
}

export function dateRange(q: { from?: string; to?: string }) {
  const to = q.to ? new Date(`${q.to}T23:59:59.999`) : new Date();
  const from = q.from ? new Date(`${q.from}T00:00:00`) : new Date(to.getTime() - 29 * 86_400_000);
  if (!q.from) from.setHours(0, 0, 0, 0);
  return { from, to };
}
