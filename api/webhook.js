// Bot de solicitudes de soporte para WhatsApp (Evolution API -> Vercel)
// Recibe el evento MESSAGES_UPSERT de Evolution y responde con un menú.
// No guarda secretos: usa la apikey de la instancia que Evolution manda en cada webhook,
// y solo acepta peticiones del servidor configurado en EVOLUTION_URL.

const EVOLUTION_URL = (process.env.EVOLUTION_URL || "https://evolution-soporte-mtto.onrender.com").replace(/\/+$/, "");
const ADMIN_NOTIFY_NUMBER = process.env.ADMIN_NOTIFY_NUMBER || ""; // opcional, ej. 5218100000000
const HUMAN_PAUSE_HOURS = 10 / 60; // si tú contestas a mano, el bot se calla 10 minutos
const OPTION_WINDOW_HOURS = 2; // tiempo para contestar el menú / mandar detalles
const AUTO_APP_SEG = 30; // un mensaje tuyo sin 🤖 enviado <30 s después del cliente = respuesta automática de la app
const ZONA = "America/Monterrey";
const FUERA_DESDE = "15:30"; // desde esta hora el bot avisa que el administrador no está
const FUERA_HASTA = "18:00"; // hasta esta hora (después Render se duerme)

const TAG = "🤖"; // todos los mensajes del bot empiezan con esto (así distingue bot vs. humano)

const NOMBRE_BOT = "Asistente Bot de Planeación John";
const LINEA = "━━━━━━━━━━━━━━━━";
const ENCABEZADO = `${TAG} *${NOMBRE_BOT}*`;
const REGRESAR = `🔁 _¿Necesitas otra cosa? En cualquier momento responde *1*, *2* o *3* para elegir otra opción._`;

const MENU =
  `${ENCABEZADO}\n${LINEA}\n` +
  `{SALUDO}\n` +
  `Soy tu asistente virtual 🧠⚡ ¿En qué te puedo apoyar?\n` +
  `Responde con el *número* de la opción:\n\n` +
  `1️⃣  🛠️ Maximo (OT / SR)\n` +
  `2️⃣  📊 Planeación o reportes (Excel / Power BI)\n` +
  `3️⃣  💬 Otro / hablar con el administrador\n` +
  `${LINEA}\n` +
  `🔁 _En cualquier momento puedes responder *1*, *2* o *3* para cambiar de opción._`;

const DESPEDIDA =
  `${ENCABEZADO}\n` +
  `🙌 ¡Fue un placer apoyarte! Saludos, que estés muy bien. 👋\n` +
  `${REGRESAR}`;

const INV = "\u2063"; // marca invisible: identifica la plantilla como mensaje del bot

// Plantilla que el usuario copia, llena y envía (va en un mensaje aparte para copiarla fácil)
const PLANTILLA =
  `${INV}Qué necesitas y para cuándo: \n` +
  `Nombre del solicitante: \n` +
  `Tipo de apoyo (Maximo OT/SR, Planeación/Reportes u Otro): \n` +
  `Número de OT, SR o reporte (si aplica): \n` +
  `Área / equipo (si aplica): `;

const INSTRUCCION =
  `Mantén presionado el siguiente mensaje 👇, *cópialo*, llénalo y envíalo en *un solo mensaje*.`;

const OPCIONES = {
  "1": {
    nombre: "Maximo (OT / SR)",
    texto: `${ENCABEZADO}\n🛠️ *Maximo (OT / SR)* — opción seleccionada ✅\n\n📝 ${INSTRUCCION}`,
  },
  "2": {
    nombre: "Planeación / reportes",
    texto: `${ENCABEZADO}\n📊 *Planeación o reportes (Excel / Power BI)* — opción seleccionada ✅\n\n📝 ${INSTRUCCION}`,
  },
  "3": {
    nombre: "Otro / administrador",
    texto: `${ENCABEZADO}\n💬 *Otro / administrador* — opción seleccionada ✅\n\n📝 ${INSTRUCCION}`,
  },
};

const MARCA_PIDE_DETALLE = "en *un solo mensaje*"; // presente en las 3 opciones
const CONFIRMACION =
  `${ENCABEZADO}\n` +
  `✅ *Solicitud recibida y registrada.* 📥\n` +
  `El administrador la revisará y te responderá por este chat lo antes posible. ⏱️\n\n` +
  `${REGRESAR}`;

const FUERA_HORARIO =
  `${ENCABEZADO}\n${LINEA}\n` +
  `{SALUDO}\n` +
  `🕒 *Fuera de horario laboral*\n` +
  `El administrador no está disponible en este momento (atención de 6:00 a 15:30, lunes a sábado).\n\n` +
  `📝 Por favor deja tu solicitud *completa*. ${INSTRUCCION}\n\n` +
  `📅 Se revisará a primera hora del siguiente día hábil. ¡Gracias!`;

const CONFIRMACION_FUERA =
  `${ENCABEZADO}\n` +
  `✅ *Solicitud recibida y registrada.* 📥\n` +
  `📅 Se revisará a primera hora del siguiente día hábil. ¡Gracias!`;

// ---------------- utilidades ----------------
function normalizar(txt) {
  return txt.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9ñ\s]/g, " ").replace(/\s+/g, " ").trim();
}
const RE_SALUDO = /^(hola+|holi|buen(os)? dia(s)?|buenas( tardes| noches| dias)?|buen dia|que onda|hey|saludos cordiales)\b/;
const RE_COMO_ESTAS = /\b(como (estas|esta|te va|le va|va todo|andas|amaneciste)|que tal)\b/;
const RE_GRACIAS = /\b(gracias|grax|thank|saludos|hasta luego|hasta pronto|bye|adios|nos vemos|buen fin|bonito dia|excelente dia|que este(s)? bien)\b/;

function saludoSegunHora(nombre) {
  const h = Math.floor(minutosLocal() / 60);
  if (h < 12) return `☀️ ¡Buenos días${nombre}! Un gusto saludarte.`;
  if (h < 19) return `🌤️ ¡Buenas tardes${nombre}! Un gusto saludarte.`;
  return `🌙 ¡Buenas noches${nombre}! Un gusto saludarte.`;
}

function minutosLocal(fecha = new Date()) {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: ZONA, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(fecha);
  const h = Number(p.find((x) => x.type === "hour").value);
  const m = Number(p.find((x) => x.type === "minute").value);
  return h * 60 + m;
}
function aMin(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}
function esFueraDeHorario(fecha = new Date()) {
  const ahora = minutosLocal(fecha);
  return ahora >= aMin(FUERA_DESDE) && ahora < aMin(FUERA_HASTA);
}

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
  const n = normalizar(texto);
  const nombre = ""; // no se usa el nombre de la persona en el saludo
  const corto = n.length <= 60 && !n.includes("solicitante");

  const esSaludo = corto && RE_SALUDO.test(n);
  const preguntaComoEstas = corto && RE_COMO_ESTAS.test(n);
  const esGracias = corto && RE_GRACIAS.test(n) && !esSaludo;

  let saludo = `👋 ¡Hola${nombre}!`;
  if (esSaludo) saludo = saludoSegunHora(nombre);
  if (preguntaComoEstas) saludo = (esSaludo ? saludo + "\n" : "") + `😊 ¡Todo en orden, gracias por preguntar${esSaludo ? "" : nombre}!`;
  const menu = MENU.replace("{SALUDO}", saludo);

  let previos = [];
  try {
    previos = (await historial(serverUrl, apikey, instance, jids)).filter((m) => m?.key?.id !== msgId);
  } catch (e) {
    console.warn("No se pudo leer historial:", e.message);
  }

  // Ignora respuestas automáticas de la app WhatsApp Business (mensaje de bienvenida/ausencia):
  // son mensajes "míos" sin 🤖 que salen pocos segundos después de un mensaje del cliente.
  const esAutoApp = (m) => {
    if (textoDe(m).startsWith(TAG) || textoDe(m).startsWith(INV)) return false;
    const t0 = ts(m);
    return previos.some((x) => !x?.key?.fromMe && t0 - ts(x) >= 0 && t0 - ts(x) <= AUTO_APP_SEG * 1000);
  };
  const ultimoMio = previos.find((m) => m?.key?.fromMe && !esAutoApp(m) && !textoDe(m).startsWith(INV));
  const textoMio = ultimoMio ? textoDe(ultimoMio) : "";
  const horasMio = ultimoMio ? horasDesde(ts(ultimoMio)) : Infinity;
  const esDelBot = textoMio.startsWith(TAG);

  // 1) Tú contestaste a mano hace poco -> el bot no se mete
  if (ultimoMio && !esDelBot && horasMio < HUMAN_PAUSE_HOURS) return { responder: null };

  // 2) Gracias / saludos de despedida -> se despide (una vez)
  if (esGracias) {
    if (esDelBot && textoMio.includes("placer apoyarte") && horasMio < HUMAN_PAUSE_HOURS) return { responder: null };
    return { responder: DESPEDIDA };
  }

  // 3) Fuera de horario (15:30–18:00): avisa una vez, recibe la solicitud y confirma
  if (esFueraDeHorario()) {
    if (!esSaludo && !preguntaComoEstas) {
      if (esDelBot && textoMio.includes("Fuera de horario") && horasMio < 3) {
        return { responder: CONFIRMACION_FUERA, solicitud: { opcion: "Fuera de horario", texto } };
      }
      if (esDelBot && textoMio.includes("Solicitud recibida") && horasMio < 3) return { responder: null };
    }
    return { responder: [FUERA_HORARIO.replace("{SALUDO}", saludo), PLANTILLA] };
  }

  // 4) Saludo, "¿cómo estás?" o "menu" -> saludo cordial + opciones
  if (esSaludo || preguntaComoEstas || t === "menu" || t === "menú" || t === "inicio" || t === "opciones") {
    return { responder: menu };
  }

  // 5) Eligió (o cambió a) una opción 1, 2 o 3 -> en cualquier momento
  if (OPCIONES[t]) return { responder: [OPCIONES[t].texto, PLANTILLA] };

  if (esDelBot && horasMio < OPTION_WINDOW_HOURS) {
    // 6) El bot pidió detalles -> este mensaje es la solicitud
    if (textoMio.includes(MARCA_PIDE_DETALLE) && !textoMio.includes("Fuera de horario")) {
      const opcion = Object.values(OPCIONES).find((o) => textoMio.includes(o.nombre.split(" ")[0]));
      return { responder: CONFIRMACION, solicitud: { opcion: opcion?.nombre || "?", texto } };
    }
    // 7) El bot mandó el menú y no contestó 1, 2 o 3
    if (textoMio.includes("Responde con el *número*")) {
      return { responder: `${ENCABEZADO}\n🙈 No entendí tu respuesta.\n👉 Responde solo con *1*, *2* o *3*.` };
    }
  }

  // 8) Ya se confirmó una solicitud hace poco -> silencio (la atiende el admin)
  if (esDelBot && textoMio.includes("Solicitud recibida") && horasMio < HUMAN_PAUSE_HOURS) {
    return { responder: null };
  }

  // 8b) Ya se despidió hace poco -> silencio (ej. "ok", "👍")
  if (esDelBot && textoMio.includes("placer apoyarte") && horasMio < HUMAN_PAUSE_HOURS) {
    return { responder: null };
  }

  // 9) Cualquier otro caso -> saludo + menú
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
    const mensajes = Array.isArray(r.responder) ? r.responder : r.responder ? [r.responder] : [];
    for (const m of mensajes) await enviar(serverUrl, apikey, instance, destino, m);

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
