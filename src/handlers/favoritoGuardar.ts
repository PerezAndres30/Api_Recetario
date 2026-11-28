import { agregarFavoritoSeguro } from "../lib/favoritos";
import { getRecetaId, getUserId, json, withErrors } from "../lib/http";

// POST /favoritos/{id}  (exclusivo de usuarios autenticados; permite recetas propias o ajenas)
export const handler = withErrors(async (event) => {
  const userId = getUserId(event);
  const recetaId = getRecetaId(event);

  const resultado = await agregarFavoritoSeguro(userId, recetaId);
  return json(200, resultado);
});
