require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const path      = require('path');
const Database  = require('better-sqlite3');
const { Resend }= require('resend');
const rateLimit = require('express-rate-limit');
const crypto    = require('crypto');

const app = express();
app.use(cors({ origin: '*', methods: ['GET','POST','PATCH'], allowedHeaders: ['Content-Type','Authorization'] }));
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname)));

// ─── DATABASE ─────────────────────────────────────────────────
const db = new Database('reservas.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS reservas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    email TEXT,
    telefono TEXT,
    fecha TEXT NOT NULL,
    tipo_servicio TEXT NOT NULL,
    huespedes INTEGER NOT NULL,
    peticiones TEXT,
    precio INTEGER DEFAULT 0,
    estado TEXT DEFAULT 'confirmada',
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

// ─── RATE LIMITING ────────────────────────────────────────────
const chatLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 60,
  message: { error: 'Demasiadas peticiones. Espera antes de enviar más mensajes.' }
});
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  message: { error: 'Demasiados intentos. Espera 15 minutos.' }
});

// ─── ADMIN AUTH ───────────────────────────────────────────────
const activeSessions = new Map();
const SESSION_TTL = 24 * 60 * 60 * 1000;

function requireAdmin(req, res, next) {
  const token = (req.headers['authorization'] || '').replace('Bearer ', '');
  const session = activeSessions.get(token);
  if (!session || session.expiry < Date.now()) {
    activeSessions.delete(token);
    return res.status(401).json({ error: 'No autorizado. Inicia sesión.' });
  }
  next();
}

// ─── SERVICIOS ────────────────────────────────────────────────
const SERVICIOS = {
  medio_dia:    { nombre: 'Medio Día',    precio: 350, horario: 'Salida 9:00h o 14:00h · 4 horas' },
  dia_completo: { nombre: 'Día Completo', precio: 650, horario: 'Salida 9:30h · 8 horas' },
  sunset:       { nombre: 'Puesta de Sol',precio: 280, horario: 'Salida 18:00h · 3 horas' }
};

function disponible(fecha, tipo) {
  return db.prepare(
    `SELECT COUNT(*) as n FROM reservas WHERE fecha=? AND tipo_servicio=? AND estado!='cancelada'`
  ).get(fecha, tipo).n === 0;
}

// ─── AI ───────────────────────────────────────────────────────
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const resend  = new Resend(process.env.RESEND_API_KEY);

const tools = [
  {
    name: 'comprobar_disponibilidad',
    description: 'Comprueba si el barco está disponible para una fecha y tipo de servicio',
    input_schema: {
      type: 'object',
      properties: {
        fecha: { type: 'string', description: 'Fecha YYYY-MM-DD' },
        tipo_servicio: { type: 'string', enum: ['medio_dia','dia_completo','sunset'] }
      },
      required: ['fecha','tipo_servicio']
    }
  },
  {
    name: 'ver_disponibilidad_fecha',
    description: 'Ver todos los servicios disponibles para una fecha concreta',
    input_schema: {
      type: 'object',
      properties: { fecha: { type: 'string' } },
      required: ['fecha']
    }
  },
  {
    name: 'hacer_reserva',
    description: 'Realiza una reserva',
    input_schema: {
      type: 'object',
      properties: {
        nombre:       { type: 'string' },
        email:        { type: 'string' },
        telefono:     { type: 'string' },
        fecha:        { type: 'string' },
        tipo_servicio:{ type: 'string', enum: ['medio_dia','dia_completo','sunset'] },
        huespedes:    { type: 'number' },
        peticiones:   { type: 'string' }
      },
      required: ['nombre','fecha','tipo_servicio','huespedes']
    }
  }
];

const SYSTEM = `Eres el asistente virtual de Blue Motion Charter, empresa de excursiones en barco en Palma de Mallorca.
Responde SIEMPRE en el idioma del cliente (español, inglés o alemán). Detéctalo automáticamente.

EL BARCO:
- Motora deportiva de última generación, capacidad hasta 8 personas
- Snorkel, nevera, altavoz Bluetooth, toldo, plataforma de baño
- Amarrada en Marina Naviera Balear, Paseo Marítimo, Palma de Mallorca

SERVICIOS Y PRECIOS (precio por barco completo, no por persona):
- Medio Día (4h): 350€ — Salida 9:00h o 14:00h. Calas del sur: Cala Blava, Cala Pi.
- Día Completo (8h): 650€ — Salida 9:30h. Ruta completa sur, varias paradas.
- Puesta de Sol (3h): 280€ — Salida 18:00h. Cóctel de bienvenida incluido. El más romántico.

INCLUIDO: Patrón profesional (opcional si tienes licencia náutica), snorkel, nevera, música.
CAPACIDAD MÁX: 8 personas. TEMPORADA: 2026.
POLÍTICA: Cancelación gratuita hasta 48h antes.
CONTACTO: info@bluemotioncharter.com | +34 971 XXX XXX | Marina Naviera Balear, Palma.

FLUJO DE RESERVA: Pide nombre, email, teléfono (opcional), fecha, tipo de excursión y número de personas.
Comprueba siempre disponibilidad antes de confirmar.
Hoy es ${new Date().toISOString().split('T')[0]}.
Sé cercano, entusiasta del mar y profesional. Usa emojis ocasionalmente ⚓🌊🌅`;

function processTool(name, input) {
  if (name === 'comprobar_disponibilidad') {
    const s = SERVICIOS[input.tipo_servicio];
    const ok = disponible(input.fecha, input.tipo_servicio);
    return JSON.stringify({ disponible: ok, servicio: s?.nombre, precio: s?.precio, horario: s?.horario,
      mensaje: ok
        ? `Disponible. ${s?.nombre} el ${input.fecha}. Precio: ${s?.precio}€. ${s?.horario}.`
        : `No disponible para ${s?.nombre} el ${input.fecha}. Prueba otra fecha u otro servicio.`
    });
  }
  if (name === 'ver_disponibilidad_fecha') {
    const servicios = Object.entries(SERVICIOS).map(([k,s]) => ({
      tipo: k, nombre: s.nombre, precio: s.precio, horario: s.horario,
      disponible: disponible(input.fecha, k)
    }));
    return JSON.stringify({ fecha: input.fecha, servicios });
  }
  if (name === 'hacer_reserva') {
    if (!disponible(input.fecha, input.tipo_servicio))
      return JSON.stringify({ success: false, mensaje: 'No disponible. Prueba otra fecha u otro servicio.' });
    const s = SERVICIOS[input.tipo_servicio];
    const r = db.prepare(
      `INSERT INTO reservas (nombre,email,telefono,fecha,tipo_servicio,huespedes,peticiones,precio) VALUES(?,?,?,?,?,?,?,?)`
    ).run(input.nombre, input.email||'', input.telefono||'', input.fecha,
          input.tipo_servicio, input.huespedes, input.peticiones||'', s?.precio||0);
    const id = r.lastInsertRowid;
    if (input.email) {
      resend.emails.send({
        from: 'Summerboat <onboarding@resend.dev>', to: input.email,
        subject: `Reserva confirmada - Summerboat #SB-${id}`,
        html: `<div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:40px;border-top:4px solid #C8A44A;">
          <h1 style="color:#0B1D3A;font-weight:400;">Summerboat</h1>
          <h2 style="color:#C8A44A;font-weight:400;">¡Reserva confirmada! ⚓</h2>
          <p>Hola <strong>${input.nombre}</strong>, tu reserva #SB-${id} está confirmada.</p>
          <p><strong>${s?.nombre}</strong> · ${input.fecha} · ${s?.horario}</p>
          <p style="color:#6B7280;font-size:0.8rem;">Marina Naviera Balear, Paseo Marítimo 28, Palma · +34 671 XXX XXX</p>
        </div>`
      }).catch(e => console.error('Email error:', e.message));
    }
    return JSON.stringify({ success: true, id, mensaje: `Reserva #SB-${id} confirmada. ${s?.nombre} el ${input.fecha}.` });
  }
  return JSON.stringify({ error: 'Herramienta no encontrada' });
}

// ─── ENDPOINTS ────────────────────────────────────────────────

// Login
app.post('/admin/login', loginLimiter, (req, res) => {
  const { password } = req.body || {};
  const adminPass = process.env.ADMIN_PASSWORD;
  if (!adminPass) return res.status(500).json({ error: 'ADMIN_PASSWORD no configurada.' });
  if (!password || password !== adminPass) return res.status(401).json({ error: 'Contraseña incorrecta.' });
  const token = crypto.randomBytes(32).toString('hex');
  activeSessions.set(token, { expiry: Date.now() + SESSION_TTL });
  res.json({ token });
});

app.post('/admin/logout', (req, res) => {
  const token = (req.headers['authorization'] || '').replace('Bearer ', '');
  activeSessions.delete(token);
  res.json({ success: true });
});

// Chat IA
app.post('/chat', chatLimiter, async (req, res) => {
  try {
    const { messages } = req.body;
    if (messages?.length) {
      const last = messages[messages.length-1];
      const txt = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
      if (txt.length > 2000) return res.status(400).json({ error: 'Mensaje demasiado largo.' });
    }
    let msgs = [...messages];
    let resp = await client.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 1000,
      system: SYSTEM, tools, messages: msgs
    });
    while (resp.stop_reason === 'tool_use') {
      const tb = resp.content.find(b => b.type === 'tool_use');
      if (!tb) break;
      msgs = [...msgs,
        { role: 'assistant', content: resp.content },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: tb.id, content: processTool(tb.name, tb.input) }] }
      ];
      resp = await client.messages.create({
        model: 'claude-haiku-4-5-20251001', max_tokens: 1000,
        system: SYSTEM, tools, messages: msgs
      });
    }
    const txt = resp.content.find(b => b.type === 'text');
    res.json({ reply: txt ? txt.text : 'Lo siento, ha habido un error.' });
  } catch(e) {
    console.error('Chat error:', e.message);
    res.status(500).json({ error: 'Error al conectar con la IA' });
  }
});

// Reserva pública (formulario web)
app.post('/book', chatLimiter, (req, res) => {
  const { nombre, email, telefono, fecha, tipo_servicio, huespedes, peticiones } = req.body;
  if (!nombre || !fecha || !tipo_servicio || !huespedes)
    return res.status(400).json({ success: false, mensaje: 'Faltan datos.' });
  if (!disponible(fecha, tipo_servicio))
    return res.status(409).json({ success: false, mensaje: 'No hay disponibilidad. Elige otra fecha o contáctanos.' });
  const s = SERVICIOS[tipo_servicio];
  const r = db.prepare(
    `INSERT INTO reservas (nombre,email,telefono,fecha,tipo_servicio,huespedes,peticiones,precio) VALUES(?,?,?,?,?,?,?,?)`
  ).run(nombre, email||'', telefono||'', fecha, tipo_servicio, huespedes, peticiones||'', s?.precio||0);
  if (email) {
    resend.emails.send({
      from: 'Summerboat <onboarding@resend.dev>', to: email,
      subject: `Reserva confirmada - Summerboat #SB-${r.lastInsertRowid}`,
      html: `<div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:40px;border-top:4px solid #C8A44A;">
        <h1 style="color:#0B1D3A;font-weight:400;">Summerboat</h1>
        <h2 style="color:#C8A44A;font-weight:400;">¡Reserva confirmada! ⚓</h2>
        <p>Hola <strong>${nombre}</strong>, tu reserva #SB-${r.lastInsertRowid} está confirmada.</p>
        <p><strong>${s?.nombre}</strong> · ${fecha} · ${s?.horario}</p>
        <p style="color:#6B7280;font-size:0.8rem;">Marina Naviera Balear, Paseo Marítimo 28, Palma · +34 671 XXX XXX</p>
      </div>`
    }).catch(e => console.error('Email error:', e.message));
  }
  res.json({ success: true, id: r.lastInsertRowid });
});

// Disponibilidad pública (para el calendario)
app.get('/disponibilidad', (req, res) => {
  const { mes } = req.query;
  if (!mes) return res.status(400).json({ error: 'Falta parámetro mes (YYYY-MM)' });
  res.json(db.prepare(`SELECT fecha, tipo_servicio FROM reservas WHERE fecha LIKE ? AND estado!='cancelada'`).all(`${mes}%`));
});

// Admin — reservas
app.get('/admin/reservas', requireAdmin, (req, res) =>
  res.json(db.prepare('SELECT * FROM reservas ORDER BY fecha ASC, created_at DESC').all())
);
app.post('/admin/reservas', requireAdmin, (req, res) => {
  const { nombre, email, telefono, fecha, tipo_servicio, huespedes, peticiones } = req.body;
  if (!nombre || !fecha || !tipo_servicio || !huespedes)
    return res.status(400).json({ success: false, mensaje: 'Faltan datos.' });
  if (!disponible(fecha, tipo_servicio))
    return res.status(409).json({ success: false, mensaje: 'No hay disponibilidad para esa fecha y servicio.' });
  const s = SERVICIOS[tipo_servicio];
  const r = db.prepare(
    `INSERT INTO reservas (nombre,email,telefono,fecha,tipo_servicio,huespedes,peticiones,precio) VALUES(?,?,?,?,?,?,?,?)`
  ).run(nombre, email||'', telefono||'', fecha, tipo_servicio, huespedes, peticiones||'', s?.precio||0);
  res.json({ success: true, id: r.lastInsertRowid });
});
app.patch('/admin/reservas/:id/cancelar', requireAdmin, (req, res) => {
  db.prepare('UPDATE reservas SET estado=? WHERE id=?').run('cancelada', req.params.id);
  res.json({ success: true });
});

// Servir index
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Summerboat corriendo en http://localhost:${PORT}`));
