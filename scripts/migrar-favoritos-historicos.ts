import { migrarFavoritosHistoricos } from "../src/lib/migrarFavoritosHistoricos";

/**
 * Script de migración de favoritos heredados (`receta.favorita === true` -> `FavoritosTable`).
 * Por seguridad arranca en modo `--dry-run` (solo lectura). Para aplicar cambios reales requiere
 * pasar explícitamente `--apply` junto con TABLE_NAME y FAVORITOS_TABLE configurados.
 */
async function main() {
  const apply = process.argv.includes("--apply");
  const dryRun = !apply || process.argv.includes("--dry-run");

  if (!process.env.TABLE_NAME || !process.env.FAVORITOS_TABLE) {
    throw new Error("Debes definir TABLE_NAME y FAVORITOS_TABLE antes de ejecutar este script.");
  }

  console.info(`Iniciando migración de favoritos históricos (dryRun=${dryRun})...`);
  const resumen = await migrarFavoritosHistoricos({ dryRun });
  console.info("Resumen final:", JSON.stringify(resumen, null, 2));
}

main().catch((err) => {
  console.error("Fallo en script de migración:", err);
  process.exitCode = 1;
});
