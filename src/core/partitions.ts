import { query, withTransaction } from "./db";

export type PartitionStatus = "pending" | "split" | "ready" | "paginating" | "done" | "error";

export interface CrawlPartition {
  id: string;
  parent_id: string | null;
  court: string;
  source_decision_type: string;
  date_from: string;
  date_to: string;
  status: PartitionStatus;
  expected_total: number | null;
  fetched_count: number;
  last_page_fetched: number | null;
  is_undated_pass: boolean;
  extra: Record<string, unknown>;
  error_message: string | null;
}

/** parent_id nulo + sem passada de mitigação = partição-raiz. */
export function isRootPartition(p: CrawlPartition): boolean {
  return p.parent_id === null && !p.is_undated_pass;
}

export interface NewPartition {
  court: string;
  sourceDecisionType: string;
  dateFrom: string;
  dateTo: string;
  extra?: Record<string, unknown>;
}

/** Semeia partições de nível 1 (court × source_decision_type). Idempotente. */
export async function seedInitialPartitions(
  source: string,
  courts: string[],
  sourceDecisionTypes: string[],
  dateFrom: string,
  dateTo: string
): Promise<number> {
  let inserted = 0;
  for (const court of courts) {
    for (const sdt of sourceDecisionTypes) {
      const { rowCount } = await query(
        `INSERT INTO jurisprudence_crawl_partitions (source, court, source_decision_type, date_from, date_to)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (source, court, source_decision_type, date_from, date_to, is_undated_pass, extra) DO NOTHING`,
        [source, court, sdt, dateFrom, dateTo]
      );
      inserted += rowCount ?? 0;
    }
  }
  return inserted;
}

/** Reivindica atomicamente a próxima partição pendente desta fonte. */
export async function claimNextPartition(source: string): Promise<CrawlPartition | null> {
  // date_from/date_to são DATE no Postgres; o driver `pg` os desserializa como
  // Date por padrão — cast explícito pra ::text (bissecção trata tudo como string).
  const { rows } = await query<CrawlPartition>(
    `UPDATE jurisprudence_crawl_partitions
        SET status = 'paginating', updated_at = now()
      WHERE id = (
        SELECT id FROM jurisprudence_crawl_partitions
         WHERE source = $1 AND status IN ('pending', 'ready', 'paginating')
         ORDER BY created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      RETURNING id, parent_id, court, source_decision_type,
                date_from::text AS date_from, date_to::text AS date_to,
                status, expected_total, fetched_count, last_page_fetched,
                is_undated_pass, extra, error_message`,
    [source]
  );
  return rows[0] ?? null;
}

/** Registra que uma partição excedeu o teto e foi dividida em filhas. */
export async function recordSplit(
  source: string,
  partitionId: string,
  children: NewPartition[]
): Promise<void> {
  await withTransaction(async (client) => {
    for (const c of children) {
      await client.query(
        `INSERT INTO jurisprudence_crawl_partitions (parent_id, source, court, source_decision_type, date_from, date_to, extra)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (source, court, source_decision_type, date_from, date_to, is_undated_pass, extra) DO NOTHING`,
        [partitionId, source, c.court, c.sourceDecisionType, c.dateFrom, c.dateTo, JSON.stringify(c.extra ?? {})]
      );
    }
    await client.query(
      `UPDATE jurisprudence_crawl_partitions SET status = 'split', updated_at = now() WHERE id = $1`,
      [partitionId]
    );
  });
}

export async function setExpectedTotal(partitionId: string, total: number): Promise<void> {
  await query(
    `UPDATE jurisprudence_crawl_partitions SET expected_total = $2, updated_at = now() WHERE id = $1`,
    [partitionId, total]
  );
}

export async function recordPageProgress(partitionId: string, page: number, hitsInPage: number): Promise<void> {
  await query(
    `UPDATE jurisprudence_crawl_partitions
        SET last_page_fetched = $2, fetched_count = fetched_count + $3, updated_at = now()
      WHERE id = $1`,
    [partitionId, page, hitsInPage]
  );
}

export async function markDone(partitionId: string): Promise<void> {
  await query(`UPDATE jurisprudence_crawl_partitions SET status = 'done', updated_at = now() WHERE id = $1`, [
    partitionId,
  ]);
}

export async function markError(partitionId: string, message: string): Promise<void> {
  await query(
    `UPDATE jurisprudence_crawl_partitions SET status = 'error', error_message = $2, updated_at = now() WHERE id = $1`,
    [partitionId, message.slice(0, 2000)]
  );
}

/** Enfileira a passada de mitigação (sem filtro de data) — uma vez por raiz que precisou bissectar. */
export async function enqueueUndatedPass(
  source: string,
  rootId: string,
  court: string,
  sourceDecisionType: string,
  dateFrom: string,
  dateTo: string
): Promise<void> {
  await query(
    `INSERT INTO jurisprudence_crawl_partitions (parent_id, source, court, source_decision_type, date_from, date_to, is_undated_pass)
     VALUES ($1, $2, $3, $4, $5, $6, true)
     ON CONFLICT (source, court, source_decision_type, date_from, date_to, is_undated_pass, extra) DO NOTHING`,
    [rootId, source, court, sourceDecisionType, dateFrom, dateTo]
  );
}

export async function getProgressSummary(
  source: string
): Promise<{ status: PartitionStatus; count: number; fetched: number }[]> {
  const { rows } = await query<{ status: PartitionStatus; count: string; fetched: string }>(
    `SELECT status, count(*) AS count, coalesce(sum(fetched_count), 0) AS fetched
       FROM jurisprudence_crawl_partitions
      WHERE source = $1
      GROUP BY status`,
    [source]
  );
  return rows.map((r) => ({ status: r.status, count: Number(r.count), fetched: Number(r.fetched) }));
}
