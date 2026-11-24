import { firmaSubida } from "../lib/cloudinary";
import { getRecetaId, getUserId, json, withErrors } from "../lib/http";
import { buscarReceta, exigirPropietario } from "../lib/recetas";

// POST /recetas/{id}/imagen-firma  (solo el creador; la receta debe existir ya)
// Devuelve lo necesario para que la app suba la foto directo a Cloudinary.
export const handler = withErrors(async (event) => {
  const userId = getUserId(event);
  const recetaId = getRecetaId(event);

  const receta = exigirPropietario(await buscarReceta(recetaId), userId);
  return json(200, firmaSubida(receta.recetaId));
});
