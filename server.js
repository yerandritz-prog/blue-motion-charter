require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
const Database = require('better-sqlite3');
const { Resend } = require('resend');

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PATCH'], allowedHeaders: ['Content-Type'] }));
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ─── BASE DE DATOS ────────────────────────────────────────────
const db = new Database('reservas.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS reservas_charter (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    email TEXT,
    telefono TEXT,
    fecha TEXT NOT NULL,
    tipo_excursion TEXT NOT NULL,
    con_patron INTEGER DEFAULT 1,
    personas INTEGER NOT NULL,
    peticiones TEXT,
    estado TEXT DEFAULT 'confirmada',
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

// ─── EMAIL ────────────────────────────────────────────────────
const resend = new Resend(process.env.RESEND_API_KEY);

const EXCURSIONES = {
  'medio_dia':     { nombre: 'Medio día (4h)',       precio: 350,  horas: 4, descripcion: 'Salida 9:00h o 14:00h · Ruta costera con paradas para baño' },
  'dia_completo':  { nombre: 'Día completo (8h)',     precio: 650,  horas: 8, descripcion: 'Salida 9:30h · Ruta por calas de Palma con almuerzo a bordo' },
  'puesta_de_sol': { nombre: 'Puesta de sol (3h)',    precio: 280,  horas: 3, descripcion: 'Salida 18:00h · Navegación al atardecer con cóctel de bienvenida' }
};

const PATRON_PRECIO = 100; // precio adicional si no se tiene licencia

async function enviarConfirmacion(reserva) {
  if (!reserva.email) return;
  const exc = EXCURSIONES[reserva.tipo_excursion];
  const conPatron = reserva.con_patron ? 'Con patrón incluido' : 'Sin patrón (licencia propia)';
  try {
    await resend.emails.send({
      from: 'Blue Motion Charter <onboarding@resend.dev>',
      to: reserva.email,
      subject: `Reserva confirmada - Blue Motion Charter #BM-${reserva.id}`,
      html: `<div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:40px;border-top:4px solid #0A3D6B;">
        <h1 style="color:#0A3D6B;font-weight:400;">Blue Motion Charter</h1>
        <p style="color:#6B7280;font-size:0.8rem;text-transform:uppercase;letter-spacing:0.2em;">Naviera Balear · Palma de Mallorca</p>
        <h2 style="color:#0A3D6B;font-weight:400;">¡Reserva confirmada!</h2>
        <p>Hola <strong>${reserva.nombre}</strong>, tu reserva ha sido confirmada. ¡Nos vemos en el mar!</p>
        <table style="width:100%;border-collapse:collapse;margin-top:16px;">
          <tr><td style="color:#6B7280;padding:10px 0;border-bottom:1px solid #f3f4f6;">Referencia</td><td style="color:#0A3D6B;padding:10px 0;border-bottom:1px solid #f3f4f6;font-weight:500;">#BM-${reserva.id}</td></tr>
          <tr><td style="color:#6B7280;padding:10px 0;border-bottom:1px solid #f3f4f6;">Excursión</td><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;">${exc ? exc.nombre : reserva.tipo_excursion}</td></tr>
          <tr><td style="color:#6B7280;padding:10px 0;border-bottom:1px solid #f3f4f6;">Fecha</td><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;">${reserva.fecha}</td></tr>
          <tr><td style="color:#6B7280;padding:10px 0;border-bottom:1px solid #f3f4f6;">Personas</td><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;">${reserva.personas}</td></tr>
          <tr><td style="color:#6B7280;padding:10px 0;border-bottom:1px solid #f3f4f6;">Patrón</td><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;">${conPatron}</td></tr>
          <tr><td style="color:#6B7280;padding:10px 0;">Punto de encuentro</td><td style="padding:10px 0;">Naviera Balear, Paseo Marítimo, Palma</td></tr>
        </table>
        <p style="color:#6B7280;font-size:0.85rem;margin-top:2rem;line-height:1.6;">
          ⚓ Llega 15 minutos antes de la salida<br>
          🧴 Trae protector solar, toalla y calzado de goma<br>
          📞 Cancelación gratuita hasta 48h antes: +34 971 XXX XXX
        </p>
        <p style="color:#0A3D6B;font-size:0.9rem;margin-top:1.5rem;font-weight:500;">¡Hasta pronto en el mar! 🌊</p>
      </div>`
    });
  } catch (e) {
    console.error('Error email:', e.message);
  }
}

async function enviarNotificacionAdmin(reserva) {
  if (!process.env.ADMIN_EMAIL) return;
  const exc = EXCURSIONES[reserva.tipo_excursion];
  try {
    await resend.emails.send({
      from: 'Blue Motion Bot <onboarding@resend.dev>',
      to: process.env.ADMIN_EMAIL,
      subject: `⚓ Nueva reserva #BM-${reserva.id} - ${reserva.nombre} (${exc ? exc.nombre : reserva.tipo_excursion})`,
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:30px;border-top:4px solid #0A3D6B;">
        <h2 style="color:#0A3D6B;">Nueva reserva - Blue Motion Charter</h2>
        <table style="width:100%;border-collapse:collapse;margin-top:20px;">
          <tr style="background:#f0f7ff;"><td style="padding:10px;font-weight:bold;">ID</td><td style="padding:10px;">#BM-${reserva.id}</td></tr>
          <tr><td style="padding:10px;font-weight:bold;">Nombre</td><td style="padding:10px;">${reserva.nombre}</td></tr>
          <tr style="background:#f0f7ff;"><td style="padding:10px;font-weight:bold;">Email</td><td style="padding:10px;">${reserva.email || '-'}</td></tr>
          <tr><td style="padding:10px;font-weight:bold;">Teléfono</td><td style="padding:10px;">${reserva.telefono || '-'}</td></tr>
          <tr style="background:#f0f7ff;"><td style="padding:10px;font-weight:bold;">Excursión</td><td style="padding:10px;">${exc ? exc.nombre : reserva.tipo_excursion}</td></tr>
          <tr><td style="padding:10px;font-weight:bold;">Fecha</td><td style="padding:10px;">${reserva.fecha}</td></tr>
          <tr style="background:#f0f7ff;"><td style="padding:10px;font-weight:bold;">Personas</td><td style="padding:10px;">${reserva.personas}</td></tr>
          <tr><td style="padding:10px;font-weight:bold;">Patrón</td><td style="padding:10px;">${reserva.con_patron ? 'Sí (incluido)' : 'No (licencia propia)'}</td></tr>
          <tr style="background:#f0f7ff;"><td style="padding:10px;font-weight:bold;">Peticiones</td><td style="padding:10px;">${reserva.peticiones || '-'}</td></tr>
        </table>
      </div>`
    });
  } catch (e) {
    console.error('Error email admin:', e.message);
  }
}

// ─── DISPONIBILIDAD ───────────────────────────────────────────
function hayDisponibilidad(fecha, tipo_excursion) {
  // Un solo barco — máximo 1 excursión por tipo por día
  const r = db.prepare(`
    SELECT COUNT(*) as total FROM reservas_charter
    WHERE fecha = ? AND tipo_excursion = ? AND estado != 'cancelada'
  `).get(fecha, tipo_excursion);
  return (r.total || 0) === 0;
}

function excursionesDisponibles(fecha) {
  return Object.entries(EXCURSIONES)
    .filter(([key]) => hayDisponibilidad(fecha, key))
    .map(([key, exc]) => ({ tipo: key, ...exc }));
}

function crearReserva(datos) {
  const result = db.prepare(`
    INSERT INTO reservas_charter (nombre, email, telefono, fecha, tipo_excursion, con_patron, personas, peticiones)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    datos.nombre,
    datos.email || '',
    datos.telefono || '',
    datos.fecha,
    datos.tipo_excursion,
    datos.con_patron ? 1 : 0,
    datos.personas,
    datos.peticiones || ''
  );
  return result.lastInsertRowid;
}

// ─── TOOLS IA ─────────────────────────────────────────────────
const tools = [
  {
    name: 'comprobar_disponibilidad',
    description: 'Comprueba si hay disponibilidad para una excursión en una fecha concreta',
    input_schema: {
      type: 'object',
      properties: {
        fecha: { type: 'string', description: 'Fecha de la excursión en formato YYYY-MM-DD' },
        tipo_excursion: { type: 'string', enum: ['medio_dia', 'dia_completo', 'puesta_de_sol'] }
      },
      required: ['fecha', 'tipo_excursion']
    }
  },
  {
    name: 'ver_excursiones_disponibles',
    description: 'Muestra qué excursiones hay disponibles en una fecha',
    input_schema: {
      type: 'object',
      properties: {
        fecha: { type: 'string', description: 'Fecha en formato YYYY-MM-DD' }
      },
      required: ['fecha']
    }
  },
  {
    name: 'hacer_reserva',
    description: 'Realiza una reserva de excursión en barco',
    input_schema: {
      type: 'object',
      properties: {
        nombre: { type: 'string', description: 'Nombre completo del cliente' },
        email: { type: 'string', description: 'Email del cliente' },
        telefono: { type: 'string', description: 'Teléfono del cliente' },
        fecha: { type: 'string', description: 'Fecha en formato YYYY-MM-DD' },
        tipo_excursion: { type: 'string', enum: ['medio_dia', 'dia_completo', 'puesta_de_sol'] },
        con_patron: { type: 'boolean', description: 'true si quieren patrón incluido, false si tienen licencia propia' },
        personas: { type: 'number', description: 'Número de personas (máximo 8)' },
        peticiones: { type: 'string', description: 'Peticiones especiales o alergias' }
      },
      required: ['nombre', 'fecha', 'tipo_excursion', 'con_patron', 'personas']
    }
  },
  {
    name: 'cancelar_reserva',
    description: 'Cancela una reserva por nombre y fecha',
    input_schema: {
      type: 'object',
      properties: {
        nombre: { type: 'string' },
        fecha: { type: 'string' }
      },
      required: ['nombre', 'fecha']
    }
  }
];

const SYSTEM_PROMPT = `Eres el asistente virtual de Blue Motion Charter, empresa de alquiler de barcos a motor en Palma de Mallorca. Estás ubicado en la marina Naviera Balear, en el Paseo Marítimo de Palma.
Responde SIEMPRE en el idioma del cliente (español, inglés o alemán). Sé amable, breve y profesional.

EL BARCO:
- Motora moderna con capacidad para hasta 8 personas
- Equipada con nevera, equipo de snorkel, escalera de baño, altavoz bluetooth y toldo
- Anclada en Naviera Balear, Paseo Marítimo de Palma

EXCURSIONES DISPONIBLES:
- medio_dia: Medio día (4 horas) · 350€/salida · Salida 9:00h o 14:00h · Ruta costera con paradas para baño en cala Blava y Cala Pi
- dia_completo: Día completo (8 horas) · 650€/salida · Salida 9:30h · Ruta completa por las mejores calas del sur con almuerzo a bordo (traído por los clientes)
- puesta_de_sol: Puesta de sol (3 horas) · 280€/salida · Salida 18:00h · Navegación al atardecer con cóctel de bienvenida incluido

PATRÓN:
- Con patrón incluido: sin coste adicional (recomendado si no tienen licencia)
- Sin patrón: el cliente asume el mando si tiene licencia náutica

POLÍTICA:
- Precio por salida completa del barco (no por persona) — perfecto para grupos
- Capacidad máxima: 8 personas
- Cancelación gratuita hasta 48h antes
- Punto de encuentro: Naviera Balear, Paseo Marítimo s/n, Palma. Llegar 15 min antes.

PARA RESERVAR necesitas: nombre, email, teléfono, fecha, tipo de excursión, si quieren patrón y número de personas.

Usa SIEMPRE las herramientas para comprobar disponibilidad antes de confirmar una reserva.

Hoy es ${new Date().toISOString().split('T')[0]}.`;

function processTool(toolName, toolInput) {
  if (toolName === 'comprobar_disponibilidad') {
    const disponible = hayDisponibilidad(toolInput.fecha, toolInput.tipo_excursion);
    const exc = EXCURSIONES[toolInput.tipo_excursion];
    return JSON.stringify({
      disponible,
      excursion: exc ? exc.nombre : toolInput.tipo_excursion,
      precio: exc ? exc.precio : null,
      descripcion: exc ? exc.descripcion : '',
      mensaje: disponible
        ? `Disponible. Precio: ${exc.precio}€ por salida completa del barco.`
        : `No hay disponibilidad para ${exc ? exc.nombre : toolInput.tipo_excursion} en esa fecha. Prueba otra fecha u otra excursión.`
    });
  }
  if (toolName === 'ver_excursiones_disponibles') {
    const disponibles = excursionesDisponibles(toolInput.fecha);
    return JSON.stringify({
      fecha: toolInput.fecha,
      disponibles,
      mensaje: disponibles.length > 0
        ? `Disponibles el ${toolInput.fecha}: ${disponibles.map(e => `${e.nombre} (${e.precio}€)`).join(', ')}`
        : `No hay excursiones disponibles el ${toolInput.fecha}. Prueba otra fecha.`
    });
  }
  if (toolName === 'hacer_reserva') {
    if (toolInput.personas > 8) {
      return JSON.stringify({ success: false, mensaje: 'La capacidad máxima del barco es de 8 personas.' });
    }
    if (!hayDisponibilidad(toolInput.fecha, toolInput.tipo_excursion)) {
      return JSON.stringify({ success: false, mensaje: 'No hay disponibilidad para esa excursión en esa fecha. Prueba otra fecha.' });
    }
    const id = crearReserva(toolInput);
    const reserva = { id, ...toolInput };
    enviarConfirmacion(reserva);
    enviarNotificacionAdmin(reserva);
    const exc = EXCURSIONES[toolInput.tipo_excursion];
    return JSON.stringify({
      success: true,
      id,
      mensaje: `¡Reserva #BM-${id} confirmada! ${exc ? exc.nombre : ''} el ${toolInput.fecha} para ${toolInput.personas} personas. Se enviará confirmación por email. Punto de encuentro: Naviera Balear, Paseo Marítimo, Palma.`
    });
  }
  if (toolName === 'cancelar_reserva') {
    const reserva = db.prepare(`
      SELECT * FROM reservas_charter WHERE LOWER(nombre) = LOWER(?) AND fecha = ? AND estado != 'cancelada'
    `).get(toolInput.nombre, toolInput.fecha);
    if (!reserva) return JSON.stringify({ success: false, mensaje: 'No se encontró ninguna reserva. Verifica el nombre y la fecha.' });
    db.prepare('UPDATE reservas_charter SET estado = ? WHERE id = ?').run('cancelada', reserva.id);
    return JSON.stringify({ success: true, mensaje: `Reserva #BM-${reserva.id} cancelada correctamente.` });
  }
  return JSON.stringify({ error: 'Herramienta no encontrada' });
}

// ─── ENDPOINTS ────────────────────────────────────────────────
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.post('/chat', async (req, res) => {
  try {
    const { messages } = req.body;
    let currentMessages = [...messages];
    let response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      tools,
      messages: currentMessages
    });
    while (response.stop_reason === 'tool_use') {
      const toolBlock = response.content.find(b => b.type === 'tool_use');
      if (!toolBlock) break;
      const result = processTool(toolBlock.name, toolBlock.input);
      currentMessages = [
        ...currentMessages,
        { role: 'assistant', content: response.content },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolBlock.id, content: result }] }
      ];
      response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        system: SYSTEM_PROMPT,
        tools,
        messages: currentMessages
      });
    }
    const textBlock = response.content.find(b => b.type === 'text');
    res.json({ reply: textBlock ? textBlock.text : 'Lo siento, ha habido un error.' });
  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ error: 'Error al conectar con la IA' });
  }
});

app.get('/reservas', (req, res) => res.json(db.prepare('SELECT * FROM reservas_charter ORDER BY fecha DESC').all()));
app.patch('/reservas/:id/cancelar', (req, res) => {
  db.prepare('UPDATE reservas_charter SET estado = ? WHERE id = ?').run('cancelada', req.params.id);
  res.json({ success: true });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Blue Motion Charter corriendo en http://localhost:${PORT}`));
