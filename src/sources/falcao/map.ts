import type { FalcaoDocumento } from "./client";
import type { NormalizedDocument } from "../../core/documents";

const SOURCE = "falcao";

/** "DD/MM/YYYY" -> "YYYY-MM-DD". Falcão usa esse formato em dataJulgamento/dataJuntada. */
function toIsoDate(v: string | null): string | null {
  if (!v) return null;
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  return `${yyyy}-${mm}-${dd}`;
}

export function mapDocumento(doc: FalcaoDocumento, colecao: string): NormalizedDocument {
  const classeAssunto = [doc.siglaClasseProcesso, doc.classeProcesso].filter(Boolean).join(" — ") || null;

  return {
    source: SOURCE,
    sourceId: `${doc.tribunal}:${doc.idDocumentoAcordao}`,
    court: doc.tribunal,
    cdAcordao: doc.idDocumentoAcordao,
    caseNumber: doc.numeroProcesso ?? null,
    registrationNumber: null, // Falcão não tem um "registro" separado do número do processo
    ementa: doc.ementa ?? null,
    fullText: doc.textoAcordao ?? null,
    rapporteur: doc.relator ?? null,
    judgingBody: doc.turma ?? doc.gabinete ?? null,
    comarca: null, // conceito não usado pela Justiça do Trabalho (varas, não comarcas)
    classeAssunto,
    sourceDecisionType: colecao,
    judgmentDate: toIsoDate(doc.dataJulgamento),
    publicationDate: toIsoDate(doc.dataJuntada),
    officialUrl: null, // Falcão não retorna um link direto por documento nos resultados de busca
    inteiroTeorUrl: null,
    sourceCollectedAt: null, // Falcão não informa quando ele mesmo coletou o documento
    rawPayload: doc,
  };
}
