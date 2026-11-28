import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, FAVORITOS_TABLE, INDICE_RECETA_ID, TABLE } from "./clients";
import {
  batchDeleteConReintentos,
  queryPaginado,
  transactWriteConReintentos,
  type OpcionesReintentoBatch,
} from "./dynamo";
import { HttpError } from "./http";
import { buscarReceta, buscarRecetasPorClaves } from "./recetas";
import type { FavoritoItem, Receta } from "./schema";

export interface EstadoFavoritoReceta {
  recetaId: string;
  esFavorito: boolean;
}

/**
 * Guarda una receta (propia o ajena) en la colección privada de favoritos del usuario.
 * Usa TransactWriteCommand con ConditionCheck sobre RecetasTable para impedir favoritos sobre
 * recetas inexistentes o eliminadas concurrentemente, y es idempotente si ya existía.
 */
export async function agregarFavoritoSeguro(
  userId: string,
  recetaId: string,
  opciones?: OpcionesReintentoBatch,
): Promise<EstadoFavoritoReceta> {
  const receta = await buscarReceta(recetaId);
  if (!receta) throw new HttpError(404, "Receta no encontrada");

  const nuevo: FavoritoItem = {
    userId,
    recetaId,
    recetaUserId: receta.userId,
    guardadaEn: new Date().toISOString(),
  };

  try {
    await transactWriteConReintentos(
      {
        TransactItems: [
          {
            ConditionCheck: {
              TableName: TABLE,
              Key: { userId: receta.userId, recetaId },
              ConditionExpression: "attribute_exists(recetaId)",
            },
          },
          {
            Put: {
              TableName: FAVORITOS_TABLE,
              Item: nuevo,
              ConditionExpression: "attribute_not_exists(recetaId)",
            },
          },
        ],
      },
      opciones,
    );
    return { recetaId, esFavorito: true };
  } catch (err) {
    if (err instanceof TransactionCanceledException) {
      if (err.CancellationReasons?.[0]?.Code === "ConditionalCheckFailed") {
        throw new HttpError(404, "Receta no encontrada");
      }
      if (err.CancellationReasons?.[1]?.Code === "ConditionalCheckFailed") {
        return { recetaId, esFavorito: true };
      }
      if ((err.CancellationReasons ?? []).some((r) => r.Code === "TransactionConflict")) {
        throw new HttpError(409, "Conflicto temporal al guardar favorito. Inténtalo de nuevo.");
      }
    }
    throw err;
  }
}

/** Elimina una receta de los favoritos del usuario (operación idempotente). */
export async function quitarFavorito(
  userId: string,
  recetaId: string,
): Promise<EstadoFavoritoReceta> {
  await ddb.send(
    new DeleteCommand({
      TableName: FAVORITOS_TABLE,
      Key: { userId, recetaId },
    }),
  );
  return { recetaId, esFavorito: false };
}

/** Verifica puntualmente si una receta está en favoritos del usuario (O(1) para detalle/edición). */
export async function esRecetaFavorita(userId: string | null, recetaId: string): Promise<boolean> {
  if (!userId) return false;
  const r = await ddb.send(
    new GetCommand({
      TableName: FAVORITOS_TABLE,
      Key: { userId, recetaId },
      ProjectionExpression: "recetaId",
    }),
  );
  return Boolean(r.Item);
}

/** Devuelve el conjunto de recetaIds guardados como favoritos por el usuario. */
export async function consultarFavoritosIds(userId: string | null): Promise<Set<string>> {
  if (!userId) return new Set();
  const items = await queryPaginado<Pick<FavoritoItem, "recetaId">>({
    TableName: FAVORITOS_TABLE,
    KeyConditionExpression: "userId = :u",
    ProjectionExpression: "recetaId",
    ExpressionAttributeValues: { ":u": userId },
  });
  return new Set(items.map((item) => item.recetaId));
}

/**
 * Obtiene y ordena por fecha de guardado descendente las recetas favoritas del usuario,
 * hidratándolas mediante BatchGet sobre RecetasTable.
 * Además, si detecta favoritos apuntando a recetas ya eliminadas (p. ej. por consistencia eventual
 * del GSI o fallo parcial previo en DELETE /recetas/{id}), los filtra y depura en segundo plano.
 */
export async function listarFavoritosHidratados(
  userId: string,
  opciones?: OpcionesReintentoBatch,
): Promise<Receta[]> {
  const registros = await queryPaginado<FavoritoItem>({
    TableName: FAVORITOS_TABLE,
    KeyConditionExpression: "userId = :u",
    ExpressionAttributeValues: { ":u": userId },
  });
  if (registros.length === 0) return [];

  registros.sort((a, b) => b.guardadaEn.localeCompare(a.guardadaEn));

  const recetas = await buscarRecetasPorClaves(
    registros.map((r) => ({ userId: r.recetaUserId, recetaId: r.recetaId })),
    opciones,
  );
  const porId = new Map(recetas.map((r) => [r.recetaId, r]));

  const vigentes: Receta[] = [];
  const huerfanos: Array<{ userId: string; recetaId: string }> = [];

  for (const reg of registros) {
    const receta = porId.get(reg.recetaId);
    if (receta) {
      vigentes.push(receta);
    } else {
      huerfanos.push({ userId: reg.userId, recetaId: reg.recetaId });
    }
  }

  if (huerfanos.length > 0) {
    try {
      await batchDeleteConReintentos(FAVORITOS_TABLE, huerfanos, opciones);
    } catch (err) {
      console.error("Error al depurar favoritos huérfanos durante lectura:", err);
    }
  }

  return vigentes;
}

/** Elimina por lotes todos los favoritos asociados a una receta eliminada usando recetaId-index. */
export async function eliminarFavoritosDeReceta(
  recetaId: string,
  opciones?: OpcionesReintentoBatch,
): Promise<number> {
  const relacionados = await queryPaginado<Pick<FavoritoItem, "userId" | "recetaId">>({
    TableName: FAVORITOS_TABLE,
    IndexName: INDICE_RECETA_ID,
    KeyConditionExpression: "recetaId = :r",
    ProjectionExpression: "userId, recetaId",
    ExpressionAttributeValues: { ":r": recetaId },
  });
  const { eliminadosSolicitados } = await batchDeleteConReintentos(
    FAVORITOS_TABLE,
    relacionados.map((item) => ({ userId: item.userId, recetaId: item.recetaId })),
    opciones,
  );
  return eliminadosSolicitados;
}
