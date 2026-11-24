import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { borrarImagenSegura, validarImagen } from "../lib/cloudinary";
import { ddb, TABLE } from "../lib/clients";
import { getRecetaId, getUserId, HttpError, json, parseBody, withErrors } from "../lib/http";
import { buscarReceta, exigirPropietario } from "../lib/recetas";
import { actualizarInput, aRespuesta, type Receta } from "../lib/schema";

// PUT /recetas/{id}  (solo el creador; reemplaza los campos editables)
export const handler = withErrors(async (event) => {
  const userId = getUserId(event);
  const recetaId = getRecetaId(event);
  const { imagenUrl, imagenPublicId, ...campos } = parseBody(event, actualizarInput);

  const actual = exigirPropietario(await buscarReceta(recetaId), userId);

  // Foto: sin campos = se conserva; ambos null = se quita; ambos con valor = se valida y se guarda.
  let foto = { imagenUrl: actual.imagenUrl ?? null, imagenPublicId: actual.imagenPublicId ?? null };
  let imagenABorrar: string | null = null;
  if (imagenUrl === undefined && imagenPublicId === undefined) {
    // se conserva
  } else if (imagenUrl === null && imagenPublicId === null) {
    imagenABorrar = actual.imagenPublicId ?? null;
    foto = { imagenUrl: null, imagenPublicId: null };
  } else if (typeof imagenUrl === "string" && typeof imagenPublicId === "string") {
    validarImagen(recetaId, imagenUrl, imagenPublicId);
    foto = { imagenUrl, imagenPublicId };
  } else {
    throw new HttpError(400, "imagenUrl e imagenPublicId deben enviarse juntos");
  }

  const nueva: Receta = {
    ...campos,
    ...foto,
    userId,
    recetaId,
    tituloBusqueda: campos.titulo.toLowerCase(),
    creadaEn: actual.creadaEn,
    actualizadaEn: new Date().toISOString(),
  };

  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: nueva,
        ConditionExpression: "attribute_exists(recetaId)",
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      throw new HttpError(404, "Receta no encontrada");
    }
    throw err;
  }

  await borrarImagenSegura(imagenABorrar);
  return json(200, aRespuesta(nueva, userId));
});
