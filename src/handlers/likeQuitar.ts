import { getActorParaMutacion, getRecetaId, json, withErrors } from "../lib/http";
import { quitarLikeAtomico } from "../lib/likes";

// DELETE /recetas/{id}/like  (visitantes con X-Visitor-Id/X-Visitor-Token o registrados con Bearer JWT)
export const handler = withErrors(async (event) => {
  const actor = getActorParaMutacion(event);
  const recetaId = getRecetaId(event);

  const resultado = await quitarLikeAtomico(recetaId, actor.actorKey);
  return json(200, resultado);
});
