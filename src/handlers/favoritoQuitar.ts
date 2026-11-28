import { quitarFavorito } from "../lib/favoritos";
import { getRecetaId, getUserId, json, withErrors } from "../lib/http";

// DELETE /favoritos/{id}  (exclusivo de usuarios autenticados; idempotente)
export const handler = withErrors(async (event) => {
  const userId = getUserId(event);
  const recetaId = getRecetaId(event);

  const resultado = await quitarFavorito(userId, recetaId);
  return json(200, resultado);
});
