import { esRecetaFavorita } from "../lib/favoritos";
import { getActorOpcionalLectura, getRecetaId, getUserIdOpcional, HttpError, json, withErrors } from "../lib/http";
import { consultarLikesDeActor } from "../lib/likes";
import { buscarReceta } from "../lib/recetas";
import { aRespuesta } from "../lib/schema";

// GET /recetas/{id}  (público; con sesión o visitante devuelve estados sociales personalizados)
export const handler = withErrors(async (event) => {
  const userId = getUserIdOpcional(event);
  const actor = getActorOpcionalLectura(event);
  const recetaId = getRecetaId(event);

  const receta = await buscarReceta(recetaId);
  if (!receta) throw new HttpError(404, "Receta no encontrada");

  const [likedIds, esFavorito] = await Promise.all([
    consultarLikesDeActor([recetaId], actor?.actorKey ?? null),
    esRecetaFavorita(userId, recetaId),
  ]);

  return json(
    200,
    aRespuesta(receta, userId, {
      leDiLike: likedIds.has(recetaId),
      esFavorito,
    }),
  );
});
