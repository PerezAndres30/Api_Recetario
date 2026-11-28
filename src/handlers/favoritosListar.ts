import { listarFavoritosHidratados } from "../lib/favoritos";
import { getUserId, json, withErrors } from "../lib/http";
import { consultarLikesDeActor } from "../lib/likes";
import { aActorKeyUsuario, aRespuesta } from "../lib/schema";

// GET /favoritos  (exclusivo de usuarios autenticados; devuelve recetas completas ordenadas por guardado desc)
export const handler = withErrors(async (event) => {
  const userId = getUserId(event);
  const { categoria, q } = event.queryStringParameters ?? {};

  const recetasGuardadas = await listarFavoritosHidratados(userId);
  const qNorm = q?.trim().toLowerCase();

  const filtradas = recetasGuardadas.filter((r) => {
    if (categoria && r.categoria !== categoria) return false;
    if (qNorm && !r.tituloBusqueda.includes(qNorm)) return false;
    return true;
  });

  const likedIds = await consultarLikesDeActor(
    filtradas.map((r) => r.recetaId),
    aActorKeyUsuario(userId),
  );

  return json(200, {
    recetas: filtradas.map((receta) =>
      aRespuesta(receta, userId, {
        leDiLike: likedIds.has(receta.recetaId),
        esFavorito: true,
      }),
    ),
  });
});
