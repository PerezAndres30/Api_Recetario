import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { aActorKeyAnonimo, aActorKeyUsuario } from "../src/lib/schema";
import {
  cuerpo,
  evento,
  ID_A,
  ID_B,
  ID_NUEVA,
  receta,
  tablaFalsa,
  tokenDe,
  VISITOR_1,
  VISITOR_2,
} from "./ayudas";

const mockDynamo = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../src/lib/clients", () => ({
  ddb: mockDynamo,
  TABLE: "recetas",
  USUARIOS_TABLE: "usuarios",
  LIKES_TABLE: "likes",
  FAVORITOS_TABLE: "favoritos",
  INDICE_RECETA_ID: "recetaId-index",
  INDICE_ACTOR_KEY: "actorKey-index",
}));

import { handler as actualizar } from "../src/handlers/actualizar";
import { handler as crear } from "../src/handlers/crear";
import { handler as eliminar } from "../src/handlers/eliminar";
import { handler as favoritoGuardar } from "../src/handlers/favoritoGuardar";
import { handler as favoritoQuitar } from "../src/handlers/favoritoQuitar";
import { handler as favoritosListar } from "../src/handlers/favoritosListar";
import { handler as likeDar } from "../src/handlers/likeDar";
import { handler as likeQuitar } from "../src/handlers/likeQuitar";
import { handler as listar } from "../src/handlers/listar";
import { handler as login } from "../src/handlers/login";
import { handler as obtener } from "../src/handlers/obtener";
import { handler as registrar } from "../src/handlers/registrar";
import { handler as visitanteSesion } from "../src/handlers/visitanteSesion";
import { firmarVisitorToken, verificarVisitorToken } from "../src/lib/http";
import {
  darLikeAtomico,
  LIMPIEZA_PENDIENTE_ACTOR_KEY,
  migrarLikesAnonimos,
} from "../src/lib/likes";
import { recuperarLimpiezaReceta } from "../src/lib/limpieza";
import { migrarFavoritosHistoricos } from "../src/lib/migrarFavoritosHistoricos";

const ana = tokenDe("ana");
const beto = tokenDe("beto");

const cuerpoReceta = {
  titulo: "Chilaquiles",
  categoria: "desayuno",
  tiempoMinutos: 25,
  porciones: 2,
  ingredientes: [{ nombre: "Totopos", cantidad: "200", unidad: "g" }],
  pasos: ["Bañar con salsa y servir"],
};

let fake: ReturnType<typeof tablaFalsa>;
const fetchFalso = vi.fn();

beforeEach(() => {
  process.env.JWT_SECRET = "una-clave-de-prueba-de-al-menos-32-caracteres";
  process.env.CLOUDINARY_CLOUD_NAME = "demo";
  process.env.CLOUDINARY_API_KEY = "clave-publica";
  process.env.CLOUDINARY_API_SECRET = "secreto";

  fake = tablaFalsa([
    receta({
      userId: "ana",
      recetaId: ID_A,
      titulo: "Pastel",
      categoria: "postre",
      favorita: true, // histórica sin likesCount
      tituloBusqueda: "pastel",
      actualizadaEn: "2026-11-01T10:00:00.000Z",
    }),
    receta({
      userId: "beto",
      recetaId: ID_B,
      titulo: "Tacos",
      categoria: "comida",
      likesCount: 2,
      tituloBusqueda: "tacos",
      actualizadaEn: "2026-11-02T10:00:00.000Z",
    }),
  ]);
  mockDynamo.send.mockReset();
  mockDynamo.send.mockImplementation(fake.send);
  fetchFalso.mockReset().mockResolvedValue({ ok: true, status: 200 });
  vi.stubGlobal("fetch", fetchFalso);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

describe("emisión de identidad anónima POST /visitante/sesion y endpoints de likes", () => {
  it("emite un UUID generado por el servidor con token firmado y rechaza UUID arbitrario del cliente", async () => {
    const res = await visitanteSesion(evento({}));
    expect(res).toMatchObject({ statusCode: 201 });
    const payload = cuerpo(res as { body: string });
    expect(payload.visitorId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(verificarVisitorToken(payload.visitorToken)).toBe(payload.visitorId.toLowerCase());

    // No permitir que el cliente solicite la firma de su propio UUID
    expect(await visitanteSesion(evento({ body: { visitorId: VISITOR_1 } }))).toMatchObject({
      statusCode: 400,
    });
    expect(await visitanteSesion(evento({ body: { visitorToken: "x" } }))).toMatchObject({
      statusCode: 400,
    });
  });

  it("permite a un visitante dar y quitar like con X-Visitor-Token firmado y rechaza UUID crudo sin firma", async () => {
    const token1 = firmarVisitorToken(VISITOR_1);
    const token2 = firmarVisitorToken(VISITOR_2);

    // No es posible modificar likes de otra identidad presentando únicamente su UUID en X-Visitor-Id
    expect(await likeDar(evento({ id: ID_A, visitorId: VISITOR_1 }))).toMatchObject({ statusCode: 400 });
    expect(await likeQuitar(evento({ id: ID_A, visitorId: VISITOR_1 }))).toMatchObject({ statusCode: 400 });

    const rDar = await likeDar(evento({ id: ID_A, visitorToken: token1 }));
    expect(rDar).toMatchObject({ statusCode: 200 });
    expect(cuerpo(rDar as { body: string })).toEqual({
      recetaId: ID_A,
      likesCount: 1,
      leDiLike: true,
    });

    // Idempotente si repite POST
    expect(cuerpo((await likeDar(evento({ id: ID_A, visitorToken: token1 }))) as { body: string })).toEqual({
      recetaId: ID_A,
      likesCount: 1,
      leDiLike: true,
    });

    // Visible para el mismo visitante en GET /recetas y GET /recetas/{id}, no para otro ni para UUID crudo
    const detVis1 = cuerpo((await obtener(evento({ id: ID_A, visitorToken: token1 }))) as { body: string });
    const detVis2 = cuerpo((await obtener(evento({ id: ID_A, visitorToken: token2 }))) as { body: string });
    const detRaw = cuerpo((await obtener(evento({ id: ID_A, visitorId: VISITOR_1 }))) as { body: string });
    expect(detVis1).toMatchObject({ likesCount: 1, leDiLike: true, esFavorito: false, esPropia: false });
    expect(detVis2).toMatchObject({ likesCount: 1, leDiLike: false, esFavorito: false, esPropia: false });
    expect(detRaw).toMatchObject({ likesCount: 1, leDiLike: false, esFavorito: false, esPropia: false });

    const catVis1 = cuerpo((await listar(evento({ visitorToken: token1 }))) as { body: string }).recetas;
    expect(catVis1.find((x: { recetaId: string }) => x.recetaId === ID_A)).toMatchObject({
      likesCount: 1,
      leDiLike: true,
      esFavorito: false,
    });

    // Quitar like idempotente
    expect(cuerpo((await likeQuitar(evento({ id: ID_A, visitorToken: token1 }))) as { body: string })).toEqual({
      recetaId: ID_A,
      likesCount: 0,
      leDiLike: false,
    });
    expect(cuerpo((await likeQuitar(evento({ id: ID_A, visitorToken: token1 }))) as { body: string })).toEqual({
      recetaId: ID_A,
      likesCount: 0,
      leDiLike: false,
    });
  });

  it("permite a un usuario registrado dar/quitar likes y no duplica si también envía X-Visitor-Id", async () => {
    await likeDar(evento({ id: ID_B, token: ana, visitorId: VISITOR_1 }));
    // Segundo intento del mismo usuario autenticado con otro visitorId sigue contando 1 solo voto de USER#ana
    const r2 = await likeDar(evento({ id: ID_B, token: ana, visitorId: VISITOR_2 }));
    expect(cuerpo(r2 as { body: string })).toEqual({
      recetaId: ID_B,
      likesCount: 3,
      leDiLike: true,
    });
    expect(fake.likes.some((l) => l.actorKey === aActorKeyAnonimo(VISITOR_2))).toBe(false);

    const rQuitar = await likeQuitar(evento({ id: ID_B, token: ana }));
    expect(cuerpo(rQuitar as { body: string })).toEqual({
      recetaId: ID_B,
      likesCount: 2,
      leDiLike: false,
    });
  });

  it("rechaza con 401 tokens inválidos/expirados en mutaciones sin degradar a visitante, y 400 en anónimos inválidos", async () => {
    const conTokenMalo = evento({ id: ID_A, token: "expirado.jwt.token", visitorId: VISITOR_1 });
    expect(await likeDar(conTokenMalo)).toMatchObject({ statusCode: 401 });
    expect(await likeQuitar(conTokenMalo)).toMatchObject({ statusCode: 401 });

    expect(await likeDar(evento({ id: ID_A }))).toMatchObject({ statusCode: 400 });
    expect(await likeDar(evento({ id: ID_A, visitorId: "abc-no-uuid" }))).toMatchObject({ statusCode: 400 });
    expect(await likeDar(evento({ id: ID_A, visitorToken: `${VISITOR_1}.firmamala` }))).toMatchObject({
      statusCode: 400,
    });
    expect(await likeDar(evento({ id: ID_NUEVA, visitorToken: firmarVisitorToken(VISITOR_1) }))).toMatchObject({
      statusCode: 404,
    });
    expect(await likeQuitar(evento({ id: ID_NUEVA, visitorToken: firmarVisitorToken(VISITOR_1) }))).toMatchObject({
      statusCode: 404,
    });
  });

  it("soporta likes concurrentes y reintenta conflictos transitorios sin confundir errores inesperados con idempotencia", async () => {
    const [r1, r2, r3] = await Promise.all([
      likeDar(evento({ id: ID_A, token: ana })),
      likeDar(evento({ id: ID_A, token: beto })),
      likeDar(evento({ id: ID_A, visitorToken: firmarVisitorToken(VISITOR_1) })),
    ]);
    expect(r1).toMatchObject({ statusCode: 200 });
    expect(r2).toMatchObject({ statusCode: 200 });
    expect(r3).toMatchObject({ statusCode: 200 });
    expect(fake.items.find((r) => r.recetaId === ID_A)?.likesCount).toBe(3);

    // Simular conflicto transitorio TransactionConflict seguido de éxito
    let primeraVez = true;
    mockDynamo.send.mockImplementation(async (cmd: { constructor: { name: string }; input: Record<string, any> }) => {
      if (cmd.constructor.name === "TransactWriteCommand" && primeraVez) {
        primeraVez = false;
        throw new TransactionCanceledException({
          message: "conflict",
          $metadata: {},
          CancellationReasons: [{ Code: "TransactionConflict" }, { Code: "None" }],
        });
      }
      return fake.send(cmd);
    });

    const recuperado = await darLikeAtomico(ID_B, aActorKeyUsuario("ana"), "USER", {
      esperarMs: async () => {},
    });
    expect(recuperado).toEqual({ recetaId: ID_B, likesCount: 3, leDiLike: true });

    // Un TransactionCanceledException por ValidationError NO debe tratarse como éxito idempotente
    mockDynamo.send.mockImplementation(async (cmd: { constructor: { name: string }; input: Record<string, any> }) => {
      if (cmd.constructor.name === "TransactWriteCommand") {
        throw new TransactionCanceledException({
          message: "validation",
          $metadata: {},
          CancellationReasons: [{ Code: "ValidationError" }, { Code: "None" }],
        });
      }
      return fake.send(cmd);
    });
    expect(await likeDar(evento({ id: ID_B, token: beto }))).toMatchObject({ statusCode: 500 });
  });
});

describe("endpoints de favoritos: colección privada, aislamiento y estados completos", () => {
  it("bloquea con 401 a visitantes en GET/POST/DELETE favoritos y rechaza 404 en receta inexistente", async () => {
    expect(await favoritosListar(evento({ visitorId: VISITOR_1 }))).toMatchObject({ statusCode: 401 });
    expect(await favoritoGuardar(evento({ id: ID_A, visitorId: VISITOR_1 }))).toMatchObject({ statusCode: 401 });
    expect(await favoritoQuitar(evento({ id: ID_A, visitorId: VISITOR_1 }))).toMatchObject({ statusCode: 401 });

    expect(await favoritoGuardar(evento({ id: ID_NUEVA, token: ana }))).toMatchObject({ statusCode: 404 });
  });

  it("permite guardar recetas propias y ajenas, mantiene aislamiento entre cuentas y devuelve recetas completas", async () => {
    // Ana guarda una propia (ID_A) y una ajena (ID_B) + da like a ID_B
    expect(cuerpo((await favoritoGuardar(evento({ id: ID_A, token: ana }))) as { body: string })).toEqual({
      recetaId: ID_A,
      esFavorito: true,
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(cuerpo((await favoritoGuardar(evento({ id: ID_B, token: ana }))) as { body: string })).toEqual({
      recetaId: ID_B,
      esFavorito: true,
    });
    await likeDar(evento({ id: ID_B, token: ana }));

    // Aislamiento: Beto no ve los favoritos ni likes de Ana
    const favsBeto = cuerpo((await favoritosListar(evento({ token: beto }))) as { body: string });
    expect(favsBeto.recetas).toEqual([]);
    const detBeto = cuerpo((await obtener(evento({ id: ID_B, token: beto }))) as { body: string });
    expect(detBeto).toMatchObject({ esPropia: true, esFavorito: false, leDiLike: false, likesCount: 3 });

    // Ana ve sus 2 favoritos ordenados por guardadaEn desc (ID_B primero), completos
    const favsAna = cuerpo((await favoritosListar(evento({ token: ana }))) as { body: string }).recetas;
    expect(favsAna.map((r: { recetaId: string }) => r.recetaId)).toEqual([ID_B, ID_A]);
    expect(favsAna[0]).toMatchObject({
      recetaId: ID_B,
      titulo: "Tacos",
      likesCount: 3,
      leDiLike: true,
      esFavorito: true,
      esPropia: false,
    });
    expect(favsAna[1]).toMatchObject({
      recetaId: ID_A,
      esFavorito: true,
      esPropia: true,
    });

    // Filtro por q en GET /favoritos
    const favsFiltrados = cuerpo((await favoritosListar(evento({ token: ana, query: { q: "taco" } }))) as { body: string }).recetas;
    expect(favsFiltrados.map((r: { recetaId: string }) => r.recetaId)).toEqual([ID_B]);

    // Quitar favorito es idempotente y actualiza GET /recetas
    expect(cuerpo((await favoritoQuitar(evento({ id: ID_A, token: ana }))) as { body: string })).toEqual({
      recetaId: ID_A,
      esFavorito: false,
    });
    expect(cuerpo((await favoritoQuitar(evento({ id: ID_A, token: ana }))) as { body: string })).toEqual({
      recetaId: ID_A,
      esFavorito: false,
    });

    const catAna = cuerpo((await listar(evento({ token: ana }))) as { body: string }).recetas;
    expect(catAna.find((r: { recetaId: string }) => r.recetaId === ID_A).esFavorito).toBe(false);
    expect(catAna.find((r: { recetaId: string }) => r.recetaId === ID_B).esFavorito).toBe(true);
  });
});

describe("autenticación, migración segura con X-Visitor-Token y aislamiento por cambio de cuenta", () => {
  it("cubre regresión de /register y /login y NO migra likes con UUID crudo sin firma", async () => {
    const tokenVis = firmarVisitorToken(VISITOR_1);
    await likeDar(evento({ id: ID_A, visitorToken: tokenVis }));

    const reg = await registrar(
      evento({
        visitorId: VISITOR_1, // UUID sin firma: debe ser rechazado para migración
        body: { nombre: "Carlos", correo: "carlos@test.com", password: "Password123" },
      }),
    );
    expect(reg).toMatchObject({ statusCode: 201 });
    const sesion = cuerpo(reg as { body: string });
    expect(sesion.usuario.correo).toBe("carlos@test.com");

    // Registro duplicado -> 409, login erróneo -> 401
    expect(
      await registrar(evento({ body: { nombre: "C", correo: "carlos@test.com", password: "Password123" } })),
    ).toMatchObject({ statusCode: 409 });
    expect(await login(evento({ body: { correo: "carlos@test.com", password: "mal" } }))).toMatchObject({
      statusCode: 401,
    });

    // El like anónimo sigue en ANON# porque no venía X-Visitor-Token firmado
    const likeCarlos = fake.likes.find((l) => l.actorKey === aActorKeyUsuario(sesion.usuario.id));
    expect(likeCarlos).toBeUndefined();
    expect(fake.likes.some((l) => l.actorKey === aActorKeyAnonimo(VISITOR_1))).toBe(true);
  });

  it("migra y deduplica con X-Visitor-Token firmado en login y bloquea transferencia a otra cuenta ante migración incompleta", async () => {
    const tokenVisitante = firmarVisitorToken(VISITOR_1);
    // Registrar usuario Ana en UsuariosTable simulada
    await registrar(evento({ body: { nombre: "Ana", correo: "ana@test.com", password: "Password123" } }));
    await registrar(evento({ body: { nombre: "Beto", correo: "beto@test.com", password: "Password123" } }));
    const userAnaId = fake.usuarios[0]!.usuarioId;
    const userBetoId = fake.usuarios[1]!.usuarioId;

    // Ana ya dio like como registrada a ID_B; luego como visitante da like a ID_A (nuevo) y ID_B (duplicado)
    await darLikeAtomico(ID_B, aActorKeyUsuario(userAnaId), "USER"); // 2 -> 3
    await likeDar(evento({ id: ID_A, visitorToken: tokenVisitante })); // 0 -> 1
    await likeDar(evento({ id: ID_B, visitorToken: tokenVisitante })); // 3 -> 4

    // Simular migración parcial: maxItems: 1 deja 1 like ANON# todavía pendiente vinculado a Ana
    const parcial = await migrarLikesAnonimos(VISITOR_1, userAnaId, { maxItems: 1 });
    expect(parcial.parcial).toBe(true);

    // Otro usuario (Beto) inicia sesión en el mismo dispositivo presentando el mismo X-Visitor-Token:
    // EL BLOQUEO DE CUENTA IMPIDE que Beto reciba los likes restantes de Ana
    const loginBeto = await login(
      evento({
        visitorToken: tokenVisitante,
        body: { correo: "beto@test.com", password: "Password123" },
      }),
    );
    expect(loginBeto).toMatchObject({ statusCode: 200 });
    expect(cuerpo(loginBeto as { body: string }).migracionLikes).toMatchObject({
      intentada: true,
      completada: false,
      bloqueadaPorOtraCuenta: true,
    });
    expect(fake.likes.filter((l) => l.actorKey === aActorKeyUsuario(userBetoId))).toHaveLength(0);

    // Cuando Ana vuelve a autenticarse, el reintento sí completa y deduplica su migración pendiente
    const loginAna = await login(
      evento({
        visitorToken: tokenVisitante,
        body: { correo: "ana@test.com", password: "Password123" },
      }),
    );
    expect(loginAna).toMatchObject({ statusCode: 200 });
    expect(cuerpo(loginAna as { body: string }).migracionLikes).toMatchObject({
      intentada: true,
      completada: true,
      bloqueadaPorOtraCuenta: false,
      parcial: false,
    });
    expect(fake.items.find((r) => r.recetaId === ID_A)?.likesCount).toBe(1);
    expect(fake.items.find((r) => r.recetaId === ID_B)?.likesCount).toBe(3); // deduplicado
    expect(
      fake.likes.filter((l) => l.actorKey === aActorKeyAnonimo(VISITOR_1) && l.recetaId !== "__MIGRACION_LOCK__"),
    ).toHaveLength(0);
  });
});

describe("creación, edición, eliminación concurrente, recuperación de limpieza y migración de favoritos históricos", () => {
  it("crear y actualizar incluyen estados sociales y actualizar preserva likesCount y favoritos de otros", async () => {
    const creada = await crear(evento({ token: ana, body: cuerpoReceta }));
    expect(creada).toMatchObject({ statusCode: 201 });
    const creadaBody = cuerpo(creada as { body: string });
    expect(creadaBody).toMatchObject({
      likesCount: 0,
      leDiLike: false,
      esFavorito: false,
      esPropia: true,
    });

    await likeDar(evento({ id: ID_A, token: ana }));
    await favoritoGuardar(evento({ id: ID_A, token: ana }));
    await favoritoGuardar(evento({ id: ID_A, token: beto }));

    // Editar ID_A omitiendo favorita: preserva likesCount = 1, favorita = true y favoritos de beto y ana
    const editada = await actualizar(
      evento({
        id: ID_A,
        token: ana,
        body: { ...cuerpoReceta, likesCount: 999 },
      }),
    );
    expect(editada).toMatchObject({ statusCode: 200 });
    expect(cuerpo(editada as { body: string })).toMatchObject({
      likesCount: 1,
      leDiLike: true,
      esFavorito: true,
      favorita: true,
      esPropia: true,
    });
    expect(fake.favoritos).toHaveLength(2);
  });

  it("al eliminar receta limpia likes/favoritos y recupera huérfanos si hubo fallo parcial o retraso de GSI", async () => {
    await likeDar(evento({ id: ID_A, visitorToken: firmarVisitorToken(VISITOR_1) }));
    await favoritoGuardar(evento({ id: ID_A, token: beto }));

    // Simular fallo parcial en BatchWrite de favoritos durante DELETE /recetas/{id}
    let falloFavBatch = true;
    mockDynamo.send.mockImplementation(async (cmd: { constructor: { name: string }; input: Record<string, any> }) => {
      if (
        falloFavBatch &&
        cmd.constructor.name === "BatchWriteCommand" &&
        cmd.input.RequestItems?.favoritos
      ) {
        falloFavBatch = false;
        throw new Error("Fallo transitorio limpiando FavoritosTable");
      }
      return fake.send(cmd);
    });

    const del = await eliminar(evento({ id: ID_A, token: ana }));
    expect(del).toMatchObject({ statusCode: 204 });
    // Se registró marcador pendiente para recuperación
    expect(
      fake.likes.some((l) => l.recetaId === ID_A && l.actorKey === LIMPIEZA_PENDIENTE_ACTOR_KEY),
    ).toBe(true);

    // Aunque quedó temporalmente el favorito huérfano, GET /favoritos de Beto lo filtra y auto-depura
    const favsBeto = cuerpo((await favoritosListar(evento({ token: beto }))) as { body: string });
    expect(favsBeto.recetas).toEqual([]);
    expect(fake.favoritos).toHaveLength(0);

    // Recuperación explícita limpia también el marcador pendiente
    await recuperarLimpiezaReceta(ID_A);
    expect(fake.likes.filter((l) => l.recetaId === ID_A)).toHaveLength(0);
  });

  it("impide crear relaciones cuando la receta se elimina concurrentemente justo antes de la transacción", async () => {
    // Simular que buscarReceta ve la receta, pero desaparece antes del TransactWriteCommand
    let borradaAlEscribir = false;
    mockDynamo.send.mockImplementation(async (cmd: { constructor: { name: string }; input: Record<string, any> }) => {
      if (cmd.constructor.name === "TransactWriteCommand" && !borradaAlEscribir) {
        borradaAlEscribir = true;
        fake.items.splice(0, fake.items.length);
      }
      return fake.send(cmd);
    });

    expect(await favoritoGuardar(evento({ id: ID_A, token: ana }))).toMatchObject({ statusCode: 404 });
    expect(fake.favoritos).toHaveLength(0);
  });

  it("migra favoritos históricos en modo dry-run/apply sin sobrescribir favorita y sin reintroducir eliminados posteriores", async () => {
    const dry = await migrarFavoritosHistoricos({ dryRun: true, log: () => {} });
    expect(dry).toMatchObject({
      dryRun: true,
      analizadas: 2,
      elegibles: 1,
      migradas: 0,
      recetasElegiblesIds: [ID_A],
    });
    expect(fake.favoritos).toHaveLength(0);

    const applied = await migrarFavoritosHistoricos({ dryRun: false, log: () => {} });
    expect(applied).toMatchObject({
      dryRun: false,
      elegibles: 1,
      migradas: 1,
      omitidasPorProteccion: 0,
    });
    // Conserva favorita: true en RecetasTable por compatibilidad del contrato
    expect(fake.items.find((r) => r.recetaId === ID_A)?.favorita).toBe(true);
    expect(fake.favoritos).toHaveLength(1);

    // El usuario Ana elimina ID_A de su nueva colección de Favoritos
    await favoritoQuitar(evento({ id: ID_A, token: ana }));
    expect(fake.favoritos).toHaveLength(0);

    // Re-ejecutar la migración NO debe reintroducir ID_A aunque receta.favorita siga siendo true
    const segunda = await migrarFavoritosHistoricos({ dryRun: false, log: () => {} });
    expect(segunda).toMatchObject({
      migradas: 0,
      omitidasPorProteccion: 1,
    });
    expect(fake.favoritos).toHaveLength(0);
  });
});
