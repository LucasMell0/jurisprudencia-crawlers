/**
 * Cliente HTTP pro Falcão — portal nacional de jurisprudência da
 * Justiça do Trabalho (jurisprudencia.jt.jus.br). Contrato descoberto
 * por teste direto (sem documentação oficial):
 *
 * - Sem `texto`, a busca vira match_all + filtros (dá pra enumerar
 *   tudo, não só o que bate um termo de busca).
 * - `size` só aceita 5 ou 10 (outros valores => 403 "página de tamanho
 *   não autorizado" — provavelmente whitelist dos tamanhos que a
 *   própria tela usa).
 * - Paginação profunda: só até page=19 (20 páginas). Acima disso, 403
 *   "não pode ir além da página 20" — teto fixo, não aumenta com mais
 *   filtros (apesar da mensagem sugerir o contrário).
 * - Data: `filtroRapidoData=IntervaloSelecionado&dataInicio=YYYY-MM-DD
 *   &dataFim=YYYY-MM-DD` filtra por dataJulgamento, granularidade dia.
 * - Rate limit (`x-rate-limit-remaining`) parece por nó/janela curta,
 *   não um teto diário fixo — nunca vimos 429 nos testes.
 * - Cada hit já vem com o texto integral (`textoAcordao`) e a ementa —
 *   não precisa de uma segunda chamada de "detalhe".
 */

const BASE = "https://jurisprudencia.jt.jus.br/jurisprudencia-nacional-backend/api/no-auth";
const REFERER = "https://jurisprudencia.jt.jus.br/jurisprudencia-nacional/pesquisa";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export const PAGE_SIZE = 10;
export const MAX_PAGE = 19; // páginas 0..19 => 20 páginas
export const MAX_RETRIEVABLE = (MAX_PAGE + 1) * PAGE_SIZE; // 200

const sessionId = `_${Math.random().toString(36).slice(2, 10)}`;

export class FalcaoApiError extends Error {
  constructor(
    public status: number,
    public url: string,
    public body: string
  ) {
    super(`Falcão API ${status} em ${url}: ${body.slice(0, 300)}`);
    this.name = "FalcaoApiError";
  }
}

export interface FalcaoDocumento {
  numeroProcesso: string;
  siglaClasseProcesso: string | null;
  classeProcesso: string | null;
  relator: string | null;
  tribunal: string;
  gabinete: string | null;
  turma: string | null;
  textoAcordao: string | null;
  ementa: string | null;
  possuiEmenta: "S" | "N";
  idDocumentoAcordao: string;
  referenciaLegislativa: string[] | null;
  prioridades: string[] | null;
  dataJulgamento: string | null; // DD/MM/YYYY
  dataJuntada: string | null; // DD/MM/YYYY
}

export interface FalcaoSearchResponse {
  documentos: FalcaoDocumento[];
  quantidadeTotal: number;
}

export interface FalcaoFilters {
  tribunal?: string;
  colecao: string; // acordaos | recursorevista | decisoesmonocraticas | precedentes | sentencas
  dateFrom?: string; // YYYY-MM-DD
  dateTo?: string; // YYYY-MM-DD
  /** Split extra usado quando tribunal+dia ainda excede MAX_RETRIEVABLE. */
  classe?: string;
  turma?: string;
}

function buildParams(filters: FalcaoFilters, page: number, size: number): URLSearchParams {
  const params = new URLSearchParams({
    sessionId,
    latitude: "0",
    longitude: "0",
    texto: "",
    verTodosPrecedentes: "false",
    tribunais: filters.tribunal ?? "",
    pesquisaSomenteNasEmentas: "false",
    colecao: filters.colecao,
    page: String(page),
    size: String(size),
  });
  if (filters.dateFrom && filters.dateTo) {
    params.set("filtroRapidoData", "IntervaloSelecionado");
    params.set("dataInicio", filters.dateFrom);
    params.set("dataFim", filters.dateTo);
  }
  // NOTA: nomes de parâmetro pra classe/turma ainda não confirmados ao
  // vivo — best-effort, só usado no fallback de bissecção secundária
  // (ver bisect.ts). Se a fonte não reconhecer, o filtro é ignorado
  // silenciosamente (mesmo comportamento observado com parâmetros
  // desconhecidos no restante da API) e o resultado fica maior que o
  // esperado — vale revisar se isso aparecer nos logs.
  if (filters.classe) params.set("dsClasseJudicialSigla", filters.classe);
  if (filters.turma) params.set("orgaoJulgador", filters.turma);
  return params;
}

// Sem timeout, uma conexão travada (sem resposta, sem erro) prende o
// worker indefinidamente — nada de circuit breaker ou retry ajuda se o
// fetch em si nunca resolve.
const REQUEST_TIMEOUT_MS = 20_000;

async function fetchWithRetry(url: string, maxRetries = 5): Promise<Response> {
  let attempt = 0;
  for (;;) {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          Accept: "application/json, text/plain, */*",
          Referer: REFERER,
          "Sec-Fetch-Site": "same-origin",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Dest": "empty",
          "User-Agent": USER_AGENT,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      if (attempt >= maxRetries) throw err;
      const backoffMs = Math.min(30_000, 500 * 2 ** attempt) + Math.random() * 250;
      await new Promise((r) => setTimeout(r, backoffMs));
      attempt++;
      continue;
    }

    if (res.ok) return res;

    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= maxRetries) {
      const body = await res.text().catch(() => "");
      throw new FalcaoApiError(res.status, url, body);
    }

    const backoffMs = Math.min(30_000, 500 * 2 ** attempt) + Math.random() * 250;
    await new Promise((r) => setTimeout(r, backoffMs));
    attempt++;
  }
}

export async function search(
  filters: FalcaoFilters,
  page: number,
  size: number = PAGE_SIZE
): Promise<FalcaoSearchResponse> {
  const url = `${BASE}/pesquisa?${buildParams(filters, page, size).toString()}`;
  const res = await fetchWithRetry(url);
  return (await res.json()) as FalcaoSearchResponse;
}

/** Só o total (size=5, o mínimo aceito), barato — usado pra decidir bissectar ou paginar. */
export async function fetchTotal(filters: FalcaoFilters): Promise<number> {
  const { quantidadeTotal } = await search(filters, 0, 5);
  return quantidadeTotal;
}

export interface FalcaoFiltroValor {
  valor: string;
  quantidade: number | null;
}

export interface FalcaoFiltrosResponse {
  filtrosDisponiveis: {
    nomeDoFiltro: string;
    valoresFiltro: FalcaoFiltroValor[];
  }[];
}

/**
 * Facets: tribunais/coleções/classes disponíveis + contagens pro filtro atual.
 * `colecao` é obrigatório pra API (400 "No value present" se vazio) — a
 * faceta "colecao" retornada lista todas as opções de qualquer forma.
 */
export async function getFiltros(filters: Partial<FalcaoFilters> = { colecao: "acordaos" }): Promise<FalcaoFiltrosResponse> {
  const params = new URLSearchParams({
    sessionId,
    latitude: "0",
    longitude: "0",
    texto: "",
    verTodosPrecedentes: "false",
    tribunais: filters.tribunal ?? "",
    pesquisaSomenteNasEmentas: "false",
    colecao: filters.colecao ?? "",
  });
  const url = `${BASE}/pesquisa/filtros?${params.toString()}`;
  const res = await fetchWithRetry(url);
  return (await res.json()) as FalcaoFiltrosResponse;
}

/** Lista de siglas de tribunal e coleções conhecidas — descobertas via /pesquisa/filtros. */
export async function listCourtsAndCollections(): Promise<{ courts: string[]; colecoes: string[] }> {
  const filtros = await getFiltros();
  const courts =
    filtros.filtrosDisponiveis.find((f) => f.nomeDoFiltro === "tribunal")?.valoresFiltro.map((v) => v.valor) ?? [];
  const colecoes =
    filtros.filtrosDisponiveis.find((f) => f.nomeDoFiltro === "colecao")?.valoresFiltro.map((v) => v.valor) ?? [];
  return { courts, colecoes };
}
