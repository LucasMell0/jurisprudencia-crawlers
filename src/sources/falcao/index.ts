import { runCrawlerLoop } from "./crawler";

console.log("[falcao] iniciando...");

runCrawlerLoop().catch((err) => {
  console.error("[falcao] loop principal caiu:", err);
  process.exit(1);
});

process.on("SIGTERM", () => {
  console.log("[falcao] SIGTERM — encerrando");
  process.exit(0);
});
