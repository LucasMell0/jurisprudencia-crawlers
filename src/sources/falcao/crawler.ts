/**
 * Crawler contínuo do Falcão (jurisprudência nacional da Justiça do
 * Trabalho) -> Postgres (autosfy_db, tabelas compartilhadas com outros
 * crawlers). Estratégia: bissecção recursiva por data (granularidade
 * mínima: 1 dia) até cada partição (tribunal, coleção, [date_from,
 * date_to]) caber no teto de paginação (200 resultados). Quando um
 * único dia pra um tribunal ainda excede isso (tribunais grandes,
 * tipo TST), bissecta mais um nível por turma (órgão julgador).
 *
 * LIMITAÇÃO CONHECIDA (não verificada ainda): por analogia com o que
 * achamos no scraper do Jusfy, é possível que existam documentos sem
 * dataJulgamento preenchida, que nenhum filtro de data alcança — não
 * confirmamos isso aqui. Verificar comparando contagem final salva vs
 * os totais de /pesquisa/filtros sem filtro de data.
 */
import { search, fetchTotal, getFiltros, MAX_RETRIEVABLE, PAGE_SIZE, MAX_PAGE, FalcaoApiError } from "./client";
import type { FalcaoFilters } from "./client";
import { mapDocumento } from "./map";
import { upsertDocuments } from "../../core/documents";
import {
  seedInitialPartitions,
  claimNextPartition,
  recordSplit,
  setExpectedTotal,
  recordPageProgress,
  markDone,
  markError,
  getProgressSummary,
  type CrawlPartition,
} from "../../core/partitions";
import { splitRange } from "../../core/bisect";

function log(...args: unknown[]): void {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

function logError(...args: unknown[]): void {
  console.error(`[${new Date().toISOString()}]`, ...args);
}

function logWarn(...args: unknown[]): void {
  console.warn(`[${new Date().toISOString()}]`, ...args);
}

const SOURCE = "falcao";
// Concorrência 1 e ritmo bem mais lento que o inicial: em produção, um
// sessionId sob volume concorrente/rápido (padrão que uma sessão de
// navegador real não teria) foi bloqueado pelo sistema (403 "Tentativa
// inválida de acesso ao sistema"). A resposta correta é reduzir volume
// de verdade, não fabricar sessionIds novos pra continuar no mesmo
// ritmo — isso seria evadir o controle anti-abuso da própria fonte.
const CONCURRENCY = Number(process.env.FALCAO_CONCURRENCY ?? 1);
const REQUEST_DELAY_MS = Number(process.env.FALCAO_REQUEST_DELAY_MS ?? 3_000);
const SEED_DATE_FROM = process.env.FALCAO_SEED_FROM ?? "1988-01-01";
const IDLE_POLL_MS = 5 * 60_000;
// Quando o sistema bloquear por volume (403 genérico, fora dos casos já
// tratados como "página não autorizada"), para o worker inteiro por um
// tempo bem maior — continuar tentando é o oposto do que deveria fazer.
const ABUSE_BLOCK_PAUSE_MS = 15 * 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function filtersFor(p: CrawlPartition): FalcaoFilters {
  return {
    tribunal: p.court,
    colecao: p.source_decision_type,
    dateFrom: p.date_from,
    dateTo: p.date_to,
    classe: (p.extra?.classe as string) ?? undefined,
    turma: (p.extra?.turma as string) ?? undefined,
  };
}

async function seedIfNeeded(): Promise<void> {
  // /pesquisa/filtros exige colecao não-vazia (400 "No value present" se
  // omitido) — qualquer valor válido serve, a faceta "colecao" retornada
  // já lista todas as 5 opções com contagem, não só a que foi passada aqui.
  const filtros = await getFiltros({ colecao: "acordaos" });
  const courts =
    filtros.filtrosDisponiveis.find((f) => f.nomeDoFiltro === "tribunal")?.valoresFiltro.map((v) => v.valor) ?? [];
  const colecoes =
    filtros.filtrosDisponiveis.find((f) => f.nomeDoFiltro === "colecao")?.valoresFiltro.map((v) => v.valor) ?? [];

  if (courts.length === 0 || colecoes.length === 0) {
    throw new Error("Não consegui descobrir tribunais/coleções via /pesquisa/filtros — API pode ter mudado");
  }

  const inserted = await seedInitialPartitions(SOURCE, courts, colecoes, SEED_DATE_FROM, today());
  if (inserted > 0) {
    log(`[falcao] seed: ${inserted} novas partições-raiz criadas`);
  }
}

async function paginateAndStore(p: CrawlPartition, expectedTotal?: number): Promise<void> {
  const filters = filtersFor(p);
  const startPage = (p.last_page_fetched ?? -1) + 1;

  for (let page = startPage; page <= MAX_PAGE; page++) {
    const res = await search(filters, page, PAGE_SIZE);
    if (res.documentos.length === 0) break;

    const docs = res.documentos.map((d) => mapDocumento(d, p.source_decision_type));
    await upsertDocuments(docs);
    await recordPageProgress(p.id, page, res.documentos.length);

    const reachedExpected = expectedTotal !== undefined && (page + 1) * PAGE_SIZE >= expectedTotal;
    if (res.documentos.length < PAGE_SIZE || reachedExpected) break;

    await sleep(REQUEST_DELAY_MS);
  }

  await markDone(p.id);
}

/** Bissecção secundária por turma, usada quando um único dia ainda excede o teto. */
async function splitBySecondaryDimension(p: CrawlPartition, total: number): Promise<boolean> {
  const filtros = await getFiltros({
    tribunal: p.court,
    colecao: p.source_decision_type,
    dateFrom: p.date_from,
    dateTo: p.date_to,
  });
  const turmaFacet = filtros.filtrosDisponiveis.find((f) => f.nomeDoFiltro === "orgao_julgador");
  const values = (turmaFacet?.valoresFiltro ?? []).filter((v) => (v.quantidade ?? 0) > 0);

  if (values.length === 0) {
    logWarn(
      `[falcao] ${p.court}/${p.source_decision_type} ${p.date_from}: sem facet de turma pra bissectar ` +
        `(total=${total}) — paginando melhor-esforço (só os primeiros ${MAX_RETRIEVABLE})`
    );
    return false;
  }

  await recordSplit(
    SOURCE,
    p.id,
    values.map((v) => ({
      court: p.court,
      sourceDecisionType: p.source_decision_type,
      dateFrom: p.date_from,
      dateTo: p.date_to,
      extra: { turma: v.valor },
    }))
  );
  return true;
}

async function processPartition(p: CrawlPartition): Promise<void> {
  if (p.expected_total === null) {
    const total = await fetchTotal(filtersFor(p));
    await setExpectedTotal(p.id, total);

    if (total === 0) {
      await markDone(p.id);
      return;
    }

    if (total > MAX_RETRIEVABLE) {
      const dateSplit = splitRange(p.date_from, p.date_to);
      if (dateSplit) {
        const [[f1, t1], [f2, t2]] = dateSplit;
        await recordSplit(SOURCE, p.id, [
          { court: p.court, sourceDecisionType: p.source_decision_type, dateFrom: f1, dateTo: t1, extra: p.extra },
          { court: p.court, sourceDecisionType: p.source_decision_type, dateFrom: f2, dateTo: t2, extra: p.extra },
        ]);
        return;
      }

      // Já é um único dia — não dá mais pra bissectar por data.
      if (!p.extra?.turma) {
        const split = await splitBySecondaryDimension(p, total);
        if (split) return;
      }
      logWarn(
        `[falcao] ${p.court}/${p.source_decision_type} ${p.date_from} não bissecta mais ` +
          `(total=${total}) — paginando melhor-esforço`
      );
    }

    await paginateAndStore(p, total);
    return;
  }

  // Retomando partição já em andamento (worker reiniciado no meio).
  await paginateAndStore(p, p.expected_total);
}

// Circuit breaker compartilhado entre todos os workers: um 403 genérico
// (fora dos casos de limite de página já esperados) indica bloqueio por
// volume no sistema da fonte — resposta correta é PARAR de vez, não
// continuar tentando com outra partição ou identidade.
let abuseBlockedUntil = 0;

function isPageLimitError(err: unknown): boolean {
  return (
    err instanceof FalcaoApiError &&
    err.status === 403 &&
    (err.body.includes("tamanho") || err.body.includes("página"))
  );
}

async function worker(id: number): Promise<void> {
  for (;;) {
    if (Date.now() < abuseBlockedUntil) {
      await sleep(Math.min(30_000, abuseBlockedUntil - Date.now()));
      continue;
    }

    const partition = await claimNextPartition(SOURCE);
    if (!partition) {
      await sleep(IDLE_POLL_MS);
      continue;
    }

    try {
      await processPartition(partition);
    } catch (err) {
      if (err instanceof FalcaoApiError && err.status === 403 && !isPageLimitError(err)) {
        // Bloqueio por volume, não erro da partição em si — deixa a
        // partição como está (retomável) e para todos os workers.
        logError(
          `[falcao] worker ${id}: bloqueio (403) detectado, provavelmente por volume. ` +
            `Pausando todos os workers por ${ABUSE_BLOCK_PAUSE_MS / 60_000}min.`,
          err.message
        );
        abuseBlockedUntil = Date.now() + ABUSE_BLOCK_PAUSE_MS;
        continue;
      }

      logError(`[falcao] worker ${id}: erro na partição ${partition.id}:`, err);
      await markError(partition.id, err instanceof Error ? err.message : String(err)).catch(() => {});
    }

    await sleep(REQUEST_DELAY_MS);
  }
}

export async function runCrawlerLoop(): Promise<void> {
  try {
    await seedIfNeeded();
  } catch (err) {
    logError("[falcao] falha ao semear partições iniciais:", err);
  }

  setInterval(() => {
    getProgressSummary(SOURCE)
      .then((rows) => log("[falcao] progresso:", JSON.stringify(rows)))
      .catch(() => {});
  }, 60_000);

  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)));
}
