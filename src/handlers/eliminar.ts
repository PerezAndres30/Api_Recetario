import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, TABLE } from "../lib/clients";
import { borrarImagenSegura } from "../lib/cloudinary";
import { getRecetaId, getUserId, HttpError, json, withErrors } from "../lib/http";
import { limpiarRelacionesDeReceta } from "../lib/limpieza";
import { buscarReceta, exigirPropietario } from "../lib/recetas";

// DELETE /recetas/{id}  (solo el creador; borra receta, foto en Cloudinary y limpia likes/favoritos)
export const handler = withErrors(async (event) => {
  const userId = getUserId(event);
  const recetaId = getRecetaId(event);

  const receta = exigirPropietario(await buscarReceta(recetaId), userId);

  try {
    const r = await ddb.send(
      new DeleteCommand({
        TableName: TABLE,
        Key: { userId, recetaId },
        ConditionExpression: "attribute_exists(recetaId)",
        ReturnValues: "ALL_OLD",
      }),
    );
    if (!r.Attributes) throw new HttpError(404, "Receta no encontrada");
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      throw new HttpError(404, "Receta no encontrada");
    }
    throw err;
  }

  await borrarImagenSegura(receta.imagenPublicId);
  await limpiarRelacionesDeReceta(recetaId);
  return json(204);
});
