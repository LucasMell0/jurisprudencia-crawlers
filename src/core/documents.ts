import { query } from "./db";

/**
 * Formato padronizado (ver adfy/sql/017_jurisprudencia_multisource.sql):
 * cada fonte mapeia seu payload bruto pra isto antes de gravar.
 * `decisionType` (canônico) NÃO é preenchido aqui — fica pra uma
 * passada de normalização via jurisprudence_decision_type_map.
 * `sourceDecisionType` é o rótulo EXATO da fonte, sem tradução.
 */
export interface NormalizedDocument {
  source: string;
  sourceId: string;
  court: string;
  cdAcordao: string;
  caseNumber: string | null;
  registrationNumber: string | null;
  ementa: string | null;
  fullText: string | null;
  rapporteur: string | null;
  judgingBody: string | null;
  comarca: string | null;
  classeAssunto: string | null;
  sourceDecisionType: string | null;
  judgmentDate: string | null; // YYYY-MM-DD
  publicationDate: string | null; // YYYY-MM-DD
  officialUrl: string | null;
  inteiroTeorUrl: string | null;
  sourceCollectedAt: string | null;
  rawPayload: unknown;
}

const COLUMNS = [
  "source",
  "source_id",
  "court",
  "cd_acordao",
  "case_number",
  "registration_number",
  "ementa",
  "full_text",
  "rapporteur",
  "judging_body",
  "comarca",
  "classe_assunto",
  "source_decision_type",
  "judgment_date",
  "publication_date",
  "official_url",
  "inteiro_teor_url",
  "source_collected_at",
  "raw_payload",
] as const;

/** Upsert em lote. Idempotente via ON CONFLICT (source, source_id). */
export async function upsertDocuments(docs: NormalizedDocument[]): Promise<number> {
  if (docs.length === 0) return 0;

  const params: unknown[] = [];
  const valuesSql: string[] = [];

  for (const d of docs) {
    const row = [
      d.source,
      d.sourceId,
      d.court,
      d.cdAcordao,
      d.caseNumber,
      d.registrationNumber,
      d.ementa,
      d.fullText,
      d.rapporteur,
      d.judgingBody,
      d.comarca,
      d.classeAssunto,
      d.sourceDecisionType,
      d.judgmentDate,
      d.publicationDate,
      d.officialUrl,
      d.inteiroTeorUrl,
      d.sourceCollectedAt,
      JSON.stringify(d.rawPayload),
    ];
    const placeholders = row.map((_, i) => `$${params.length + i + 1}`);
    valuesSql.push(`(${placeholders.join(", ")})`);
    params.push(...row);
  }

  const updateSet = COLUMNS.filter((c) => c !== "source" && c !== "source_id")
    .map((c) => `${c} = EXCLUDED.${c}`)
    .concat("updated_at = now()")
    .join(", ");

  const { rowCount } = await query(
    `INSERT INTO jurisprudence_documents (${COLUMNS.join(", ")})
     VALUES ${valuesSql.join(", ")}
     ON CONFLICT (source, source_id) DO UPDATE SET ${updateSet}`,
    params
  );

  return rowCount ?? 0;
}
