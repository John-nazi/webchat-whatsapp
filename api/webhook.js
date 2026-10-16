// Bot de solicitudes de soporte para WhatsApp (Evolution API -> Vercel)
// Recibe el evento MESSAGES_UPSERT de Evolution y responde con un menú.
// No guarda secretos: usa la apikey de la instancia que Evolution manda en cada webhook,
// y solo acepta peticiones del servidor configurado en EVOLUTION_URL.

const EVOLUTION_URL = (process.env.EVOLUTION_URL || "https://evolution-soporte-mtto.onrender.com").replace(/\/+$/, "");
const ADMIN_NOTIFY_NUMBER = process.env.ADMIN_NOTIFY_NUMBER || ""; // opcional, ej. 5218100000000
const HUMAN_PAUSE_HOURS = 10 / 60; // si tú contestas a mano, el bot se calla 10 minutos
const OPTION_WINDOW_HOURS = 2; // tiempo para contestar el menú / mandar detalles
const AUTO_APP_SEG = 30; // un mensaje tuyo sin 🤖 enviado <30 s después del cliente = respuesta automática de la app

const TAG = "🤖"; // todos los mensajes del bot empiezan con esto (así distingue bot vs. humano)

const MENU =
  `${TAG} *Soporte Mantenimiento*\n` +
  `¡Hola{NOMBRE}! Responde con el *número* de la opción:\n\n` +
  `*1* · Maximo (OT / SR)\n` +
  `*2* · Planeación o reportes (Excel / Power BI)\n` +
  `*3* · Otro / hablar con el administrador\n\n` +
  `_Escribe *menu* en cualquier momento para ver estas opciones._`;

const OPCIONES = {
  "1": {
    nombre: "Maximo (OT / SR)",
    texto:
      `${TAG} *Maximo (OT / SR)*\n` +
      `Envía en *un solo mensaje*:\n` +
      `• Número de OT o SR (si lo tienes)\n` +
      `• Área / equipo\n` +
      `• Qué necesitas (crear, cerrar, modificar, consultar…)`,
  },
  "2": {
    nombre: "Planeación / reportes",
    texto:
      `${TAG} *Planeación o reportes (Excel / Power BI)*\n` +
      `Envía en *un solo mensaje*:\n` +
      `• Qué reporte o archivo\n` +
      `• Qué necesitas (dato, cambio, error, acceso…)\n` +
      `• Para cuándo lo necesitas`,
  },
  "3": {
    nombre: "Otro / administrador",
    texto:
      `${TAG} *Otro / administrador*\n` +
      `Cuéntame brevemente en *un solo mensaje* qué necesitas y el administrador te responde por aquí.`,
  },
};

const MARCA_PIDE_DETALLE = "Envía en *un solo mensaje*"; // presente en las 3 opciones
const MARCA_PIDE_DETALLE_3 = "Cuéntame brevemente";
const CONFIRMACION =
  `${TAG} ✅ *Solicitud recibida.*\n` +
  `El administrador la revisará y te responderá por este chat lo antes posible.\n` +
  `_Escribe *menu* si necesitas otra cosa._`;

// ---------------- utilidades ----------------
function textoDe(msg) {
  const m = msg?.message || {};
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedButtonId ||
    m.listResponseMessage?.singleSelectReply?.selectedRowId ||
    ""
  ).trim();
}

function ts(msg) {
  const t = Number(msg?.messageTimestamp || 0);
  return t > 1e12 ? t : t * 1000; // a milisegundos
}

function horasDesde(ms) {
  return (Date.now() - ms) / 36e5;
}

async function evo(serverUrl, apikey, path, body) {
  const r = await fetch(`${serverUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey },
    body: JSON.stringify(body),
  });
  const txt = await r.text();
  let json;
  try { json = JSON.parse(txt); } catch { json = txt; }
  if (!r.ok) throw new Error(`Evolution ${path} ${r.status}: ${txt.slice(0, 300)}`);
  return json;
}

async function enviar(serverUrl, apikey, instance, number, text) {
  return evo(serverUrl, apikey, `/message/sendText/${encodeURIComponent(instance)}`, {
    number,
    text,
    delay: 1500, // muestra "escribiendo…" 1.5 s (más natural, menos riesgo)
  });
}

async function historial(serverUrl, apikey, instance, jids) {
  // Busca en todos los identificadores del contacto (@lid y número real) y junta resultados
  const unicos = [...new Set(jids.filter(Boolean))];
  const vistos = new Set();
  const todos = [];
  for (const remoteJid of unicos) {
    const res = await evo(serverUrl, apikey, `/chat/findMessages/${encodeURIComponent(instance)}`, {
      where: { key: { remoteJid } },
      limit: 30,
    });
    const lista =
      res?.messages?.records || res?.records || (Array.isArray(res?.messages) ? res.messages : null) ||
      (Array.isArray(res) ? res : []);
    for (const m of lista) {
      const id = m?.key?.id;
      if (id && vistos.has(id)) continue;
      if (id) vistos.add(id);
      todos.push(m);
    }
  }
  return todos.sort((a, b) => ts(b) - ts(a)); // más reciente primero
}

// ---------------- lógica principal ----------------
async function decidir({ serverUrl, apikey, instance, jids, pushName, texto, msgId }) {
  const t = texto.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const nombre = pushName ? ` ${pushName.split(" ")[0]}` : "";
  const menu = MENU.replace("{NOMBRE}", nombre);

  if (t === "menu" || t === "menú" || t === "inicio") {
    return { responder: menu };
  }

  let previos = [];
  try {
    previos = (await historial(serverUrl, apikey, instance, jids)).filter(
      (m) => m?.key?.id !== msgId
    );
  } catch (e) {
    console.warn("No se pudo leer historial:", e.message);
  }

  // Ignora respuestas automáticas de la app WhatsApp Business (mensaje de bienvenida/ausencia):
  // son mensajes "míos" sin 🤖 que salen pocos segundos después de un mensaje del cliente.
  const esAutoApp = (m) => {
    if (textoDe(m).startsWith(TAG)) return false;
    const t0 = ts(m);
    return previos.some((x) => !x?.key?.fromMe && t0 - ts(x) >= 0 && t0 - ts(x) <= AUTO_APP_SEG * 1000);
  };
  const ultimoMio = previos.find((m) => m?.key?.fromMe && !esAutoApp(m));
  const textoMio = ultimoMio ? textoDe(ultimoMio) : "";
  const horasMio = ultimoMio ? horasDesde(ts(ultimoMio)) : Infinity;
  const esDelBot = textoMio.startsWith(TAG);

  // 1) Tú contestaste a mano hace poco -> el bot no se mete
  if (ultimoMio && !esDelBot && horasMio < HUMAN_PAUSE_HOURS) return { responder: null };

  if (esDelBot && horasMio < OPTION_WINDOW_HOURS) {
    // 2) El bot pidió detalles -> este mensaje es la solicitud
    if (textoMio.includes(MARCA_PIDE_DETALLE) || textoMio.includes(MARCA_PIDE_DETALLE_3)) {
      const opcion = Object.values(OPCIONES).find((o) => textoMio.includes(o.nombre.split(" ")[0]));
      return { responder: CONFIRMACION, solicitud: { opcion: opcion?.nombre || "?", texto } };
    }
    // 3) El bot mandó el menú -> esperamos 1, 2 o 3
    if (textoMio.includes("Responde con el *número*")) {
      if (OPCIONES[t]) return { responder: OPCIONES[t].texto };
      return { responder: `${TAG} No entendí 🙈 Responde solo con *1*, *2* o *3*.` };
    }
  }

  // 4) Ya se confirmó una solicitud hace poco -> silencio (la atiende el admin)
  if (esDelBot && textoMio.includes("Solicitud recibida") && horasMio < HUMAN_PAUSE_HOURS) {
    return { responder: null };
  }

  // 5) Si escribe directo 1/2/3 sin menú previo, igual lo atendemos
  if (OPCIONES[t]) return { responder: OPCIONES[t].texto };

  // 6) Cualquier otro caso -> menú
  return { responder: menu };
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({ ok: true, bot: "soporte-mantenimiento", evolution: EVOLUTION_URL || null });
  }
  if (req.method !== "POST") return res.status(405).end();

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const evento = String(body.event || "").toLowerCase().replace("_", ".");
    if (evento !== "messages.upsert") return res.status(200).json({ ignored: "event" });

    const serverUrl = String(body.server_url || "").replace(/\/+$/, "");
    if (!EVOLUTION_URL || serverUrl !== EVOLUTION_URL) {
      return res.status(403).json({ error: "server_url no permitido" });
    }
    const apikey = body.apikey;
    const instance = body.instance;
    const data = Array.isArray(body.data) ? body.data[0] : body.data;
    const key = data?.key || {};
    const remoteJid = key.remoteJid || "";

    if (key.fromMe) return res.status(200).json({ ignored: "fromMe" });
    if (!remoteJid || remoteJid.endsWith("@g.us") || remoteJid.includes("broadcast") || remoteJid.endsWith("@newsletter")) {
      return res.status(200).json({ ignored: "grupo/estado" });
    }
    // Mensajes viejos que llegan al sincronizar (más de 10 min) -> ignorar
    if (ts(data) && horasDesde(ts(data)) > 1 / 6) return res.status(200).json({ ignored: "viejo" });

    const texto = textoDe(data);
    const jids = [remoteJid, key.remoteJidAlt, key.senderPn];
    const r = await decidir({
      serverUrl, apikey, instance, jids,
      pushName: data?.pushName || "", texto, msgId: key.id,
    });

    // WhatsApp ahora usa identificadores "@lid"; respondemos al número real si viene
    const destino = key.remoteJidAlt || key.senderPn || remoteJid;
    if (r.responder) await enviar(serverUrl, apikey, instance, destino, r.responder);

    if (r.solicitud && ADMIN_NOTIFY_NUMBER) {
      const tel = (key.senderPn || key.remoteJidAlt || remoteJid).split("@")[0];
      await enviar(serverUrl, apikey, instance, ADMIN_NOTIFY_NUMBER,
        `${TAG} 📥 *Nueva solicitud*\n*De:* ${data?.pushName || "?"} (+${tel})\n*Tipo:* ${r.solicitud.opcion}\n*Detalle:* ${r.solicitud.texto || "(sin texto)"}`
      ).catch((e) => console.warn("Aviso admin falló:", e.message));
    }

    return res.status(200).json({ ok: true, respondio: !!r.responder });
  } catch (e) {
    console.error(e);
    return res.status(200).json({ ok: false, error: e.message }); // 200 para que Evolution no reintente en bucle
  }
}
