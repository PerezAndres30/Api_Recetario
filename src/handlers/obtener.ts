import { getRecetaId, getUserIdOpcional, HttpError, json, withErrors } from "../lib/http";
import { buscarReceta } from "../lib/recetas";
import { aRespuesta } from "../lib/schema";

// GET /recetas/{id}  (público; con token válido, esPropia indica si es del usuario)
export const handler = withErrors(async (event) => {
  const userId = getUserIdOpcional(event);
  const recetaId = getRecetaId(event);

  const receta = await buscarReceta(recetaId);
  if (!receta) throw new HttpError(404, "Receta no encontrada");

  return json(200, aRespuesta(receta, userId));
});
