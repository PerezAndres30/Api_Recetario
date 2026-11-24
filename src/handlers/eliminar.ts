import { DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { borrarImagenSegura } from "../lib/cloudinary";
import { ddb, TABLE } from "../lib/clients";
import { getRecetaId, getUserId, HttpError, json, withErrors } from "../lib/http";
import { buscarReceta, exigirPropietario } from "../lib/recetas";

// DELETE /recetas/{id}  (solo el creador; también borra su foto en Cloudinary)
export const handler = withErrors(async (event) => {
  const userId = getUserId(event);
  const recetaId = getRecetaId(event);

  const receta = exigirPropietario(await buscarReceta(recetaId), userId);

  const r = await ddb.send(
    new DeleteCommand({
      TableName: TABLE,
      Key: { userId, recetaId },
      ReturnValues: "ALL_OLD",
    }),
  );
  if (!r.Attributes) throw new HttpError(404, "Receta no encontrada");

  await borrarImagenSegura(receta.imagenPublicId);
  return json(204);
});
