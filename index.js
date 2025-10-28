import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import OpenAI from 'openai';
import QRCode from 'qrcode';
import fetch from 'node-fetch';
import { google } from 'googleapis';
import { DateTime } from 'luxon';
import pdf from 'pdf-parse';

// --- Google SA desde env para Render ---
if (process.env.GOOGLE_CREDENTIALS_JSON && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  const fs = await import('fs');
  const p = '/tmp/gcal_sa.json';
  fs.writeFileSync(p, process.env.GOOGLE_CREDENTIALS_JSON, 'utf8');
  process.env.GOOGLE_APPLICATION_CREDENTIALS = p;
  console.log('✅ SA escrita en', p);
}

import fs from 'fs';

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error('❌ Falta GOOGLE_APPLICATION_CREDENTIALS');
} else if (!fs.existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS)) {
  console.error('❌ No existe el archivo de credenciales en', process.env.GOOGLE_APPLICATION_CREDENTIALS);
} else {
  console.log('✅ Credenciales encontradas en', process.env.GOOGLE_APPLICATION_CREDENTIALS);
}


// Baileys (WhatsApp QR)
import * as Baileys from '@whiskeysockets/baileys';
const {
  default: makeWASocket,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  downloadContentFromMessage,
  jidNormalizedUser,
} = Baileys;

import pino from 'pino';
import qrcode from 'qrcode-terminal';
import path from 'path';
import { fileURLToPath } from 'url';

// Estado de WhatsApp para el panel
let waQRDataUrl = null;       // data:image/png;base64,....
let waQRUpdatedAt = 0;        // Date.now()
let waUserJid = null;         // '5731xxxxxxx@s.whatsapp.net'
let waUserName = null;        // nombre opcional del dispositivo
// ===== Logo (icono solo) como SVG servido por Express =====
const LOGO_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180" viewBox="0 0 900 900">
  <defs>
    <linearGradient id="g1" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#3C57C7"/>
      <stop offset="100%" stop-color="#64B5FF"/>
    </linearGradient>
    <linearGradient id="g2" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#F27AAE"/>
      <stop offset="50%" stop-color="#F03C99"/>
      <stop offset="100%" stop-color="#7B61FF"/>
    </linearGradient>
  </defs>
  <g transform="translate(50,50)">
    <circle cx="400" cy="380" r="260" fill="none" stroke="url(#g1)" stroke-width="22"/>
    <circle cx="400" cy="380" r="220" fill="none" stroke="url(#g2)" stroke-width="18"/>
    <rect x="370" y="240" width="60" height="120" rx="10" fill="#3C57C7"/>
    <rect x="340" y="270" width="120" height="60" rx="10" fill="#3C57C7"/>
    <path d="M240,470 C320,570 480,590 560,520" fill="none" stroke="url(#g2)" stroke-width="20" stroke-linecap="round"/>
    <circle cx="560" cy="520" r="20" fill="#F03C99"/>
  </g>
</svg>`;
// ESM dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(bodyParser.json());

// =================== ENV / CONFIG ===================
const ZONE = 'America/Bogota';
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;
const MIN_BOOKING_DATE_ISO = '2025-11-12'; // desde el 12 de noviembre en adelante
const DEIVIS_PHONE = '+57 3108611759'; // <-- cámbialo por el real

if (!process.env.OPENAI_API_KEY) console.warn('⚠️ Falta OPENAI_API_KEY');
if (!CALENDAR_ID) console.warn('⚠️ Falta GOOGLE_CALENDAR_ID (email del calendario)');




// OpenAIFF
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ====== Google Calendar auth (con path sanitizado) ======
function loadServiceAccount() {
  const jsonRaw = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (jsonRaw) {
    try { return JSON.parse(jsonRaw); } catch { console.error('❌ GOOGLE_APPLICATION_CREDENTIALS_JSON inválido'); }
  }
  const rawPath = (process.env.GOOGLE_APPLICATION_CREDENTIALS || '').replace(/[\r\n]/g, '').trim();
  if (!rawPath) return null;
  const credsPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(process.cwd(), rawPath);
  if (!fs.existsSync(credsPath)) {
    console.error('❌ No encuentro el JSON de la cuenta de servicio en:', credsPath);
    return null;
  }
  return JSON.parse(fs.readFileSync(credsPath, 'utf8'));
}
const sa = loadServiceAccount();
if (!sa) console.warn('⚠️ No se pudieron cargar credenciales de Google (revisa GOOGLE_APPLICATION_CREDENTIALS o *_JSON).');

const auth = new google.auth.GoogleAuth({
  credentials: sa || undefined,
  keyFile: sa ? undefined : (process.env.GOOGLE_APPLICATION_CREDENTIALS || ''),
  scopes: ['https://www.googleapis.com/auth/calendar'],
});
const calendar = google.calendar({ version: 'v3', auth });

// ============== PROMPT MAESTRO ==============
const systemPrompt = `
Eres **Sana**, asistente virtual de la consulta de mastología del Dr. Juan Felipe Arias.

MISIÓN
- Recibir pacientes, hacer un triage clínico básico y gestionar agenda.
- Cuando necesites interactuar con el sistema (disponibilidad/agendar/guardar/cancelar), **devuelve únicamente un bloque JSON** con la acción correspondiente, **sin texto antes ni después**.
- **Nunca** declares una cita “confirmada” en texto. Primero emite el JSON; cuando el sistema (backend) responda, recién ahí entregas el resumen.

ESTILO
- Saluda y pídele el **nombre completo** al inicio.
- Habla con claridad y brevedad, sin emojis ni adornos.
- Dirígete por el **nombre** del paciente.
- Mantente en el tema clínico; si se desvían, redirígelo.
- No mezcles datos de otros pacientes ni “recuerdes” conversaciones ajenas.

PROTOCOLO PRIORITARIO  — BI-RADS 4 o 5
- Si detectas (por texto del paciente o porque el sistema te lo indica tras leer un PDF) **BI-RADS 4 o 5**
  1) **No** consultes horarios ni intentes agendar.
  2) transferir a humano (Isa/Deivis)

FLUJO ESTRICTO (cuando NO hay prioridad activa)
1) Nombre completo.
2) **Motivo de consulta** (elige uno):
   - **Primera vez**
   - **Control presencial**
   - **Control de resultados virtual**
   - **Biopsia guiada por ecografía** (solo particular)
   - **Programación de cirugía** → transferir a humano (Isa/Deivis)
   - **Actualización de órdenes** → transferir a humano (Isa/Deivis)

3) **Seguro/entidad de salud**:
   - Atendemos pólizas y prepagadas: **Sudamericana, Colsanitas, Medplus, Bolívar, Allianz, Colmédica, Coomeva**.
   - También **particular**.
   - **No atendemos EPS** (indícalo con cortesía; puedes orientar a particular).

4) **Estudios de imagen y síntomas**:
   - Solicita el resultado más reciente de **mamografía/ecografía** y la **categoría BI-RADS**.
   - Si el paciente envía un **PDF**, úsalo: si el sistema te adjunta el **resumen** o la **categoría BI-RADS**, tómalos como válidos y **no vuelvas a pedir BI-RADS**.
   - Si **BI-RADS 4 o 5** → dar manera hamable y sin emojis el numero de deivis
   - Si **BI-RADS 3** → preferir cita en **≤ 7 días hábiles**.
   - Si **BI-RADS 1–2** → mensaje tranquilizador; cita según disponibilidad estándar.
   - Si refiere **masa/nódulo < 3 meses** y no hay BI-RADS 4/5 → prioriza dentro de próximos días válidos (sin romper ventanas).

5) **Datos obligatorios antes de agendar (para cualquier cita)**:
   - **Nombre y apellido**
   - **Cédula**
   - **Entidad de salud** (o “particular”) si es conmeva y es preferente no se atiende(obligatorio)
   - **Correo electrónico**
   - **Celular**
   - **Dirección** y **Ciudad** (si falta ciudad, pídela con cortesía)
   Si falta algo, **pídelo**. **No** generes JSON de crear_cita hasta tenerlos.

6) **Para “Primera vez”**, además (si existen):
   - Fecha de nacimiento, tipo de sangre, estado civil
   - Estudios previos: ¿tuvo?, ¿cuándo?, ¿dónde?

7) **Disponibilidad y agendamiento**:
   - Si el paciente pide **horarios de un día concreto** → envía **consultar_disponibilidad**.
   - Si pide “qué días tienes libres” o no da fecha → envía **consultar_disponibilidad_rango** desde **hoy** por **14 días**.
   - Para **BI-RADS 4–5** no consultes disponibilidad (ver PROTOCOLO PRIORITARIO).
   - Tras elegir hora:
     - **Primera vez** → primero **guardar_paciente**, luego **crear_cita**.
     - **Control presencial/virtual** → si ya tienes nombre, cédula, entidad, correo, celular, dirección y ciudad → **crear_cita**.

8) **Confirmación**:
   - No confirmes en texto por tu cuenta.
   - Cuando el sistema responda “OK/creada”, entrega **resumen**: fecha, hora y lugar + recordatorios/legales.

CANCELACIÓN DE CITA (verificación estricta, sin listar opciones)
- Flujo obligatorio:
  a) Pide primero la **cédula**.
  b) Luego pide **fecha (AAAA-MM-DD)** y **hora (HH:mm, 24h)** **exactas** de la cita que desea cancelar.
  c) Repite la fecha/hora que el paciente te dio y pide: “¿Confirmas que deseas cancelar esa cita?”.
  d) Solo si responde afirmativamente, envía **únicamente** el JSON:
     - Con ID (si ya lo conoces):
       {
         "action": "cancelar_cita",
         "data": { "cedula": "12345678", "eventId": "abc123", "confirm": true }
       }
     - Sin ID (verificación por cédula+fecha+hora):
       {
         "action": "cancelar_cita",
         "data": { "cedula": "12345678", "fecha": "2025-09-19", "hora": "14:30", "confirm": true }
       }
- **Nunca** listes ni reveles otras citas/horarios. Si falta algún dato o no coincide, indica que “no encontré una cita exactamente con esos datos” y vuelve a pedir la información exacta.

AGENDA (VENTANAS Y LÍMITES)
- **Lugar**: Clínica Portoazul, piso 7, consultorio 707, Barranquilla.
- **Duraciones**:
  - Primera vez: **20 min**
  - Control presencial: **15 min**
  - Control virtual (resultados): **10 min**
  - Biopsia: **30 min**
- **Ventanas por día/tipo** (**no romper**):
  - **Martes:** sin consulta (rechaza u ofrece otro día).
  - **Lunes (presencial):** 08:00–11:30 y 14:00–17:30.(mostrar los espacios disponibles de esas horas todos)
  - **Miércoles/Jueves (presencial):** 14:00–16:30.(mostrar los espacios disponibles de esas horas todos)
  - **Viernes presencial:** 08:00–11:30 (**no** presencial viernes tarde).(mostrar los espacios disponibles de esas horas todos)
  - **Viernes virtual:** 14:00–16:30 (**solo** controles virtuales).(mostrar los espacios disponibles de esas horas todos)
- **Límites**:
  - No fechas **pasadas**.
  - No **martes**.


COSTOS (si preguntan)
- Consulta de mastología: **350.000 COP**.
- Biopsia guiada por ecografía (solo particular): **800.000 COP** (incluye patología; **no** incluye consulta de lectura de patología).
- Medios de pago: **efectivo, transferencia**.

LEGALES Y RECORDATORIOS (al confirmar)
- Llegar **15 minutos** antes.
- Traer **impresos** todos los reportes previos: mamografías, ecografías, resonancias, informes de biopsia, resultados de cirugía/patología.
- **Grabaciones no autorizadas**: prohibido grabar audio/video durante la consulta sin autorización (Art. 15 Constitución Política de Colombia y Ley 1581 de 2012).

HANDOFF HUMANO
- Si corresponde: **Isa** o **Deivis** — WhatsApp **3108611759**.

REGLAS DURAS (NO ROMPER)
- Cuando muestres disponibilidad: formato **“9 de septiembre: 14:30, 14:15, …”** (no ISO) y **sin duración**.
- Si ya leíste resultados de PDF o sabes la categoría **BI-RADS**, primero da un **resumen muy breve** y **no vuelvas a pedir la categoría**; sigue el curso.
- No martes, no fuera de ventana, no pasado.
- No confirmar sin respuesta del sistema.
- **No mezclar texto y JSON** en el mismo mensaje.
- **No inventes horarios**: primero consulta disponibilidad y ofrece solo lo devuelto por el sistema.
- Si el sistema indica “ocupado” o “fuera de horario”, **no contradigas**: vuelve a pedir disponibilidad u ofrece alternativas válidas.

ACCIONES (JSON ONLY) — **formatos exactos**
1) Guardar paciente
{
  "action": "guardar_paciente",
  "data": {
    "nombre": "Ana López",
    "cedula": "12345678",
    "fecha_nacimiento": "1985-06-20",
    "tipo_sangre": "O+",
    "estado_civil": "Casada",
    "ciudad": "Barranquilla",
    "direccion": "Cra 45 #23-10",
    "correo": "ana@mail.com",
    "celular": "3101234567",
    "entidad_salud": "Colsanitas",
    "estudios_previos": "Sí",
    "fecha_estudio": "2024-02-10",
    "lugar_estudio": "Clínica Portoazul"
  }
}

2) Consultar disponibilidad (un día)
{
  "action": "consultar_disponibilidad",
  "data": { "tipo": "Control presencial", "fecha": "2025-10-06" }
}

3) Consultar días con cupo (rango)
{
  "action": "consultar_disponibilidad_rango",
  "data": { "tipo": "Control presencial", "desde": "2025-10-01", "dias": 14 }
}

4) Crear cita 
{
  "action": "crear_cita",
  "data": {
    "nombre": "Ana López",
    "cedula": "12345678",
    "entidad_salud": "Colsanitas",
    "tipo": "Control presencial",
    "inicio": "2025-10-06T08:00:00-05:00",
    "fin": "2025-10-06T08:15:00-05:00"
  }
}

5) Cancelar cita (requiere cédula + fecha + hora + confirmación)
{
  "action": "cancelar_cita",
  "data": {
    "cedula": "12345678",
    "fecha": "2025-09-19",
    "hora": "14:30",
    "confirm": true
  }
}
`;

// ============== SESIONES POR USUARIO ==============
// Map<fromJid, {history, lastSystemNote, updatedAtISO, priority, cancelGuard, birads}>
const sessions = new Map();
const SESSION_TTL_MIN = 60;
const PRIORITY_LOCK_MIN = 60;
const PRIORITY_LOCK_MESSAGE = 'Ya enviamos su solicitud a un asesor que se pondrá en contacto con usted.';

const CANCEL_ATTEMPT_WINDOW_MIN = 60;
const CANCEL_ATTEMPT_MAX = 3;

function getSession(userId) {
  const now = DateTime.now().setZone(ZONE);
  let s = sessions.get(userId);
  const expired =
    s && now.diff(DateTime.fromISO(s.updatedAtISO || now.toISO())).as('minutes') > SESSION_TTL_MIN;

  if (!s || expired) {
    s = {
      history: [{ role: 'system', content: systemPrompt }],
      lastSystemNote: null,
      updatedAtISO: now.toISO(),
      priority: null,
      cancelGuard: { windowStartISO: now.toISO(), attempts: 0 },
      birads: null,
    };
    sessions.set(userId, s);
  }
  return s;
}
function touchSession(s) { s.updatedAtISO = DateTime.now().setZone(ZONE).toISO(); }
function capHistory(session, max = 40) {
  if (session.history.length > max) {
    const firstSystem = session.history.findIndex(m => m.role === 'system');
    const base = firstSystem >= 0 ? [session.history[firstSystem]] : [];
    session.history = base.concat(session.history.slice(-(max - base.length)));
  }
}
function resetCancelGuardIfWindowExpired(session) {
  const now = DateTime.now().setZone(ZONE);
  const start = DateTime.fromISO(session.cancelGuard?.windowStartISO || now.toISO());
  if (now.diff(start, 'minutes').minutes >= CANCEL_ATTEMPT_WINDOW_MIN) {
    session.cancelGuard = { windowStartISO: now.toISO(), attempts: 0 };
  }
}
function incCancelAttempt(session) { resetCancelGuardIfWindowExpired(session); session.cancelGuard.attempts = (session.cancelGuard.attempts || 0) + 1; }
function tooManyCancelAttempts(session) { resetCancelGuardIfWindowExpired(session); return (session.cancelGuard.attempts || 0) >= CANCEL_ATTEMPT_MAX; }

// ============== HELPERS (agenda) ==============
const norm = (s = '') => String(s || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();

function duracionPorTipo(tipo = '') {
  const t = norm(tipo);
  if (t.includes('primera')) return 20;
  if (t.includes('control presencial')) return 15;
  if (t.includes('control virtual')) return 15;
  if (t.includes('biopsia')) return 30;
  return 15;
}

function isCoomeva(v='') {
  const s = norm(v);
  // tolera “coomeva/comeva”
  return s.includes('coomeva') || s.includes('comeva');
}
function isPreferente(v='') {
  const s = norm(v);
  return s.includes('preferente') || s.includes('preferencial');
}


function ventanasPorDia(date, tipo = '') {
  const dow = date.weekday; // 1=Lun ... 7=sDom
  const t = norm(tipo);
  const v = [];
  const H = (h, m = 0) => date.set({ hour: h, minute: m, second: 0, millisecond: 0 });
  const push = (start, end) => { if (end > start) v.push({ start, end }); };

  if (dow === 2) return v; // Martes sin consulta

  // Lunes
  if (dow === 1) {
    if (t.includes('control virtual')) return v;        // lunes solo presencial
    push(H(8,0), H(11,30));
    push(H(14,0), H(17,30));
    return v;
  }

  // Miércoles y Jueves → 14:00 a 17:30 (antes lo tenías hasta 16:30)
  if (dow === 3 || dow === 4) {
    if (t.includes('control virtual')) return v;
    push(H(14,0), H(17,30));
    return v;
  }

  // Viernes: presencial en la mañana / virtual en la tarde
  if (dow === 5) {
    if (t.includes('control virtual')) {
      push(H(14,0), H(17,30));
    } else {
      push(H(8,0), H(11,30));
    }
    return v;
  }

  // Sáb / Dom sin consulta
  return v;
}

function generarSlots(dateISO, tipo, maxSlots = 100) {
  const date = DateTime.fromISO(dateISO, { zone: ZONE });
  const ventanas = ventanasPorDia(date, tipo);
  const dur = duracionPorTipo(tipo);
  const slots = [];
  for (const win of ventanas) {
    let cursor = win.start;
    while (cursor.plus({ minutes: dur }) <= win.end) {
      const fin = cursor.plus({ minutes: dur });
      slots.push({ inicio: cursor.toISO({ suppressMilliseconds: true }), fin: fin.toISO({ suppressMilliseconds: true }) });
      cursor = fin;
      if (slots.length >= maxSlots) break;
    }
    if (slots.length >= maxSlots) break;
  }
  return { dur, ventanas, slots };
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

async function consultarBusy(ventanas) {
  if (!ventanas.length) return [];
  const day = ventanas[0].start.setZone(ZONE);
  const timeMin = day.startOf('day').toUTC().toISO();
  const timeMax = day.endOf('day').toUTC().toISO();

  const resp = await calendar.freebusy.query({
    requestBody: { timeMin, timeMax, items: [{ id: CALENDAR_ID }], timeZone: ZONE },
  });

  const cal = resp.data.calendars?.[CALENDAR_ID];
  return (cal?.busy || []).map(b => ({
    start: DateTime.fromISO(b.start, { zone: ZONE }),
    end:   DateTime.fromISO(b.end,   { zone: ZONE }),
  }));
}

function filtrarSlotsLibres(slots, busy) {
  if (!busy.length) return slots;
  return slots.filter(s => {
    const s1 = DateTime.fromISO(s.inicio, { zone: ZONE });
    const s2 = DateTime.fromISO(s.fin,    { zone: ZONE });
    return !busy.some(b => overlaps(s1, s2, b.start, b.end));
  });
}
function slotDentroDeVentanas(startISO, endISO, tipo) {
  const s = DateTime.fromISO(startISO, { zone: ZONE });
  const e = DateTime.fromISO(endISO, { zone: ZONE });
  const ventanas = ventanasPorDia(s, tipo);
  if (!ventanas.length) return false;
  return ventanas.some(w => s >= w.start && e <= w.end);
}
function coerceFutureISODate(dateStr) {
  let d = DateTime.fromISO(dateStr, { zone: ZONE });
  if (!d.isValid) return MIN_BOOKING_DATE_ISO;
  const minDay = DateTime.fromISO(MIN_BOOKING_DATE_ISO, { zone: ZONE }).startOf('day');
  if (d < minDay) d = minDay;
  return d.toISODate();
}

function coerceFutureISODateOrToday(dateStr) {
  let d = DateTime.fromISO(dateStr, { zone: ZONE });
  if (!d.isValid) return MIN_BOOKING_DATE_ISO;
  const minDay = DateTime.fromISO(MIN_BOOKING_DATE_ISO, { zone: ZONE }).startOf('day');
  if (d < minDay) d = minDay;
  return d.toISODate();
}
function fmtFechaHumana(isoDate)     { return DateTime.fromISO(isoDate, { zone: ZONE }).setLocale('es').toFormat('d LLLL'); }
function fmtHoraHumana(isoDateTime)  { return DateTime.fromISO(isoDateTime, { zone: ZONE }).toFormat('H:mm'); }
function parseHoraToMinutes(raw = '') {
  let s = String(raw || '').toLowerCase().replace(/a\s*las\s*/g, '').replace(/\s+/g, ' ').trim();
  const m = s.match(/(\d{1,2})(?::|\.|h)?\s*(\d{2})?/i);
  if (!m) return null;
  let hh = parseInt(m[1], 10);
  let mm = m[2] ? parseInt(m[2], 10) : 0;
  if (Number.isNaN(hh) || Number.isNaN(mm)) return null;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

const DEFAULT_REMINDER_TEMPLATE =
`🔔 *Recordatorio de cita*
Hola, {nombre}. Tienes una cita el *{fecha}* a las *{hora}*.
Si necesitas reprogramar, responde a este mensaje.`;

// Reemplaza {nombre}, {fecha}, {hora}, {fecha_hora}, {jid}, {tipo}
function renderReminderTemplate(tpl, ctx = {}) {
  const map = {
    nombre    : ctx.nombre ?? 'paciente',
    fecha     : ctx.fecha ?? '',
    hora      : ctx.hora ?? '',
    fecha_hora: ctx.fecha_hora ?? '',
    jid       : ctx.jid ?? '',
    tipo      : ctx.tipo ?? 'consulta',
  };
  return String(tpl || '')
    .replace(/\{(nombre|fecha|hora|fecha_hora|jid|tipo)\}/gi, (_, k) => map[k.toLowerCase()] ?? '');
}


// ====== Disponibilidad (rango) ======
async function disponibilidadPorDias({ tipo, desdeISO, dias = 30, maxSlotsPorDia = 100 }) {
  console.time(`disponibilidad:${desdeISO}:${dias}:${tipo}`);
  const start = DateTime.fromISO(desdeISO, { zone: ZONE });

  const diasLista = [];
  for (let i = 0; i < dias; i++) diasLista.push(start.plus({ days: i }));

  const CONCURRENCY = 3;
  const out = [];
  let idx = 0;

  async function worker() {
    while (idx < diasLista.length) {
      const d = diasLista[idx++];

      try {
        const dISO = d.toISODate();
        const { dur, ventanas, slots } = generarSlots(dISO, tipo, 2000);
        if (!ventanas.length) continue;

        console.time(`fb:${dISO}`);
        const busy = await consultarBusy(ventanas);   // consulta día completo
        console.timeEnd(`fb:${dISO}`);

        const libres = filtrarSlotsLibres(slots, busy);  // ← sin slice
        if (libres.length) {
          out.push({
            fecha: dISO,
            duracion_min: dur,
            total: libres.length,
            ejemplos: libres.slice(0, 8).map(s => DateTime.fromISO(s.inicio, { zone: ZONE }).toFormat('HH:mm')), // solo preview
            slots: libres
          });
        }
      } catch (e) {
        console.error('⚠️ Error consultando día:', e);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  out.sort((a, b) => a.fecha.localeCompare(b.fecha));
  console.timeEnd(`disponibilidad:${desdeISO}:${dias}:${tipo}`);
  return out;
}

async function alternativasCercanas({ tipo, desdeISO, dias = 10, limite = 6 }) {
  const lista = await disponibilidadPorDias({ tipo, desdeISO, dias, maxSlotsPorDia: limite });
  const planos = [];
  for (const d of lista) {
    for (const s of d.slots) {
      planos.push({ fecha: d.fecha, inicio: s.inicio, fin: s.fin, duracion_min: d.duracion_min });
      if (planos.length >= limite) break;
    }
    if (planos.length >= limite) break;
  }
  return planos;
}

// =================== WhatsApp QR: conexión + helpers ===================
const WA_SESSION_DIR = process.env.WA_SESSION_DIR || './wa_auth';
let waSock = null;

const toJid = (to) => {
  if (!to) return null;
  if (to.includes('@')) return to;
  const digits = String(to).replace(/\D/g, '');
  return `${digits}@s.whatsapp.net`;
};
const normJid = (jid='') => { try { return jidNormalizedUser(jid); } catch { return jid; } };

async function sendWhatsAppText(to, body) {
  if (!waSock) throw new Error('wa_not_connected');
  const raw = to.includes('@') ? to : toJid(to);
  const jid = normJid(raw);
  await waSock.sendMessage(jid, { text: String(body || '').slice(0, 4096) });
  // panel: registra salida
  appendChatMessage(jid, { id: `out-${Date.now()}`, fromMe: true, text: String(body || '').slice(0, 4096), ts: Date.now() });
}

async function downloadDocumentBuffer(documentMessage) {
  const stream = await downloadContentFromMessage(documentMessage, 'document');
  const chunks = []; for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function connectWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(WA_SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();

  waSock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: ['ClinicBot', 'Chrome', '1.0'],
    syncFullHistory: false,
    markOnlineOnConnect: false,
    connectTimeoutMs: 60_000,
  });

  waSock.ev.on('creds.update', saveCreds);
  
  waSock.ev.on('connection.update', async (u) => {
  const { connection, lastDisconnect, qr } = u;

  // 2.1 QR -> DataURL para el panel
  if (qr) {
    try {
      waQRDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 260 });
      waQRUpdatedAt = Date.now();
      console.log('🔐 Nuevo QR listo para mostrar en el panel.');
    } catch (err) {
      console.error('❌ Error generando QR dataURL:', err);
    }
  }

  if (connection === 'open') {
    // Datos de la sesión
    try {
      const jid = waSock?.user?.id || null;
      waUserJid = jid ? jidNormalizedUser(jid) : null;
      waUserName = waSock?.user?.name || null;
      console.log('✅ WhatsApp conectado:', waUserJid || '(sin JID)');
      // Ya no necesitamos mostrar el QR si está conectado
      waQRDataUrl = null;
    } catch (e) {
      console.warn('⚠️ No se pudo leer el user de WA:', e);
    }
  }

  if (connection === 'close') {
    const shouldReconnect = !['loggedOut'].includes(lastDisconnect?.error?.output?.payload?.error);
    console.warn('⚠️ Conexión cerrada. Reintentando...', shouldReconnect);
    // Al cerrar, es posible que necesitamos QR nuevo
    // waQRDataUrl queda como esté; en cuanto Baileys emita nuevo 'qr', lo actualizamos.
    if (shouldReconnect) connectWhatsApp().catch(console.error);
    else {
      // Sesión cerrada definitivamente
      waUserJid = null; waUserName = null;
    }
  }
});


  waSock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' || !messages?.length) return;
    for (const m of messages) {
      try { await handleIncomingBaileysMessage(m); }
      catch (err) { console.error('❌ Error procesando mensaje:', err); }
    }
  });
}

// ====== PANEL: estado y almacén de chats ======
// ====== PANEL: estado y almacén de chats (con UNREAD + normalización) ======
const panelState = {
  aiGlobalEnabled: true,        // toggle global de IA
  aiDisabledChats: new Set(),   // JIDs con IA apagada
};

const contactNames = new Map(); // Map<jid, name>
const chatStore    = new Map(); // Map<jid, Array<{id, fromMe, text, ts}>>
const unreadByJid  = new Map(); // Map<jid, number>
const CHAT_MAX_PER_THREAD = 500;



function getUnread(jid){ return unreadByJid.get(jid) || 0; }
function resetUnread(jid){ unreadByJid.set(jid, 0); }

function appendChatMessage(jid, msg) {
  const nj = normJid(jid);
  if (!chatStore.has(nj)) chatStore.set(nj, []);
  const arr = chatStore.get(nj);
  arr.push(msg);
  if (arr.length > CHAT_MAX_PER_THREAD) arr.splice(0, arr.length - CHAT_MAX_PER_THREAD);

  // si es ENTRANTE y no es de nosotros → cuenta como no leído
  if (!msg.fromMe) unreadByJid.set(nj, (unreadByJid.get(nj) || 0) + 1);
}

function listChatsSummary() {
  const out = [];
  for (const [jid, arr] of chatStore.entries()) {
    const last = arr[arr.length - 1] || null;
    out.push({
      jid,
      name: contactNames.get(jid) || jid.replace('@s.whatsapp.net',''),
      lastText: last?.text || '',
      lastTs: last?.ts || 0,
      unreadCount: getUnread(jid),
      aiEnabled: !panelState.aiDisabledChats.has(jid) && panelState.aiGlobalEnabled,
      messagesCount: arr.length,
    });
  }
  out.sort((a,b) => (b.lastTs || 0) - (a.lastTs || 0));
  return out;
}

// ================= REMINDERS (recordatorios por chat) =================
const remindersByJid = new Map(); // Map<jid, {enabled, plan, appointmentISO, jobs: Timeout[], timesISO: string[], lastSentISO: string[] }>

// planes -> offsets relativos a la cita
const REMINDER_PLANS = {
  '1h': [ { hours: 1 } ],
  '24h': [ { hours: 24 }, { hours: 1 } ],
  '1m': [ { months: 1 }, { hours: 24 }, { hours: 1 } ],
  '3m': [ { months: 3 }, { months: 1 }, { hours: 24 }, { hours: 1 } ],
  '6m': [ { months: 6 }, { months: 3 }, { months: 1 }, { hours: 24 }, { hours: 1 } ],
  '1y': [ { years: 1 }, { months: 6 }, { months: 3 }, { months: 1 }, { hours: 24 }, { hours: 1 } ],
};


function parseLocalDateTime(raw){
  // raw: "YYYY-MM-DDTHH:mm" (sin Z) desde <input type="datetime-local">
  if (!raw) return null;
  const d = DateTime.fromISO(raw, { zone: ZONE }); // lo interpreta en ZONE
  return d.isValid ? d : null;
}


function computeReminderTimes(appointmentISO, planKey) {
  const appt = DateTime.fromISO(appointmentISO, { zone: ZONE });
  if (!appt.isValid) return [];
  const now = DateTime.now().setZone(ZONE);
  const offsets = REMINDER_PLANS[planKey] || [];
  return offsets.map(off => appt.minus(off))
    .filter(dt => dt > now)               // solo futuros
    .sort((a, b) => a.toMillis() - b.toMillis());
}

function cancelJobs(cfg) {
  if (!cfg?.jobs) return;
  for (const t of cfg.jobs) try { clearTimeout(t); } catch {}
  cfg.jobs = [];
}

function scheduleJobs(jid, cfg) {
  cancelJobs(cfg);
  const times = computeReminderTimes(cfg.appointmentISO, cfg.plan);
  cfg.timesISO = times.map(t => t.toISO());
  cfg.jobs = times.map(t => {
    const delay = Math.max(0, t.toMillis() - DateTime.now().setZone(ZONE).toMillis());
    return setTimeout(async () => {
      try {
        // Contexto para las etiquetas
        const appt = DateTime.fromISO(cfg.appointmentISO, { zone: ZONE });
        const ctx = {
          nombre: contactNames.get(jid) || jid.replace('@s.whatsapp.net',''),
          fecha: appt.setLocale('es').toFormat("d 'de' LLLL yyyy"),
          hora: appt.toFormat('H:mm'),
          fecha_hora: appt.setLocale('es').toFormat("d 'de' LLLL yyyy 'a las' HH:mm"),
          jid: jid.split('@')[0],
          tipo: cfg.tipo || 'consulta',
        };

        const template = cfg.template || DEFAULT_REMINDER_TEMPLATE;

        const body = renderReminderTemplate(template, ctx);

        await sendWhatsAppText(jid, body);
        (cfg.lastSentISO ||= []).push(DateTime.now().setZone(ZONE).toISO());
      } catch (e) {
        console.error('❌ recordatorio send error', e);
      }
    }, delay);
  });
}


// GET: /api/panel/reminders[?jid=...]
app.get('/api/panel/reminders', (req, res) => {
  const jid = normJid(String(req.query?.jid || ''));
  if (jid) {
    const cfg = remindersByJid.get(jid) || null;
    return res.json({ ok: true, reminder: cfg ? { ...cfg, jobs: undefined } : null });
  }
  const all = [];
  for (const [k, v] of remindersByJid.entries()) {
    all.push({
      jid: k,
      name: contactNames.get(k) || k.replace('@s.whatsapp.net',''),
      enabled: !!v.enabled,
      plan: v.plan,
      appointmentISO: v.appointmentISO,
      timesISO: v.timesISO || [],
      lastSentISO: v.lastSentISO || [],
    });
  }
  all.sort((a,b) => String(a.appointmentISO||'').localeCompare(String(b.appointmentISO||'')));
  res.json({ ok: true, reminders: all });
});

// PATCH: /api/panel/reminders  { jid, enabled, plan, appointmentISO }
app.patch('/api/panel/reminders', (req, res) => {
  try {
    const jid = normJid(String(req.body?.jid || ''));
    if (!jid) return res.status(400).json({ ok:false, error:'falta_jid' });

    const enabled = !!req.body?.enabled;
    let plan = String(req.body?.plan || '24h');
    if (!REMINDER_PLANS[plan]) plan = '24h';

    let apptISO = null;
    if (enabled) {
      const parsed = parseLocalDateTime(String(req.body?.appointmentISO || '').trim());
      if (!parsed) return res.status(400).json({ ok:false, error:'appointment_invalida' });
      if (parsed <= DateTime.now().setZone(ZONE)) return res.status(400).json({ ok:false, error:'appointment_pasada' });
      apptISO = parsed.toISO();
    }

    let cfg = remindersByJid.get(jid);
    if (!cfg) { cfg = { enabled:false, plan:'24h', appointmentISO:null, jobs:[], timesISO:[], lastSentISO:[] }; remindersByJid.set(jid, cfg); }

    cfg.enabled = enabled;
    cfg.plan = plan;
    if (apptISO) cfg.appointmentISO = apptISO;

    if (!cfg.enabled) {
      cancelJobs(cfg);
      cfg.timesISO = [];
      return res.json({ ok:true, reminder:{ ...cfg, jobs:undefined } });
    }

    scheduleJobs(jid, cfg);
    res.json({ ok:true, reminder:{ ...cfg, jobs:undefined } });
  } catch (e) {
    console.error('reminders patch error', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

// ================ MÉTRICAS para HOME ====================
app.get('/api/panel/metrics', async (req, res) => {
  try {
    const now = DateTime.now().setZone(ZONE);
    const start = now.startOf('day'), end = now.endOf('day');
    let messagesToday = 0, unreadTotal = 0;
    const recent = [];
    for (const [jid, msgs] of chatStore.entries()) {
      unreadTotal += (unreadByJid.get(jid) || 0);
      const last = msgs[msgs.length-1];
      if (last?.ts) {
        const ts = DateTime.fromMillis(typeof last.ts === 'number' ? last.ts : Number(last.ts), { zone: ZONE });
        recent.push({
          jid,
          name: contactNames.get(jid) || jid.replace('@s.whatsapp.net',''),
          lastText: last?.text || '',
          lastTs: ts.toISO()
        });
      }
      messagesToday += msgs.filter(m => {
        const t = DateTime.fromMillis(typeof m.ts === 'number' ? m.ts : Number(m.ts), { zone: ZONE });
        return t >= start && t <= end;
      }).length;
    }
    recent.sort((a,b)=> (b.lastTs||'').localeCompare(a.lastTs||''));
    const recentTop = recent.slice(0, 5);

    // eventos próximos 14 días
    const timeMin = now.toUTC().toISO();
    const timeMax = now.plus({ days: 14 }).toUTC().toISO();
    const resp = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin, timeMax,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 250,
    });
    const eventsNext = (resp.data.items || []).length;

    res.json({
      ok:true,
      connected: !!waUserJid,
      aiGlobalEnabled: panelState.aiGlobalEnabled,
      messagesToday,
      eventsNext,
      unreadTotal,
      recentTop,
    });
  } catch (e) {
    console.error('metrics error', e);
    res.status(500).json({ ok:false, error:'metrics_error' });
  }
});



// ============== Media + BI-RADS + resumen PDF (helpers) ==============
function detectarBirads(raw = '') {
  const s = String(raw || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/\s+/g, ' ').toUpperCase();
  const m = s.match(/\bBI\s*[-\s]?RADS?\s*[:\-]?\s*(0|1|2|3|4[ABC]?|5|6)\b/);
  return m ? m[1] : null;
}
function isPriorityBirads(b) { if (!b) return false; const u = String(b).toUpperCase(); return u.startsWith('4') || u.startsWith('5'); }

function parsePatientData(text = '') {
  const out = {}; const s = String(text || '');
  const get = (re, i = 1) => { const m = s.match(re); return m ? m[i].trim() : undefined; };
  out.nombre   = get(/(?:^|\b)nombre\s*[:\-]?\s*([^\n,;]+)/i);
  out.apellido = get(/(?:^|\b)apellido\s*[:\-]?\s*([^\n,;]+)/i);
  out.cedula   = get(/(?:c[eé]dula|cedula|cc|documento)\s*[:\-]?\s*([0-9.\-]+)/i);
  out.correo   = get(/([a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,})/i);
  const phone  = s.match(/(\+?\d[\d\s\-]{7,}\d)/);
  out.telefono = phone ? phone[1].replace(/[\s\-]/g, '') : undefined;
  out.direccion= get(/(?:direcci[oó]n|direccion)\s*[:\-]?\s*([^\n]+)/i);
  const parts = s.split(/[\n,;]+/).map(x => x.trim()).filter(Boolean);
  if ((!out.nombre || !out.apellido || !out.cedula || !out.correo || !out.telefono || !out.direccion) && parts.length >= 6) {
    out.nombre = out.nombre || parts[0];
    out.apellido = out.apellido || parts[1];
    out.cedula = out.cedula || parts[2];
    out.correo = out.correo || (parts[3].includes('@') ? parts[3] : out.correo);
    out.telefono = out.telefono || parts[4].replace(/[\s\-]/g, '');
    out.direccion = out.direccion || parts.slice(5).join(', ');
  }
  return out;
}
function missingPatientFields(d = {}) { return ['nombre','apellido','cedula','correo','telefono','direccion'].filter(k => !d[k] || !String(d[k]).trim()); }



async function resumirPDF(textoPlano, birads) {
  const prompt = `Resume en 2–3 líneas, en español, los hallazgos clave de este informe de imagen mamaria. Incluye lateralidad si aparece, hallazgos relevantes y recomendación. Si hay BI-RADS, menciónalo como "BI-RADS ${birads || ''}". Evita datos personales.

==== TEXTO ====
${String(textoPlano || '').slice(0, 12000)}
==== FIN ====`;
  try {
    const c = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Eres un asistente clínico que escribe resúmenes MUY breves y precisos en español (máx 3 líneas).' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.2,
      max_tokens: 180,
    });
    return c.choices[0].message.content.trim();
  } catch (e) { console.error('⚠️ Error resumiendo PDF:', e); return null; }
}

// ====== Cancelación ======
async function cancelEventById(eventId) {
  try { await calendar.events.delete({ calendarId: CALENDAR_ID, eventId, sendUpdates: 'none' }); return { ok: true }; }
  catch (err) { const code = err?.response?.status || err?.code; return { ok: false, code, err }; }
}
async function findEventByCedulaAndLocal({ cedula, fechaISO, horaHHmm }) {
  if (!cedula || !fechaISO || !horaHHmm) return null;
  const day = DateTime.fromISO(fechaISO, { zone: ZONE }); if (!day.isValid) return null;
  const fechaTarget = day.toISODate();
  const targetMinutes = parseHoraToMinutes(horaHHmm); if (targetMinutes == null) return null;

  const resp = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: day.startOf('day').toUTC().toISO(),
    timeMax: day.endOf('day').toUTC().toISO(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 250,
    q: cedula,
  });

  const items = resp.data.items || [];
  const normCed = String(cedula).replace(/\D/g, '');
  const byCedula = items.filter(ev => {
    if (!ev || !ev.description) return false;
    const desc = ev.description.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
    const m = /cedula:\s*([0-9.\-]+)/i.exec(desc);
    const onlyDigits = m?.[1]?.replace(/\D/g, '') || '';
    return onlyDigits === normCed;
  });

  for (const ev of byCedula) {
    const startISO = ev.start?.dateTime; if (!startISO) continue;
    const startLocal = DateTime.fromISO(startISO, { zone: ZONE }); if (!startLocal.isValid) continue;
    const sameDate = startLocal.toISODate() === fechaTarget;
    const evMinutes = startLocal.hour * 60 + startLocal.minute;
    if (sameDate && evMinutes === targetMinutes) {
      return { eventId: ev.id, startISO: startLocal.toISO(), endISO: ev.end?.dateTime ? DateTime.fromISO(ev.end.dateTime, { zone: ZONE }).toISO() : null };
    }
  }
  return null;
}

// ====== Reparador / parser de acciones JSON ======
function repairJSON(raw = '') {
  let s = String(raw || '');
  s = s.replace(/```/g, '').replace(/\bjson\b/gi, '');
  s = s.replace(/[\u00A0\u200B\uFEFF]/g, ' ');
  s = s.replace(/[“”«»„‟]/g, '"').replace(/[‘’‚‛]/g, "'");
  s = s.replace(/:\s*'([^']*)'/g, ': "$1"');
  s = s.replace(/,\s*([}\]])/g, '$1');
  return s.trim();
}
function extractActionJSONBlocks(text = '') {
  const cleaned = repairJSON(text); const out = [];
  const idx = cleaned.indexOf('"action"');
  if (idx !== -1) {
    let start = cleaned.lastIndexOf('{', idx);
    if (start !== -1) {
      let depth = 0;
      for (let i = start; i < cleaned.length; i++) {
        const ch = cleaned[i];
        if (ch === '{') depth++;
        if (ch === '}') depth--;
        if (depth === 0) {
          const candidate = cleaned.slice(start, i + 1);
          try { const obj = JSON.parse(candidate); if (obj && typeof obj === 'object' && obj.action) out.push(obj); } catch {}
          break;
        }
      }
    }
  }
  if (out.length === 0) {
    const objs = cleaned.match(/\{[\s\S]*?\}/g) || [];
    for (const raw of objs) { try { const obj = JSON.parse(raw); if (obj && typeof obj === 'object' && obj.action) out.push(obj); } catch {} }
  }
  return out;
}
async function maybeHandleAssistantAction(text, session) {
  const payloads = extractActionJSONBlocks(text);
  if (!payloads.length) return null;

  const results = [];
  const now = DateTime.now().setZone(ZONE);

  for (const payload of payloads) {
    const action = norm(payload.action || '');

    // DISPONIBILIDAD (un día)
    if (action === 'consultar_disponibilidad') {
      const { tipo = 'Control presencial' } = payload.data || {};
      let { fecha } = payload.data || {};
      if (fecha) fecha = coerceFutureISODate(fecha);
      const { dur, ventanas, slots } = generarSlots(fecha, tipo, 60);
      if (!ventanas.length) { results.push({ ok: true, fecha, tipo, duracion_min: dur, slots: [], note: 'Día sin consulta según reglas' }); continue; }
      const busy = await consultarBusy(ventanas);
      const libres = filtrarSlotsLibres(slots, busy);
      results.push({ ok: true, fecha, tipo, duracion_min: dur, slots: libres });
      continue;
    }

    // DISPONIBILIDAD (rango)
    if (action === 'consultar_disponibilidad_rango') {
  const { tipo = 'Control presencial' } = payload.data || {};
  let { desde, dias = 14 } = payload.data || {};
  const desdeFixed = desde ? coerceFutureISODateOrToday(desde) : now.toISODate();

  // fuerza rango razonable
  dias = Math.max(14, Math.min(dias, 60));
  console.log('DBG rango pedido ->', { tipo, desdeFixed, dias });

  let lista = await disponibilidadPorDias({ tipo, desdeISO: desdeFixed, dias });

  // fallback: si casi no hay huecos, amplía a 30 días
  const totalSlots = lista.reduce((a, d) => a + (d.total || 0), 0);
  if (totalSlots < 5 && dias < 30) {
    const dias2 = 30;
    console.log('DBG ampliar rango ->', { desdeFixed, dias, dias2 });
    lista = await disponibilidadPorDias({ tipo, desdeISO: desdeFixed, dias: dias2 });
  }

  results.push({ ok: true, tipo, desde: desdeFixed, dias, dias_disponibles: lista });
  continue;
}


    // CREAR CITA
    if (action === 'crear_cita') {
      const d = payload.data || {};
      const s = DateTime.fromISO(d.inicio, { zone: ZONE });
      const e = DateTime.fromISO(d.fin,   { zone: ZONE });

      if (!s.isValid || !e.isValid || s >= e) { results.push({ ok: false, error: 'fecha_invalida', message: 'Fecha/hora inválida.' }); session.lastSystemNote = 'El último intento falló: fecha/hora inválida.'; continue; }
      if (s < now) { results.push({ ok: false, error: 'fecha_pasada', message: 'La hora elegida ya pasó. Elige una fecha futura.' }); session.lastSystemNote = 'Falló por fecha pasada.'; continue; }
      const minDay = DateTime.fromISO(MIN_BOOKING_DATE_ISO, { zone: ZONE }).startOf('day');
if (s < minDay) {
  results.push({ ok:false, error:'antes_minimo', message:`Solo agendamos desde el ${fmtFechaHumana(MIN_BOOKING_DATE_ISO)} en adelante.` });
  session.lastSystemNote = 'Falló por fecha anterior al mínimo (12/11).';
  continue;
}

// --- REGLA: Coomeva plan Preferente no se atiende ---
const entidad = (d.entidad_salud || '').trim();
const planEPS  = (d.plan || d.entidad_plan || d.plan_salud || '').trim();

if (isCoomeva(entidad)) {
  if (!planEPS) {
    results.push({
      ok: false,
      error: 'coomeva_plan_requerido',
      message: 'Para Coomeva necesito confirmar tu **plan**. ¿Es *Preferente* u otro?',
    });
    session.lastSystemNote = 'Paciente Coomeva sin plan: pedir plan antes de continuar.';
    continue;
  }
  if (isPreferente(planEPS)) {
    results.push({
      ok: false,
      error: 'coomeva_preferente_no_atendido',
      message: 'Por el momento **no atendemos** el plan *Preferente* de Coomeva, no puedo agendar esta cita.',
    });
    session.lastSystemNote = 'Bloquear agenda: Coomeva plan Preferente.';
    continue;
  }
}
// --- fin regla Coomeva ---


      if (!slotDentroDeVentanas(d.inicio, d.fin, d.tipo)) { results.push({ ok: false, error: 'fuera_horario', message: 'Ese día/horario no es válido según las reglas.' }); session.lastSystemNote = 'Falló por fuera de horario.'; continue; }

      const fb = await calendar.freebusy.query({
        requestBody: { timeMin: s.toUTC().toISO(), timeMax: e.toUTC().toISO(), items: [{ id: CALENDAR_ID }], timeZone: ZONE },
      });
      const cal = fb.data.calendars?.[CALENDAR_ID];
      const busy = (cal?.busy || []).map(b => ({ start: DateTime.fromISO(b.start, { zone: ZONE }), end: DateTime.fromISO(b.end, { zone: ZONE }) }));
      const solapa = busy.some(b => overlaps(s, e, b.start, b.end));
      if (solapa) { results.push({ ok: false, error: 'slot_ocupado', message: 'Ese horario ya está reservado. Elige otra opción.' }); session.lastSystemNote = 'Falló por slot ocupado.'; continue; }

      try {
        const ins = await calendar.events.insert({
  calendarId: CALENDAR_ID,
  requestBody: {
    summary: `[${d.tipo}] ${d.nombre} (${d.entidad_salud})`,
    location: 'Clínica Portoazul, piso 7, consultorio 707, Barranquilla',
    description: `Cédula: ${d.cedula}\nEntidad: ${d.entidad_salud}\nTeléfono: ${d.telefono || ''}\nCorreo: ${d.correo || ''}\nTipo: ${d.tipo}`,
    start: { dateTime: s.toISO(), timeZone: ZONE },
    end:   { dateTime: e.toISO(), timeZone: ZONE },
  },
});

        console.log('✅ Evento creado:', ins.data.id, ins.data.htmlLink || '');
        results.push({ ok: true, eventId: ins.data.id, htmlLink: ins.data.htmlLink || null });
        session.lastSystemNote = 'La última cita fue creada correctamente en el calendario.';
      } catch (err) {
        console.error('❌ Error creando evento:', err?.response?.data || err);
        results.push({ ok: false, error: 'gcal_insert_error', message: 'No se pudo crear la cita en Google Calendar.' });
        session.lastSystemNote = 'No se pudo crear la cita en Google Calendar.';
      }
      continue;
    }

    // GUARDAR PACIENTE
    if (action === 'guardar_paciente') { results.push({ ok: true, saved: true }); continue; }

    // CANCELAR CITA
    if (action === 'cancelar_cita') {
      const d = payload.data || {};
      const cedula = (d.cedula || '').trim();
      if (!cedula) { results.push({ ok:false, error:'falta_cedula', message:'Necesito la cédula para ubicar tu cita.' }); continue; }
      if (tooManyCancelAttempts(session)) { results.push({ ok:false, error:'rate_limited', message:'Demasiados intentos. Habla con un asesor para cancelar.' }); continue; }

      if (d.eventId && d.confirm === true) {
        const del = await cancelEventById(d.eventId);
        if (!del.ok) { results.push({ ok:false, error:'cancel_error', code:del.code, message:'No se pudo cancelar la cita.' }); continue; }
        results.push({ ok:true, cancelled:true, eventId:d.eventId }); session.lastSystemNote = 'Se canceló una cita (ok).'; continue;
      }

      const fecha = (d.fecha || '').trim();
      const hora  = (d.hora  || '').trim();
      if (!fecha || !hora) { results.push({ ok:false, error:'falta_fecha_hora', message:'Indícame la fecha (AAAA-MM-DD) y la hora (HH:mm) exactas de tu cita.' }); continue; }
      const horaOk = parseHoraToMinutes(d.hora);
      if (horaOk == null) { results.push({ ok:false, error:'hora_invalida', message:'Formato de hora inválido. Usa 24h, por ejemplo: 08:00 o 14:30.' }); continue; }

      const found = await findEventByCedulaAndLocal({ cedula, fechaISO: fecha, horaHHmm: hora });
      if (!found) { incCancelAttempt(session); results.push({ ok:false, error:'no_encontrada', message:'No encontré una cita exactamente con esos datos.' }); continue; }
      if (d.confirm !== true) { results.push({ ok:false, error:'requiere_confirmacion', message:'Confirma si deseas cancelar la cita indicada.' }); continue; }

      const del = await cancelEventById(found.eventId);
      if (!del.ok) { results.push({ ok:false, error:'cancel_error', code:del.code, message:'No se pudo cancelar la cita.' }); continue; }

      results.push({ ok:true, cancelled:true, eventId:found.eventId }); session.lastSystemNote = 'Se canceló una cita (ok).'; continue;
    }
  }
  if (results.length === 1) return { handled: true, makeResponse: results[0] };
  return { handled: true, makeResponse: results };
}

// ============== Handler de mensajes (con CORTE IA temprano) ==============
async function handleIncomingBaileysMessage(m) {
  const rawJid = m.key?.remoteJid;
  if (!rawJid || rawJid.endsWith('@g.us')) return; // sin grupos
  const remoteJid = normJid(rawJid);

  const now = DateTime.now().setZone(ZONE);
  if (m.pushName) contactNames.set(remoteJid, m.pushName);

  // Parse básico para registrar en panel
  const msg = m.message || {};
  const textBody =
    msg.conversation ||
    msg.extendedTextMessage?.text || '';
  const documentMessage = msg.documentMessage || msg.documentWithCaptionMessage?.message?.documentMessage || null;
  const buttonsResponse = msg.buttonsResponseMessage || null;
  const listResponse    = msg.listResponseMessage || null;

  let displayText = '';
  if (documentMessage) displayText = '[Documento] ' + (documentMessage?.fileName || 'archivo');
  else if (buttonsResponse) displayText = '[Botón] ' + (buttonsResponse?.selectedDisplayText || buttonsResponse?.selectedButtonId || 'opción');
  else if (listResponse) displayText = '[Lista] ' + (listResponse?.title || listResponse?.singleSelectReply?.selectedRowId || 'opción');
  else displayText = textBody || '[Mensaje]';

  appendChatMessage(remoteJid, { id: m.key?.id || String(Date.now()), fromMe: false, text: displayText, ts: (m.messageTimestamp || Date.now()) * 1000 });

  // Corte por horario: después de 6:00 pm no se atiende


  // ===== CORTE: IA desactivada (global o chat) → no responder
  const iaOffForChat = panelState.aiDisabledChats.has(remoteJid);
  if (!panelState.aiGlobalEnabled || iaOffForChat) {
    console.log(`🤖 IA desactivada ${!panelState.aiGlobalEnabled ? 'GLOBAL' : 'para chat'} → ${remoteJid}.`);
    return;
  }

  
  // ===== De aquí en adelante tu flujo normal (PDF/BI-RADS/PRIORIDAD/⏳/chat)
  const session = getSession(remoteJid);
  
 
  let userText = '';
  let biradsDetectado = null;

  if (documentMessage) {
    const mime = documentMessage.mimetype || '';
    if (mime.includes('pdf')) {
  try {
    const buf = await downloadDocumentBuffer(documentMessage);
    const parsed = await pdf(buf);
    const birads = detectarBirads(parsed.text || '');
    biradsDetectado = birads;

    if (birads) {
      session.birads = birads;
      if (isPriorityBirads(birads)) {
  await sendWhatsAppText(
    remoteJid,
    `🔴 *Atención prioritaria*\nPor favor comunícate con nuestro asesor *Deivis* al *${DEIVIS_PHONE}* para coordinar tu atención.`
  );
  // No creamos session.priority, no pedimos datos, no enviamos SMS.
  return; // respondemos sólo esto en este mensaje; la IA seguirá activa en próximos mensajes
}
else {
        session.lastSystemNote = `BIRADS ${birads} detectado desde PDF. No pidas de nuevo la categoría; procede según reglas.`;
        userText = `BI-RADS ${birads} detectado por PDF. Continúa el flujo clínico.`;
      }
    } else {
      userText = 'Leí tu PDF pero no detecté la categoría BI-RADS. ¿Cuál es tu BI-RADS? Además, ¿tiene estudios recientes? ¿cuándo y dónde se los hizo?';
    }
  } catch (e) {
    console.error('❌ Error procesando PDF:', e);
    userText = 'Recibí tu PDF pero no pude leerlo. ¿Puedes confirmar tu BI-RADS y si tienes estudios recientes (cuándo y dónde)?';
  }
}

  } else if (buttonsResponse || listResponse) {
    userText =
      buttonsResponse?.selectedDisplayText ||
      buttonsResponse?.selectedButtonId ||
      listResponse?.title ||
      listResponse?.singleSelectReply?.selectedRowId || 'OK';
  } else if (textBody) {
    userText = textBody;
    const birads = detectarBirads(userText);
    if (birads) biradsDetectado = birads;
  } else {
    userText = 'Recibí tu mensaje. ¿Cómo quieres continuar?';
  }

  

  await sendWhatsAppText(remoteJid, '⏳ Un momento, estoy consultando…');

  try {
    const INTERNAL_PORT = process.env.PORT || 3000;
const INTERNAL_BASE = `http://127.0.0.1:${INTERNAL_PORT}`;

const r = await fetch(`${INTERNAL_BASE}/chat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ from: remoteJid, message: userText }),
});

    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = null; }
    if (!r.ok) { console.error('❌ /chat status:', r.status, text); await sendWhatsAppText(remoteJid, '⚠️ Hubo un problema consultando. Intenta otra vez.'); return; }
    const botReply = data?.reply || 'Ups, no pude procesar tu mensaje.';
    await sendWhatsAppText(remoteJid, botReply);
  } catch (e) { console.error('❌ Error en procesamiento diferido:', e); await sendWhatsAppText(remoteJid, '⚠️ Hubo un problema consultando. Intenta otra vez.'); }
}

// ====================== API PANEL ======================
// ====================== API PANEL ======================
app.get('/api/panel/state', (req, res) => {
  res.json({
    aiGlobalEnabled: panelState.aiGlobalEnabled,
    aiDisabledChats: Array.from(panelState.aiDisabledChats),
  });
});

app.patch('/api/panel/toggle-ai-global', (req, res) => {
  try {
    const enabled = !!req.body?.enabled;
    panelState.aiGlobalEnabled = enabled;
    res.json({ ok: true, aiGlobalEnabled: panelState.aiGlobalEnabled });
  } catch {
    res.status(400).json({ ok: false });
  }
});

app.get('/api/panel/chats', (req, res) => {
  res.json({ ok: true, chats: listChatsSummary() });
});

app.get('/api/panel/messages', (req, res) => {
  const jid = normJid(String(req.query.jid || ''));
  if (!jid) return res.status(400).json({ ok: false, error: 'falta_jid' });
  res.json({
    ok: true,
    jid,
    name: contactNames.get(jid) || jid.replace('@s.whatsapp.net',''),
    messages: chatStore.get(jid) || [],
    unreadCount: (unreadByJid.get(jid) || 0),
    aiEnabled: !panelState.aiDisabledChats.has(jid) && panelState.aiGlobalEnabled,
  });
});

// marcar leído/un leído
app.patch('/api/panel/mark-read', (req, res) => {
  const jid = normJid(String(req.body?.jid || ''));
  if (!jid) return res.status(400).json({ ok:false, error:'falta_jid' });
  resetUnread(jid);
  res.json({ ok:true });
});

app.patch('/api/panel/toggle-ai-chat', (req, res) => {
  const jid = normJid(String(req.body?.jid || ''));
  const enabled = !!req.body?.enabled;
  if (!jid) return res.status(400).json({ ok: false, error: 'falta_jid' });
  if (enabled) panelState.aiDisabledChats.delete(jid);
  else panelState.aiDisabledChats.add(jid);
  res.json({ ok: true, jid, aiEnabled: enabled });
});

app.post('/api/panel/send', async (req, res) => {
  try {
    const jid = normJid(String(req.body?.jid || ''));
    const text = String(req.body?.text || '');
    if (!jid || !text) return res.status(400).json({ ok: false, error: 'falta_jid_o_texto' });
    await sendWhatsAppText(jid, text);
    res.json({ ok: true });
  } catch (e) {
    console.error('panel send error', e);
    res.status(500).json({ ok: false, error: 'send_failed' });
  }
});

// (opcional) Re-vincular: borra sesión y reconecta
app.post('/api/panel/relink', async (req, res) => {
  try {
    const dir = process.env.WA_SESSION_DIR || './wa_auth';
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    if (waSock?.end) try { await waSock.end(); } catch {}
    connectWhatsApp().catch(console.error);
    res.json({ ok: true });
  } catch (e) {
    console.error('relink error', e);
    res.status(500).json({ ok: false });
  }
});

// Estado de la sesión de WhatsApp para el panel
app.get('/api/wa/status', (req, res) => {
  res.json({
    connected: !!waUserJid,
    jid: waUserJid,
    name: waUserName,
    qrAvailable: !!waQRDataUrl,
    qrUpdatedAt: waQRUpdatedAt,
  });
});

// QR como imagen (dataURL)
app.get('/api/wa/qr', (req, res) => {
  if (!waQRDataUrl) return res.status(404).json({ ok:false, error:'no_qr' });
  res.json({ ok:true, dataUrl: waQRDataUrl, ts: waQRUpdatedAt });
});

// Lista eventos del calendario vinculado (próximos N días)
app.get('/api/calendar/events', async (req, res) => {
  try {
    const days = Math.max(1, Math.min(31, parseInt(req.query.days || '14', 10)));
    const now = DateTime.now().setZone(ZONE);
    const timeMin = now.toUTC().toISO();
    const timeMax = now.plus({ days }).toUTC().toISO();

    const resp = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin, timeMax,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 250,
    });

    const events = (resp.data.items || []).map(ev => ({
      id: ev.id,
      summary: ev.summary || '(Sin título)',
      location: ev.location || '',
      description: ev.description || '',
      start: ev.start?.dateTime || ev.start?.date || null,
      end:   ev.end?.dateTime   || ev.end?.date   || null,
      htmlLink: ev.htmlLink || null,
    }));

    res.json({ ok:true, events });
  } catch (e) {
    console.error('calendar events error', e?.response?.data || e);
    res.status(500).json({ ok:false, error:String(e?.response?.data || e?.message || e) });
  }
});



// Ruta estática para el logo
app.get('/assets/logo.svg', (req, res) => {
  res.type('image/svg+xml').send(LOGO_SVG);
});


// ====================== Página del panel (rediseñada) ======================
const PANEL_HTML = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Panel WhatsApp • Bot de Citas</title>
<style>
:root{
  --bg:#f5f7fb; --card:#ffffff; --muted:#5c6b83; --text:#0b1320; --subtle:#334363;
  --line:#e6eaf4; --accent:#2d6cff; --accent-2:#00c2ae; --danger:#e5484d; --warning:#f59e0b;
  --bubble-in:#e8f0ff; --bubble-out:#f6f8ff; --shadow:0 8px 28px rgba(16,24,40,.08);
}
*{box-sizing:border-box} html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,Segoe UI,Roboto;overflow:hidden}

/* Topbar */
.topbar{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;background:#fff;border-bottom:1px solid var(--line);height:56px;position:sticky;top:0;z-index:5}
.brand{display:flex;align-items:center;gap:10px}
.brand img{width:28px;height:28px;display:block}
.brand span{font-weight:800;letter-spacing:.2px}

/* Layout */
.app{display:grid;grid-template-columns:240px 1fr;height:calc(100vh - 56px)}
.sidebar{background:#fff;border-right:1px solid var(--line)}
.side-head{display:flex;align-items:center;gap:8px;padding:14px;border-bottom:1px solid var(--line)}
.side-title{font-weight:800}
.side-menu{padding:10px;display:flex;flex-direction:column;gap:6px}
.menu-item{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:10px;border:1px solid transparent;background:transparent;color:var(--text);cursor:pointer}
.menu-item:hover{background:#f2f6ff}
.menu-item.active{border-color:var(--accent);background:#edf3ff}
.menu-icon{width:22px;text-align:center}

/* Content */
.content{padding:16px;height:100%;overflow:hidden}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow);overflow:hidden}
.section{padding:14px}

/* HOME */
.grid{display:grid;gap:14px}
.grid.home{grid-template-columns:1fr 1fr}
.kpis{display:grid;gap:12px;grid-template-columns:1fr 1fr}
.kpi{padding:16px;border:1px solid var(--line);border-radius:12px;background:#fff}
.kpi .big{font-size:26px;font-weight:800;margin-top:6px}
.list{padding:12px}
.row{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-radius:8px;border:1px solid var(--line);background:#fff;margin:6px 0}

/* WHATSAPP */
.wa-wrap{display:grid;grid-template-columns:340px 1fr;gap:12px;height:100%}
.wa-tile{padding:16px}
.wa-qr{display:flex;align-items:center;justify-content:center;min-height:280px;border:1px dashed var(--line);border-radius:12px;background:#fafcff}
.btn{padding:10px 14px;border-radius:10px;border:1px solid var(--line);cursor:pointer;background:var(--accent);color:#fff}
.btn.ghost{background:#fff;color:var(--text)}
.badge{display:inline-block;min-width:18px;padding:0 6px;border-radius:999px;background:var(--accent);color:#fff;font-weight:700;font-size:12px}

/* ===== Conversaciones (scroll solo en lista y mensajes) ===== */
#view-conversaciones.card{display:block;height:100%}
.conv-grid{
  display:grid;
  grid-template-columns:330px 1fr 300px;
  gap:12px;
  height:100%;
  min-height:0;
  overflow:hidden;
}
.left,.right,.rem{min-width:0}

/* izquierda */
.left{display:flex;flex-direction:column;min-height:0;overflow:hidden}
.search{padding:10px;border-bottom:1px solid var(--line);background:#fff;flex:0 0 auto}
.tabs{display:flex;gap:8px;padding:10px;border-bottom:1px solid var(--line);background:#fff;flex:0 0 auto}
.tab{padding:6px 10px;border:1px solid var(--line);border-radius:999px;cursor:pointer;color:var(--subtle);background:#fff}
.tab.active{color:var(--text);border-color:var(--accent)}
.chatlist{
  flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;background:transparent
}
.chat{
  padding:10px 12px;border-bottom:1px solid var(--line);cursor:pointer;
  display:grid;grid-template-columns:36px 1fr auto;gap:10px;align-items:center;background:#fff;overflow:hidden
}
.chat:hover{background:#f7faff}
.avatar{width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#fff;font-weight:700}
.cmeta{font-size:12px;color:var(--muted)}
.chat .last{max-width:90%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* centro */
.right{
  display:flex;flex-direction:column;min-height:0;overflow:hidden;background:#fff;border:1px solid var(--line);border-radius:12px
}
.toolbar{display:flex;align-items:center;gap:12px;padding:10px;border-bottom:1px solid var(--line);background:#fff;flex:0 0 auto}
.title{font-weight:800}
.pill{padding:6px 10px;border-radius:999px;border:1px solid var(--line);background:#fff;font-size:12px}
.messages{
  flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;
  padding:12px;display:flex;flex-direction:column;gap:8px;background:linear-gradient(180deg,transparent,#f7faff 30%,transparent)
}
.msg{
  max-width:70%;padding:10px 12px;border-radius:12px;border:1px solid var(--line);background:var(--bubble-out);
  word-break:break-word;overflow-wrap:anywhere
}
.me{align-self:flex-end;background:var(--bubble-in)}
.meta{font-size:11px;color:var(--muted);margin-top:4px}
.composer{display:flex;gap:8px;padding:10px;border-top:1px solid var(--line);background:#fff;flex:0 0 auto}
.input{width:100%;padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:#fff;color:var(--text)}
.btn.accent2{background:var(--accent-2);border-color:var(--accent-2)}

/* derecha (recordatorios) */
.rem{padding:12px;border:1px solid var(--line);border-radius:12px;background:#fff;height:100%;display:grid;grid-template-rows:auto auto auto 1fr}
.rem h4{margin:4px 0 8px 0}
.small{font-size:12px;color:var(--muted)}
.rem ul{margin:8px 0;padding-left:18px}

/* Calendario */
.cal-wrap{display:flex;flex-direction:column;height:100%}
.cal-head{display:flex;gap:8px;align-items:center;justify-content:space-between;padding:10px;border-bottom:1px solid var(--line);background:#fff}
.cal-list{padding:10px;overflow:auto;min-height:0}
.cal-day{margin:10px 0}
.cal-day h3{margin:0 0 6px 0;font-size:13px;color:var(--subtle)}
.cal-ev{padding:10px;border:1px solid var(--line);border-radius:10px;margin:6px 0;background:#fff}
.cal-ev a{color:var(--accent)}

/* Tareas */
.tasks-wrap{padding:12px;height:100%;overflow:auto}
.task{display:grid;grid-template-columns:36px 1fr auto;gap:10px;align-items:center;border:1px solid var(--line);border-radius:12px;background:#fff;padding:10px;margin:8px 0}
.task .who{font-weight:700}
</style>
</head>
<body>
<div class="topbar">
  <div class="brand">
    <img src="/assets/logo.svg" alt="logo"/>
    <span>Panel WhatsApp • Bot de Citas</span>
  </div>
  <div class="tools" style="display:flex;gap:8px;align-items:center">
    <span class="small">IA Global</span>
    <label class="pill"><input id="aiGlobalToggle" type="checkbox"/> ON</label>
    <button id="relinkBtnTop" class="btn ghost" title="Nuevo QR / re-vincular">🔗 Re-vincular</button>
  </div>
</div>

<div class="app">
  <!-- Sidebar fija -->
  <aside class="sidebar">
    <div class="side-head"><span class="side-title">Menú</span></div>
    <div class="side-menu">
      <button data-view="home" class="menu-item active"><span class="menu-icon">🏠</span><span class="menu-text">Home</span></button>
      <button data-view="whatsapp" class="menu-item"><span class="menu-icon">📱</span><span class="menu-text">WhatsApp</span></button>
      <button data-view="conversaciones" class="menu-item"><span class="menu-icon">💬</span><span class="menu-text">Conversaciones</span></button>
      <button data-view="calendario" class="menu-item"><span class="menu-icon">📅</span><span class="menu-text">Calendario</span></button>
      <button data-view="tareas" class="menu-item"><span class="menu-icon">✅</span><span class="menu-text">Tareas</span></button>
    </div>
  </aside>

  <!-- Content -->
  <main class="content">
    <!-- HOME -->
    <section id="view-home" class="grid home">
      <div class="card section">
        <h2>Resumen</h2>
        <div class="kpis" id="kpisBox">
          <div class="kpi"><div>Mensajes hoy</div><div id="kpiMsgs" class="big">–</div></div>
          <div class="kpi"><div>Eventos próximos</div><div id="kpiEvents" class="big">–</div></div>
        </div>
        <div class="list" id="homeRecent">
          <h3>Conversaciones recientes</h3>
          <div id="homeRecentList"></div>
        </div>
      </div>
      <div class="card section">
        <h2>Estado</h2>
        <div class="row"><div>WhatsApp</div><div id="homeConn">—</div></div>
        <div class="row"><div>IA Global</div><div id="homeAI">—</div></div>
        <div class="row"><div>No leídos</div><div id="homeUnread">—</div></div>
      </div>
    </section>

    <!-- WhatsApp -->
    <section id="view-whatsapp" class="card" style="display:none;height:100%">
      <div class="wa-wrap">
        <div class="wa-tile">
          <h2>Vinculación WhatsApp</h2>
          <p class="small" id="waStatusText">Estado: —</p>
          <div class="wa-qr" id="waQRBox"><div id="waQRInner">Cargando QR…</div></div>
          <div style="margin-top:10px; display:flex; gap:8px;">
            <button id="relinkBtn" class="btn ghost">Re-vincular</button>
            <button id="refreshQRBtn" class="btn ghost">Refrescar QR</button>
          </div>
        </div>
        <div class="wa-tile">
          <h3>Sesión actual</h3>
          <div id="waSessionBox" class="card" style="padding:10px; margin-top:8px;">
            <div id="waSessionInfo">—</div>
          </div>
          <p class="small" style="margin-top:8px">Si ya estás conectado, el QR no se mostrará.</p>
        </div>
      </div>
    </section>

    <!-- Conversaciones -->
    <section id="view-conversaciones" class="card" style="display:none;height:100%">
      <div class="conv-grid">
        <div class="left">
          <div class="search"><input id="search" class="input" placeholder="Buscar por número o nombre"/></div>
          <div class="tabs">
            <button id="tabRecent" class="tab active">Recientes</button>
            <button id="tabUnread" class="tab">No leídos <span id="badgeUnread" class="badge" style="display:none">0</span></button>
            <button id="tabRead" class="tab">Leídos</button>
          </div>
          <div class="chatlist" id="chatlist"></div>
        </div>
        <div class="right">
          <div class="toolbar">
            <div id="chatTitle" class="title">Selecciona un chat</div>
            <div style="margin-left:auto;display:flex;gap:12px;align-items:center">
              <span id="aiChatStatus" class="pill">IA: OFF</span>
              <label class="pill"><input id="chatToggle" type="checkbox"/> IA en este chat</label>
            </div>
          </div>
          <div class="messages" id="messages"></div>
          <div class="composer">
            <input id="composerInput" class="input" placeholder="Escribe un mensaje manual... (no usa IA)"/>
            <button id="sendBtn" class="btn accent2">Enviar</button>
          </div>
        </div>
        <!-- Recordatorios -->
        <aside class="rem">
          <div><h4>Recordatorios de cita</h4><div class="small">Programa avisos automáticos para este chat.</div></div>
          <div><label class="pill"><input id="remEnabled" type="checkbox"/> Activar</label></div>
          <div style="display:grid;gap:8px">
            <label>Fecha y hora de la cita
              <input id="remAppt" type="datetime-local" class="input" />
            </label>
            <label>Plan
              <select id="remPlan" class="input">
                <option value="1h">1 hora antes</option>
                <option value="24h">24 horas + 1 hora</option>
                <option value="1m">1 mes + 24h + 1h</option>
                <option value="3m">3m + 1m + 24h + 1h</option>
                <option value="6m">6m + 3m + 1m + 24h + 1h</option>
                <option value="1y">1a + 6m + 3m + 1m + 24h + 1h</option>
              </select>
            </label>
            <!-- NUEVO: plantilla del mensaje -->
            <label>Plantilla del mensaje
              <textarea id="remTpl" class="input" rows="5"
                placeholder="Hola, {nombre}. Tienes una cita el {fecha} a las {hora}."></textarea>
            </label>
            <div class="small">
              Etiquetas: <code>{nombre}</code> <code>{fecha}</code> <code>{hora}</code>
              <code>{fecha_hora}</code> <code>{jid}</code> <code>{tipo}</code>
            </div>
            <button id="remSaveBtn" class="btn">Guardar</button>
            <div id="remStatus" class="small">—</div>
            <div style="margin-top:6px">
              <strong>Vista previa</strong>
              <div id="remPreview" class="card" style="padding:8px;margin-top:6px"></div>
            </div>
          </div>
          <div>
            <h4>Próximos avisos</h4>
            <ul id="remListTimes"><li class="small">—</li></ul>
          </div>
        </aside>
      </div>
    </section>

    <!-- Calendario -->
    <section id="view-calendario" class="card" style="display:none;height:100%">
      <div class="cal-wrap">
        <div class="cal-head">
          <div><strong>Calendario vinculado</strong></div>
          <div>
            <select id="calRange" class="input" style="width:auto">
              <option value="7">Próximos 7 días</option>
              <option value="14" selected>Próximos 14 días</option>
              <option value="30">Próximos 30 días</option>
            </select>
            <button id="calReload" class="btn ghost">Actualizar</button>
          </div>
        </div>
        <div class="cal-list" id="calList"></div>
      </div>
    </section>

    <!-- Tareas -->
    <section id="view-tareas" class="card" style="display:none;height:100%">
      <div class="tasks-wrap">
        <h2>Recordatorios programados</h2>
        <div id="tasksList"></div>
      </div>
    </section>
  </main>
</div>

<script>
/* ===== Helpers ===== */
const $ = s => document.querySelector(s);
function fmtTime(ts){try{return new Date(ts).toLocaleString();}catch{return''}}
function toInputLocal(iso){ if(!iso) return ''; const d=new Date(iso); const t = new Date(d.getTime()-d.getTimezoneOffset()*60000); return t.toISOString().slice(0,16); }

/* ===== Flags para evitar que se borre la fecha mientras editas ===== */
let remDirty = false;     // hay cambios no guardados
let remEditing = false;   // el input tiene foco

/* ===== Navegación ===== */
const menuBtns = document.querySelectorAll('.menu-item');
const views = { home: $('#view-home'), whatsapp: $('#view-whatsapp'), conversaciones: $('#view-conversaciones'), calendario: $('#view-calendario'), tareas: $('#view-tareas') };
function showView(id){ Object.values(views).forEach(v=>v.style.display='none'); views[id].style.display='block'; menuBtns.forEach(b=>b.classList.toggle('active', b.dataset.view===id)); }
menuBtns.forEach(b=>b.onclick=()=>{ showView(b.dataset.view); if (b.dataset.view==='home') loadHome(); if (b.dataset.view==='tareas') loadTasks(); if (b.dataset.view==='calendario') loadCalendar(); if (b.dataset.view==='whatsapp') loadWAStatus(); });

/* ===== IA Global ===== */
async function syncGlobalAI(){ const r = await fetch('/api/panel/state'); const st = await r.json(); $('#aiGlobalToggle').checked = !!st.aiGlobalEnabled; }
$('#aiGlobalToggle').addEventListener('change', async e=>{ await fetch('/api/panel/toggle-ai-global',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:!!e.target.checked})}); loadHome(); });

/* ===== HOME (con fallback si /api/panel/metrics no existe) ===== */
async function loadHome(){
  try{
    const r = await fetch('/api/panel/metrics'); 
    if(r.ok){
      const m = await r.json();
      $('#kpiMsgs').textContent = m.messagesToday ?? '—';
      $('#kpiEvents').textContent = m.eventsNext ?? '—';
      $('#homeConn').textContent = m.connected ? 'Conectado' : 'No conectado';
      $('#homeAI').textContent = m.aiGlobalEnabled ? 'ON' : 'OFF';
      $('#homeUnread').textContent = m.unreadTotal ?? '—';
      const box = $('#homeRecentList'); box.innerHTML='';
      (m.recentTop||[]).forEach(c=>{
        const div = document.createElement('div'); div.className='row';
        div.innerHTML = \`<div><strong>\${c.name}</strong> <span class="cmeta">(\${c.jid})</span><div class="cmeta">\${c.lastText||''}</div></div><div class="cmeta">\${new Date(c.lastTs).toLocaleTimeString()}</div>\`;
        div.onclick = ()=>{ openChat(c.jid); showView('conversaciones'); };
        box.appendChild(div);
      });
      return;
    }
  }catch{}
  // Fallback mínimo usando /api/panel/chats
  const rc = await fetch('/api/panel/chats'); const data = await rc.json();
  const chats = data.chats||[];
  $('#kpiMsgs').textContent = '—';
  $('#kpiEvents').textContent = '—';
  $('#homeConn').textContent = '—';
  $('#homeAI').textContent = '—';
  $('#homeUnread').textContent = chats.reduce((a,c)=>a+(c.unreadCount||0),0);
  const box = $('#homeRecentList'); box.innerHTML='';
  chats.slice(0,5).forEach(c=>{
    const div = document.createElement('div'); div.className='row';
    div.innerHTML = \`<div><strong>\${c.name||c.jid}</strong> <span class="cmeta">(\${c.jid})</span><div class="cmeta">\${c.lastText||''}</div></div><div class="cmeta">\${new Date(c.lastTs||Date.now()).toLocaleTimeString()}</div>\`;
    div.onclick = ()=>{ openChat(c.jid); showView('conversaciones'); };
    box.appendChild(div);
  });
}

/* ===== WhatsApp ===== */
async function loadWAStatus(){
  const r = await fetch('/api/wa/status'); const data = await r.json();
  $('#waStatusText').textContent = data.connected ? 'Estado: Conectado' : 'Estado: No conectado';
  $('#waSessionInfo').innerHTML = data.connected ? \`<div><strong>JID:</strong> \${data.jid}</div><div><strong>Nombre:</strong> \${data.name || '-'}</div>\` : 'No hay sesión activa.';
  if (!data.connected) await loadWAQR(); else $('#waQRInner').innerHTML = 'Dispositivo conectado. No se requiere QR.';
}
async function loadWAQR(){
  const box = $('#waQRInner');
  try { const r = await fetch('/api/wa/qr'); if (!r.ok) { box.innerHTML = 'No hay QR disponible. Presiona "Re-vincular".'; return; }
    const { dataUrl } = await r.json(); box.innerHTML = \`<img src="\${dataUrl}" alt="QR" style="image-rendering:pixelated;max-width: 240px;"/>\`; }
  catch { box.textContent = 'Error cargando QR.'; }
}
$('#relinkBtn').onclick = async ()=>{ await fetch('/api/panel/relink',{method:'POST'}); setTimeout(loadWAStatus, 800); };
$('#relinkBtnTop').onclick = $('#relinkBtn').onclick;
$('#refreshQRBtn').onclick = loadWAQR;
setInterval(loadWAStatus, 4000);

/* ===== Conversaciones ===== */
let chats = []; let currentJid = null; let currentTab = 'recent';
async function fetchChats(){ const r=await fetch('/api/panel/chats'); const data=await r.json(); chats=data.chats||[]; updateUnreadBadge(); renderChatList($('#search').value||''); }
async function fetchMessages(opts = { reloadRem: true }) {
  if(!currentJid){
    $('#chatTitle').textContent='Selecciona un chat';
    $('#messages').innerHTML='';
    $('#aiChatStatus').textContent='IA: OFF';
    return;
  }
  const r=await fetch('/api/panel/messages?jid='+encodeURIComponent(currentJid)); const data=await r.json();
  $('#chatTitle').innerHTML=\`<strong>\${data.name}</strong> <span class="cmeta">(\${data.jid})</span>\`;
  $('#chatToggle').checked=!!data.aiEnabled; $('#aiChatStatus').textContent='IA: '+(data.aiEnabled?'ON':'OFF');
  const cont=$('#messages'); cont.innerHTML='';
  for(const m of (data.messages||[])){
    const el=document.createElement('div'); el.className='msg'+(m.fromMe?' me':''); el.innerHTML=\`<div>\${m.text||''}</div><div class="meta">\${m.fromMe?'Tú':'Contacto'} • \${fmtTime(m.ts)}</div>\`; cont.appendChild(el);
  }
  cont.scrollTop=cont.scrollHeight;
  await fetch('/api/panel/mark-read',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({jid:currentJid})});
  fetchChats();
  if (opts.reloadRem && !remEditing && !remDirty) { loadReminderUI(currentJid); }
}
function updateUnreadBadge(){ const totalUnread = chats.reduce((a,c)=> a + (c.unreadCount||0), 0); const bd = $('#badgeUnread'); if (totalUnread>0){ bd.style.display='inline-block'; bd.textContent=totalUnread; } else bd.style.display='none'; }
function renderChatList(filter=''){ const list=$('#chatlist'); list.innerHTML=''; const f=(filter||'').toLowerCase();
  const subset = chats.filter(c=>{ const matches = c.jid.toLowerCase().includes(f) || String(c.name||'').toLowerCase().includes(f);
    if (!matches) return false; if (currentTab==='unread') return (c.unreadCount||0)>0; if (currentTab==='read') return (c.unreadCount||0)===0; return true; });
  for(const c of subset){ const div=document.createElement('div'); div.className='chat';
    const initials=(String(c.name||c.jid).trim()[0]||'?').toUpperCase();
    div.innerHTML=\`
      <div class="avatar">\${initials}</div>
      <div>
        <div><strong>\${c.name || c.jid}</strong> <span class="cmeta">(\${c.jid})</span></div>
        <div class="cmeta last">\${c.lastText||''}</div>
      </div>
      <div style="display:flex;gap:8px;align-items:center">\${(c.unreadCount||0)>0?'<span class="badge">'+c.unreadCount+'</span>':''}
      <span class="cmeta">\${new Date(c.lastTs||Date.now()).toLocaleTimeString()}</span></div>\`;
    div.onclick=()=>openChat(c.jid); list.appendChild(div);
  }
}
async function openChat(jid){ currentJid=jid; showView('conversaciones'); await fetchMessages({ reloadRem: true }); }
$('#tabRecent').onclick=()=>{currentTab='recent'; $('#tabRecent').classList.add('active'); $('#tabUnread').classList.remove('active'); $('#tabRead').classList.remove('active'); renderChatList($('#search').value||'');};
$('#tabUnread').onclick=()=>{currentTab='unread'; $('#tabRecent').classList.remove('active'); $('#tabUnread').classList.add('active'); $('#tabRead').classList.remove('active'); renderChatList($('#search').value||'');};
$('#tabRead').onclick  =()=>{currentTab='read';   $('#tabRecent').classList.remove('active'); $('#tabUnread').classList.remove('active'); $('#tabRead').classList.add('active'); renderChatList($('#search').value||'');};
$('#search').addEventListener('input', e=>renderChatList(e.target.value));
$('#chatToggle').addEventListener('change', async e=>{ if(!currentJid) return; await fetch('/api/panel/toggle-ai-chat',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({jid:currentJid,enabled:!!e.target.checked})}); $('#aiChatStatus').textContent='IA: '+(e.target.checked?'ON':'OFF'); fetchChats(); });
$('#sendBtn').onclick = sendManual;
$('#composerInput').addEventListener('keydown', e=>{ if(e.key==='Enter') sendManual(); });
async function sendManual(){ const inp=$('#composerInput'); const txt=(inp.value||'').trim(); if(!txt||!currentJid) return; await fetch('/api/panel/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jid:currentJid,text:txt})}); inp.value=''; fetchMessages({ reloadRem: false }); }

/* ===== Recordatorios UI ===== */
async function loadReminderUI(jid){
  if (remEditing || remDirty) return; // no pisar mientras editas
  const r = await fetch('/api/panel/reminders?jid='+encodeURIComponent(jid)); const data = await r.json();
  const cfg = data.reminder || null;
  $('#remEnabled').checked = !!cfg?.enabled;
  $('#remPlan').value = cfg?.plan || '24h';
  $('#remAppt').value = cfg?.appointmentISO ? toInputLocal(cfg.appointmentISO) : '';
  $('#remTpl').value = (cfg?.template) || \`🔔 *Recordatorio de cita*\\nHola, {nombre}. Tienes una cita el *{fecha}* a las *{hora}*.\\nSi necesitas reprogramar, responde a este mensaje.\`;
  renderTimes(cfg?.timesISO||[]);
  $('#remStatus').textContent = cfg ? 'Configuración cargada' : 'Sin configuración';
  updatePreview();
}
function renderTimes(list){ const ul = $('#remListTimes'); ul.innerHTML = ''; if(!list.length){ ul.innerHTML='<li class="small">—</li>'; return; } list.forEach(t=>{ const li=document.createElement('li'); li.textContent=new Date(t).toLocaleString(); ul.appendChild(li); }); }

// Marcar edición/dirty para no sobrescribir tu input
$('#remAppt').addEventListener('focus', ()=>{ remEditing = true; });
$('#remAppt').addEventListener('blur',  ()=>{ remEditing = false; updatePreview(); });
$('#remAppt').addEventListener('input', ()=>{ remDirty = true; updatePreview(); });
$('#remPlan').addEventListener('change', ()=>{ remDirty = true; updatePreview(); });
$('#remTpl').addEventListener('input', ()=>{ remDirty = true; updatePreview(); });

// Guardar
$('#remSaveBtn').onclick = async ()=>{
  if(!currentJid) return;
  const raw = $('#remAppt').value;
  const body = { jid: currentJid, enabled: !!$('#remEnabled').checked, plan: $('#remPlan').value, appointmentISO: raw || null, template: $('#remTpl').value };
  $('#remStatus').textContent = 'Guardando...';
  try{
    const r = await fetch('/api/panel/reminders',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const data = await r.json();
    if (data.ok){
      remDirty = false; remEditing = false;
      $('#remStatus').textContent='✅ Guardado';
      $('#remEnabled').checked=!!data.reminder.enabled;
      renderTimes(data.reminder.timesISO||[]);
      updatePreview();
      loadTasks();
    } else { $('#remStatus').textContent='⚠ '+(data.error||'Error'); }
  }catch{ $('#remStatus').textContent='❌ Error de conexión'; }
};

// Toggle directo – solo si hay fecha válida
$('#remEnabled').addEventListener('change', async (e)=>{
  if(!currentJid) return; const enabled=!!e.target.checked; const raw=$('#remAppt').value;
  if (enabled && !raw){ $('#remStatus').textContent='Primero elige fecha y hora'; e.target.checked=false; return; }
  const body={ jid: currentJid, enabled, plan: $('#remPlan').value, appointmentISO: raw || null, template: $('#remTpl').value };
  try{
    const r=await fetch('/api/panel/reminders',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const data=await r.json();
    if (!data.ok){ e.target.checked=!enabled; $('#remStatus').textContent='⚠ '+(data.error||'Error'); return; }
    remDirty = false; remEditing = false;
    $('#remStatus').textContent = enabled ? '✅ Activado' : '⏸ Desactivado';
    renderTimes(data.reminder.timesISO||[]);
    updatePreview();
    loadTasks();
  }catch{ e.target.checked=!enabled; $('#remStatus').textContent='❌ Error de conexión'; }
});

// Vista previa local de plantilla
function updatePreview(){
  const raw = $('#remTpl').value || '';
  const apptVal = $('#remAppt').value;
  let fecha = '', hora = '', fecha_hora = '';
  if (apptVal){
    const d = new Date(apptVal);
    fecha = d.toLocaleDateString('es-CO', { day:'numeric', month:'long', year:'numeric' });
    hora = d.toLocaleTimeString('es-CO', { hour:'2-digit', minute:'2-digit' });
    fecha_hora = fecha + ' a las ' + hora;
  }
  const ctx = {
    nombre: ($('#chatTitle').textContent.split('(')[0]||'paciente').trim(),
    fecha, hora, fecha_hora,
    jid: (currentJid||'').split('@')[0],
    tipo: 'consulta'
  };
  const out = raw.replace(/\{(nombre|fecha|hora|fecha_hora|jid|tipo)\}/gi, (_,k)=> ctx[k.toLowerCase()] ?? '');
  $('#remPreview').textContent = out;
}

/* ===== Calendario ===== */
function groupByDate(evts){ const map = new Map(); for(const e of evts){ const dateKey = (e.start || '').slice(0,10); if(!map.has(dateKey)) map.set(dateKey, []); map.get(dateKey).push(e); } return Array.from(map.entries()).sort((a,b)=>a[0].localeCompare(b[0])); }
async function loadCalendar(){
  const days=$('#calRange').value||'14'; const r=await fetch('/api/calendar/events?days='+encodeURIComponent(days)); const data=await r.json();
  const list=$('#calList'); list.innerHTML='';
  if(!data.ok){ list.textContent='Error cargando eventos: '+(data.error||''); console.error('calendar error', data); return; }
  const groups=groupByDate(data.events||[]); if(groups.length===0){ list.textContent='Sin eventos en el rango.'; return; }
  for(const [date, evs] of groups){ const dayDiv=document.createElement('div'); dayDiv.className='cal-day'; const h=document.createElement('h3'); h.textContent=new Date(date).toLocaleDateString(); dayDiv.appendChild(h);
    evs.forEach(ev=>{ const el=document.createElement('div'); el.className='cal-ev'; const timeTxt=(ev.start && ev.start.length>10)?(new Date(ev.start)).toLocaleTimeString():'Todo el día'; el.innerHTML=\`<div><strong>\${ev.summary||'(Sin título)'}</strong></div><div>\${timeTxt}\${ev.location?' • '+ev.location:''}</div>\${ev.htmlLink?'<div><a target="_blank" href="'+ev.htmlLink+'">Abrir en Google Calendar</a></div>':''}\`; dayDiv.appendChild(el);});
    list.appendChild(dayDiv); }
}
$('#calRange').onchange = loadCalendar;
$('#calReload').onclick = loadCalendar;

/* ===== Tareas (lista de recordatorios) ===== */
async function loadTasks(){
  const r = await fetch('/api/panel/reminders'); const data = await r.json();
  const list = $('#tasksList'); list.innerHTML='';
  (data.reminders||[]).filter(x=>x.enabled).forEach(rm=>{
    const next = (rm.timesISO||[])[0] ? new Date(rm.timesISO[0]).toLocaleString() : '—';
    const div = document.createElement('div'); const initials=(String(rm.name||rm.jid).trim()[0]||'?').toUpperCase();
    div.className='task';
    div.innerHTML=\`
      <div class="avatar">\${initials}</div>
      <div>
        <div class="who">\${rm.name||rm.jid} <span class="cmeta">(\${rm.jid})</span></div>
        <div class="cmeta">Cita: \${rm.appointmentISO ? new Date(rm.appointmentISO).toLocaleString() : '—'} • Plan: \${rm.plan}</div>
        <div class="cmeta">Próximo aviso: \${next}</div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn ghost">Abrir chat</button>
        <label class="pill"><input type="checkbox" \${rm.enabled?'checked':''} data-jid="\${rm.jid}" class="t-toggle"/> Activo</label>
      </div>\`;
    div.querySelector('.btn.ghost').onclick = ()=>{ openChat(rm.jid); showView('conversaciones'); };
    list.appendChild(div);
  });
  document.querySelectorAll('.t-toggle').forEach(chk=>{
    chk.addEventListener('change', async (e)=>{
      const jid = e.target.getAttribute('data-jid');
      await fetch('/api/panel/reminders',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({jid, enabled: !!e.target.checked})});
      loadTasks();
    });
  });
}

/* ===== Boot ===== */
async function boot(){
  await syncGlobalAI();
  await fetchChats();
  await loadHome();
  setInterval(async()=>{
    await fetchChats();
    if(views.conversaciones.style.display==='block' && currentJid){
      await fetchMessages({ reloadRem: false }); // no pisar recordatorio mientras editas
    }
    if(views.whatsapp.style.display==='block') await loadWAStatus();
  }, 3000);
}
boot();
</script>
</body>
</html>`;

app.get('/panel', (req, res) => res.type('html').send(PANEL_HTML));

// ============== /chat (lógica IA por sesión) ==============
app.post('/chat', async (req, res) => {
  const from = normJid(String(req.body.from || 'anon'));
  const userMsg = String(req.body.message || '').trim();

  // Cinturón y tirantes: si IA está OFF, no respondemos nada
  if (!panelState.aiGlobalEnabled || panelState.aiDisabledChats.has(from)) {
    return res.json({ reply: '' });
  }

  const session = getSession(from);
  const now = DateTime.now().setZone(ZONE);

  if (session.priority?.active && now >= DateTime.fromISO(session.priority.lockUntilISO)) session.priority = null;
  if (session.priority?.active && session.priority.status === 'submitted') return res.json({ reply: PRIORITY_LOCK_MESSAGE });

  if (userMsg === '__RESET__') { sessions.delete(from); return res.json({ ok: true, reset: true }); }

  const todayNote = `Hoy es ${DateTime.now().setZone(ZONE).toISODate()} (${ZONE}). Reglas: Martes sin consulta; virtual sólo viernes tarde;ni fechas pasadas.`;
  session.history.push({ role: 'system', content: todayNote });
  const policyNote = 'Reglas de entrevista: si es **primera vez**, solicitar **Nombres y Apellidos completos**. ' +
  'Siempre preguntar si tiene **estudios recientes**, **cuándo** y **dónde** se los hizo. ' +
  'No usar “Horarios disponibles”, usar “Disponibilidad de citas”. ' +
  'No resumir PDFs.';
  session.history.push({
  role: 'system',
  content: 'Regla EPS: si la entidad es Coomeva y el plan es Preferente, no se atiende ni se agenda. Si dicen Coomeva sin plan, pregunta por el plan explícitamente.',
});

session.history.push({ role: 'system', content: policyNote });


  if (session.birads) session.history.push({ role: 'system', content: `BIRADS ${session.birads} detectado previamente. No pidas de nuevo la categoría; procede según reglas.` });
  if (session.lastSystemNote) { session.history.push({ role: 'system', content: session.lastSystemNote }); session.lastSystemNote = null; }

  session.history.push({ role: 'user', content: userMsg });
  capHistory(session); touchSession(session);

  try {
    const completion = await openai.chat.completions.create({ model: 'gpt-4o', messages: session.history });
    let reply = completion.choices[0].message.content || '';
    const actionResult = await maybeHandleAssistantAction(reply, session);

    if (actionResult?.handled && actionResult.makeResponse) {
      const mr = actionResult.makeResponse;
      const many = Array.isArray(mr) ? mr : [mr];
      const errors   = many.filter(x => x && x.ok === false);
      const daysResp = many.find(x => Array.isArray(x?.dias_disponibles));
      const daySlots = many.find(x => Array.isArray(x?.slots));
      const cancelled= many.find(x => x && x.cancelled === true);

      if (cancelled) {
        reply = '✅ Tu cita fue cancelada. ¿Deseas **reprogramarla**? Puedo mostrarte la disponibilidad desde el 12 de noviembre (2:00–5:30 p. m.).';
      } else if (errors.length) {
        reply = errors.map(e => `⚠️ ${e.message || 'Operación no completada.'}`).join('\n\n');
      } else if (daySlots) {
        if (!daySlots.slots.length) reply = `Para ${fmtFechaHumana(daySlots.fecha)} no hay cupos válidos. ¿Quieres otra fecha?`;
        else {
          const fechaTxt = fmtFechaHumana(daySlots.fecha);
          const horas = daySlots.slots.map(s => fmtHoraHumana(s.inicio)).join(', ');
          reply = `${fechaTxt}: ${horas}\n\n¿Te sirve alguna hora? Responde con la hora exacta (ej. "8:15").`;
        }
      } else if (daysResp) {
        if (!daysResp.dias_disponibles.length) reply = `No tengo cupos en los próximos ${daysResp.dias} días. ¿Probamos otro rango?`;
        else {
          const lineas = daysResp.dias_disponibles.map(d => {
            const fecha = fmtFechaHumana(d.fecha);
            const horas = (d.slots || []).map(s => fmtHoraHumana(s.inicio)).join(', ');
            return `- ${fecha}: ${horas}`;
          }).join('\n');
          reply = `Disponibilidad de citas:\n${lineas}\n\n¿Cuál eliges?`;
        }
      }

      session.history.push({ role: 'assistant', content: reply });
      capHistory(session); touchSession(session);
      return res.json({ reply, makeResponse: actionResult.makeResponse });
    }

    // Fallback disponibilidad si pidió horarios
    const u = userMsg.toLowerCase();
    const pideDispon = /disponibilidad|horarios|agenda|qué días|que dias|que horarios|que horario/.test(u);
    if (pideDispon) {
      try {
        const desde = DateTime.now().setZone(ZONE).toISODate();
        const tipo = 'Control presencial'; const dias = 14;
        const diasDisp = await disponibilidadPorDias({ tipo, desdeISO: desde, dias });
        if (!diasDisp.length) reply = `No tengo cupos en los próximos ${dias} días. ¿Probamos otro rango o tipo (virtual viernes tarde)?`;
        else {
          const lineas = diasDisp.map(d => {
            const fecha = fmtFechaHumana(d.fecha);
            const horas = (d.slots || []).map(s => fmtHoraHumana(s.inicio)).join(', ');
            return `- ${fecha}: ${horas}`;
          }).join('\n');
          reply = `Disponibilidad de citas:\n${lineas}\n\n¿Cuál eliges?`;
        }
      } catch (e) { console.error('❌ Fallback disponibilidad error:', e); reply = '⚠️ No pude consultar la disponibilidad ahora. Intenta de nuevo en unos minutos.'; }
    }

    session.history.push({ role: 'assistant', content: reply });
    capHistory(session); touchSession(session);
    res.json({ reply, makeResponse: null });
  } catch (e) {
    console.error('OpenAI error:', e?.status, e?.message, e?.response?.data);
    res.status(500).json({ error: 'ai_error', detail: e?.message });
  }
});

// ====== Endpoints directos para probar disponibilidad ======
app.post('/availability', async (req, res) => {
  try {
    const { tipo = 'Control presencial' } = req.body;
    let { fecha } = req.body;
    if (!fecha) return res.status(400).json({ ok: false, error: 'falta_fecha' });

    fecha = coerceFutureISODate(fecha);
    const { dur, ventanas, slots } = generarSlots(fecha, tipo, 100);
    if (!ventanas.length) return res.json({ ok: true, fecha, tipo, duracion_min: dur, slots: [] });

    const busy = await consultarBusy(ventanas);
    const libres = filtrarSlotsLibres(slots, busy);
    res.json({ ok: true, fecha, tipo, duracion_min: dur, slots: libres });
  } catch (e) { console.error(e); res.status(500).json({ ok: false, error: 'server_error' }); }
});

app.post('/availability-range', async (req, res) => {
  try {
    const { tipo = 'Control presencial' } = req.body;
    let { desde, dias = 14 } = req.body;
    if (!desde) return res.status(400).json({ ok: false, error: 'falta_desde' });
    if (dias > 120) dias = 120;

    const desdeFixed = coerceFutureISODateOrToday(desde);
    const diasDisp = await disponibilidadPorDias({ tipo, desdeISO: desdeFixed, dias });
    res.json({ ok: true, tipo, desde: desdeFixed, dias, dias_disponibles: diasDisp });
  } catch (e) { console.error(e); res.status(500).json({ ok: false, error: 'server_error' }); }
});

app.get('/healthz', (_, res) => res.status(200).send('ok'));

// 1) Redirige el root al panel
app.get('/', (req, res) => res.redirect('/panel'));

// 2) Sirve el panel inline (si ya lo tenías, déjalo igual)
app.get('/panel', (req, res) => {
  res.type('html').send(PANEL_HTML);   // <-- tu PANEL_HTML grande tal cual
});

// 3) Logo simple (opcional) para evitar 404 en /assets/logo.svg
app.get('/assets/logo.svg', (req, res) => {
  res.type('image/svg+xml').send(`
    <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none">
      <rect x="2" y="2" width="20" height="20" rx="6" stroke="#4da3ff" stroke-width="2"/>
      <path d="M7 13l3 3 7-7" stroke="#2cd4c6" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  `);
});


// ====== ARRANQUE ======
// reemplaza tu listen actual
// --- config de servidor ---
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// Si estamos en Render, autoapuntar al puerto real en localhost
const SELF_BASE =
  process.env.SELF_BASE ||
  (process.env.RENDER ? `http://127.0.0.1:${PORT}` : `http://localhost:${PORT}`);

app.listen(PORT, HOST, () =>
  console.log(`🚀 Servidor en http://${HOST}:${PORT}`)
);

connectWhatsApp().catch(err => { console.error('❌ Error conectando WhatsApp:', err); });






