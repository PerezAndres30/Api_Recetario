import { getActorParaMutacion, getRecetaId, json, withErrors } from "../lib/http";
import { darLikeAtomico } from "../lib/likes";

// POST /recetas/{id}/like  (visitantes con X-Visitor-Id/X-Visitor-Token o registrados con Bearer JWT)
export const handler = withErrors(async (event) => {
  const actor = getActorParaMutacion(event);
  const recetaId = getRecetaId(event);

  const resultado = await darLikeAtomico(recetaId, actor.actorKey, actor.tipo);
  return json(200, resultado);
});
