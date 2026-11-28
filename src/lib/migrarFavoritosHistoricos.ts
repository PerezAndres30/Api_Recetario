import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, FAVORITOS_TABLE, TABLE } from "./clients";
import { transactWriteConReintentos, type OpcionesReintentoBatch } from "./dynamo";
import { buscarReceta } from "./recetas";
import type { FavoritoItem, Receta } from "./schema";

export interface ResultadoMigracionFavoritos {
  dryRun: boolean;
  analizadas: number;
  elegibles: number;
  migradas: number;
  yaExistentesEnFavoritos: number;
  omitidasPorProteccion: number;
  omitidasInexistentes: number;
  errores: number;
  recetasElegiblesIds: string[];
}

export interface OpcionesMigracionFavoritos extends OpcionesReintentoBatch {
  dryRun?: boolean;
  log?: (mensaje: string) => void;
}

/**
 * Migra de forma segura e idempotente el campo heredado `receta.favorita === true`
 * hacia la colección privada `FavoritosTable` del creador de cada receta:
 * - Recorre `RecetasTable` con paginación completa (`ExclusiveStartKey`).
 * - No modifica ni sobrescribe `receta.favorita` para conservar compatibilidad temporal.
 * - Verifica existencia real de la receta en transacción.
 * - Marca `favoritaMigradaEn` en `RecetasTable`: si el usuario quita después el favorito de
 *   `FavoritosTable`, re-ejecutar el script NUNCA lo volverá a reintroducir.
 */
export async function migrarFavoritosHistoricos(
  opciones: OpcionesMigracionFavoritos = {},
): Promise<ResultadoMigracionFavoritos> {
  const dryRun = opciones.dryRun ?? true;
  const log = opciones.log ?? console.info;

  const resultado: ResultadoMigracionFavoritos = {
    dryRun,
    analizadas: 0,
    elegibles: 0,
    migradas: 0,
    yaExistentesEnFavoritos: 0,
    omitidasPorProteccion: 0,
    omitidasInexistentes: 0,
    errores: 0,
    recetasElegiblesIds: [],
  };

  let lastKey: Record<string, unknown> | undefined;
  do {
    const scan = await ddb.send(
      new ScanCommand({
        TableName: TABLE,
        ExclusiveStartKey: lastKey,
      }),
    );

    const lote = (scan.Items ?? []) as Receta[];
    for (const item of lote) {
      resultado.analizadas += 1;
      if (item.favorita !== true) continue;
      if (item.favoritaMigradaEn) {
        resultado.omitidasPorProteccion += 1;
        continue;
      }

      resultado.elegibles += 1;
      resultado.recetasElegiblesIds.push(item.recetaId);

      if (dryRun) continue;

      const vigente = await buscarReceta(item.recetaId);
      if (!vigente) {
        resultado.omitidasInexistentes += 1;
        continue;
      }
      if (vigente.favoritaMigradaEn) {
        resultado.omitidasPorProteccion += 1;
        continue;
      }

      const ahora = new Date().toISOString();
      const favItem: FavoritoItem = {
        userId: vigente.userId,
        recetaId: vigente.recetaId,
        recetaUserId: vigente.userId,
        guardadaEn: vigente.actualizadaEn || vigente.creadaEn || ahora,
      };

      try {
        await transactWriteConReintentos(
          {
            TransactItems: [
              {
                Update: {
                  TableName: TABLE,
                  Key: { userId: vigente.userId, recetaId: vigente.recetaId },
                  UpdateExpression: "SET favoritaMigradaEn = :ahora",
                  ConditionExpression: "attribute_exists(recetaId) AND attribute_not_exists(favoritaMigradaEn)",
                  ExpressionAttributeValues: { ":ahora": ahora },
                },
              },
              {
                Put: {
                  TableName: FAVORITOS_TABLE,
                  Item: favItem,
                  ConditionExpression: "attribute_not_exists(recetaId)",
                },
              },
            ],
          },
          opciones,
        );
        resultado.migradas += 1;
      } catch (err) {
        if (err instanceof TransactionCanceledException) {
          const r0 = err.CancellationReasons?.[0]?.Code;
          const r1 = err.CancellationReasons?.[1]?.Code;
          if (r0 === "ConditionalCheckFailed") {
            const actual = await buscarReceta(vigente.recetaId);
            if (!actual) resultado.omitidasInexistentes += 1;
            else resultado.omitidasPorProteccion += 1;
            continue;
          }
          if (r1 === "ConditionalCheckFailed") {
            // Ya existía en FavoritosTable: sellar favoritaMigradaEn para proteger futuros borrados.
            await ddb.send(
              new UpdateCommand({
                TableName: TABLE,
                Key: { userId: vigente.userId, recetaId: vigente.recetaId },
                UpdateExpression: "SET favoritaMigradaEn = :ahora",
                ConditionExpression: "attribute_exists(recetaId) AND attribute_not_exists(favoritaMigradaEn)",
                ExpressionAttributeValues: { ":ahora": ahora },
              }),
            );
            resultado.yaExistentesEnFavoritos += 1;
            continue;
          }
        }
        resultado.errores += 1;
        log(`[ERROR] Receta ${vigente.recetaId}: ${(err as Error).message}`);
      }
    }

    lastKey = scan.LastEvaluatedKey;
  } while (lastKey);

  log(
    JSON.stringify({
      evento: "migracion_favoritos_historicos",
      ...resultado,
    }),
  );
  return resultado;
}
