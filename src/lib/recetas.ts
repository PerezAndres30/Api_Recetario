import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, INDICE_RECETA_ID, TABLE } from "./clients";
import { HttpError } from "./http";
import type { Receta } from "./schema";

/** Busca una receta solo por su id (el índice permite no conocer a su autor). */
export async function buscarReceta(recetaId: string): Promise<Receta | undefined> {
  const r = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: INDICE_RECETA_ID,
      KeyConditionExpression: "recetaId = :r",
      ExpressionAttributeValues: { ":r": recetaId },
      Limit: 1,
    }),
  );
  return r.Items?.[0] as Receta | undefined;
}

/** 404 si no existe, 403 si existe pero es de otro usuario. */
export function exigirPropietario(receta: Receta | undefined, userId: string): Receta {
  if (!receta) throw new HttpError(404, "Receta no encontrada");
  if (receta.userId !== userId) throw new HttpError(403, "No tienes permiso sobre esta receta");
  return receta;
}
