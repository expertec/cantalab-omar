// whatsappService.js
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  jidNormalizedUser
} from 'baileys'; // Sin @whiskeysockets/
import QRCode from 'qrcode-terminal';
import Pino from 'pino';
import fs from 'fs';
import path from 'path';
import admin from 'firebase-admin';
import { db } from './firebaseAdmin.js';
import {
  computeSequenceStepRun,
  computeNextRunForLead
} from './services/sequenceUtils.js';
import axios from 'axios';      

let latestQR = null;
let connectionStatus = "Desconectado";
let whatsappSock = null;
let sessionPhone = null; // almacenará el número de la sesión activa

const localAuthFolder = '/var/data';
const { FieldValue } = admin.firestore;
const bucket = admin.storage().bucket();
const DEFAULT_COUNTRY_CODE = '52';

function normalizeRemoteJid(jid) {
  if (!jid) return '';
  try {
    return jidNormalizedUser(jid);
  } catch {
    return jid;
  }
}

function normalizePhoneNumber(raw) {
  if (!raw) return '';
  let num = String(raw).replace(/\D/g, '');
  if (!num) return '';
  if (num.length === 10) {
    num = `${DEFAULT_COUNTRY_CODE}${num}`;
  }
  return num;
}

export function buildJidFromPhone(rawPhone) {
  const phone = normalizePhoneNumber(rawPhone);
  if (!phone) {
    throw new Error('Número de teléfono inválido');
  }
  return {
    phone,
    jid: normalizeRemoteJid(`${phone}@s.whatsapp.net`)
  };
}

export function normalizeJid(jid) {
  return normalizeRemoteJid(jid);
}

export async function connectToWhatsApp() {
  try {
    // Asegurar carpeta de auth
    if (!fs.existsSync(localAuthFolder)) {
      fs.mkdirSync(localAuthFolder, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(localAuthFolder);

    // Extraer número de sesión
    if (state.creds.me?.id) {
      const normalized = normalizeRemoteJid(state.creds.me.id);
      sessionPhone = normalized.split('@')[0];
    }

    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({
      auth: state,
      logger: Pino({ level: 'info' }),
      printQRInTerminal: true,
      version,
    });
    whatsappSock = sock;

    // Manejo de conexión
    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        latestQR = qr;
        connectionStatus = "QR disponible. Escanéalo.";
        QRCode.generate(qr, { small: true });
      }
      if (connection === 'open') {
        connectionStatus = "Conectado";
        latestQR = null;
        if (sock.user?.id) {
          const normalized = normalizeRemoteJid(sock.user.id);
          sessionPhone = normalized.split('@')[0];
        }
      }
      if (connection === 'close') {
        const reason = lastDisconnect?.error?.output?.statusCode;
        connectionStatus = "Desconectado";
        if (reason === DisconnectReason.loggedOut) {
          fs.readdirSync(localAuthFolder).forEach(f =>
            fs.rmSync(path.join(localAuthFolder, f), { force: true, recursive: true })
          );
          sessionPhone = null;
        }
        connectToWhatsApp();
      }
    });

    sock.ev.on('creds.update', saveCreds);

    // Dentro de whatsappService.js, ubica tu sección donde tienes:
// sock.ev.on('messages.upsert', async ({ messages, type }) => { … });

sock.ev.on('messages.upsert', async ({ messages, type }) => {
  if (type !== 'notify') return;

  for (const msg of messages) {
    if (!msg.key) continue;
    const jid = normalizeRemoteJid(msg.key.remoteJid);
    if (!jid || jid.endsWith('@g.us')) continue; // ignorar grupos

    // 1) Determinar número de teléfono y quién envía
    const phone = jid.split('@')[0];
    const isBusinessMessage = Boolean(msg.key?.fromMe);
    const sender = isBusinessMessage ? 'business' : 'lead';

    // 2) Inicializar variables para contenido y tipo de media
    let content = '';
    let mediaType = null;
    let mediaUrl = null;

    // 3) Procesar distintos tipos de mensaje
    try {
      // 3.1) Video
      if (msg.message.videoMessage) {
        mediaType = 'video';
        const buffer = await downloadMediaMessage(
          msg,
          'buffer',
          {},
          { logger: Pino() }
        );
        const fileName = `videos/${phone}-${Date.now()}.mp4`;
        const fileRef = admin.storage().bucket().file(fileName);
        await fileRef.save(buffer, { contentType: 'video/mp4' });
        const [url] = await fileRef.getSignedUrl({
          action: 'read',
          expires: '03-01-2500'
        });
        mediaUrl = url;
      }
      // 3.2) Imagen
      else if (msg.message.imageMessage) {
        mediaType = 'image';
        const buffer = await downloadMediaMessage(
          msg,
          'buffer',
          {},
          { logger: Pino() }
        );
        const fileName = `images/${phone}-${Date.now()}.jpg`;
        const fileRef = admin.storage().bucket().file(fileName);
        await fileRef.save(buffer, { contentType: 'image/jpeg' });
        const [url] = await fileRef.getSignedUrl({
          action: 'read',
          expires: '03-01-2500'
        });
        mediaUrl = url;
      }
      // 3.3) Audio
      else if (msg.message.audioMessage) {
        mediaType = 'audio';
        const buffer = await downloadMediaMessage(
          msg,
          'buffer',
          {},
          { logger: Pino() }
        );
        const fileName = `audios/${phone}-${Date.now()}.ogg`;
        const fileRef = admin.storage().bucket().file(fileName);
        await fileRef.save(buffer, { contentType: 'audio/ogg' });
        const [url] = await fileRef.getSignedUrl({
          action: 'read',
          expires: '03-01-2500'
        });
        mediaUrl = url;
      }
      // 3.4) Documento
      else if (msg.message.documentMessage) {
        mediaType = 'document';
        const { mimetype, fileName: origName } = msg.message.documentMessage;
        const buffer = await downloadMediaMessage(
          msg,
          'buffer',
          {},
          { logger: Pino() }
        );
        const ext = path.extname(origName) || '';
        const fileName = `docs/${phone}-${Date.now()}${ext}`;
        const fileRef = admin.storage().bucket().file(fileName);
        await fileRef.save(buffer, { contentType: mimetype });
        const [url] = await fileRef.getSignedUrl({
          action: 'read',
          expires: '03-01-2500'
        });
        mediaUrl = url;
      }
      // 3.5) Texto o extendedTextMessage
      else if (msg.message.conversation) {
        content = msg.message.conversation.trim();
        mediaType = 'text';
      } else if (msg.message.extendedTextMessage?.text) {
        content = msg.message.extendedTextMessage.text.trim();
        mediaType = 'text';
      } else {
        // Cualquier otro tipo, lo ignoramos por ahora
        continue;
      }
    } catch (err) {
      console.error('Error descargando/guardando media:', err);
      continue; // saltar este mensaje si falla descarga
    }

    // 4) BUSCAR O CREAR EL LEAD en Firestore usando JID como ID

const leadRef = db.collection('leads').doc(jid);
const docSnap = await leadRef.get();

// Leemos configuración para defaultTrigger (solo una vez)
const cfgSnap = await db.collection('config').doc('appConfig').get();
const cfg = cfgSnap.exists ? cfgSnap.data() : {};

const normalizedContent = (content || '').toLowerCase();
const manualLinkRequested = isBusinessMessage && normalizedContent.includes('#link');

// Detectamos si el mensaje incluye "#webPro1490"
let trigger;
if (normalizedContent.includes('#webpro1490')) {
  trigger = 'LeadWeb1490';
} else {
  trigger = cfg.defaultTrigger || 'NuevoLead';
}
const nowIso = new Date().toISOString();

if (!docSnap.exists) {
  // Si NO existe, creamos el lead nuevo con el JID como ID
  const initialSequence = {
    trigger,
    startTime: nowIso,
    index: 0
  };
  const nextRunDate = await computeSequenceStepRun(trigger, nowIso, 0);
  const leadPayload = {
    telefono: phone,
    nombre: msg.pushName || '',
    source: 'WhatsApp',
    fecha_creacion: new Date(),
    estado: 'nuevo',
    etiquetas: [trigger],
    secuenciasActivas: [initialSequence],
    unreadCount: 0,
    lastMessageAt: new Date()
  };
  if (nextRunDate) {
    leadPayload.nextSequenceRunAt = admin.firestore.Timestamp.fromDate(nextRunDate);
  }
  await leadRef.set(leadPayload);
} else {
  // Si YA existe, aseguramos que tenga la secuencia activa correspondiente
  const leadData = docSnap.data() || {};
  const updatePayload = {
    etiquetas: FieldValue.arrayUnion(trigger),
    lastMessageAt: new Date()
  };

  let existingSequences = Array.isArray(leadData.secuenciasActivas)
    ? [...leadData.secuenciasActivas]
    : [];

  if (manualLinkRequested) {
    // Fuerza reinicio de la secuencia eliminando instancias anteriores del trigger.
    existingSequences = existingSequences.filter(seq => seq.trigger !== trigger);
  }

  const hasSameTrigger = existingSequences.some(seq => seq.trigger === trigger);

  if (!hasSameTrigger || manualLinkRequested) {
    const newSequence = {
      trigger,
      startTime: nowIso,
      index: 0
    };
    existingSequences.push(newSequence);
    updatePayload.secuenciasActivas = existingSequences;

    const nextRunDate = await computeNextRunForLead(existingSequences);
    if (nextRunDate) {
      updatePayload.nextSequenceRunAt = admin.firestore.Timestamp.fromDate(nextRunDate);
    } else {
      updatePayload.nextSequenceRunAt = FieldValue.delete();
    }
  }

  await leadRef.update(updatePayload);
}

const leadId = jid;


    // 5) GUARDAR el mensaje dentro de /leads/{leadId}/messages
    const msgData = {
      content,
      mediaType,
      mediaUrl,
      sender,
      timestamp: new Date()
    };
    await db
      .collection('leads')
      .doc(leadId)
      .collection('messages')
      .add(msgData);

    // 6) ACTUALIZAR el lead: incrementar unreadCount si envió el lead
    const updateData = { lastMessageAt: msgData.timestamp };
    if (sender === 'lead') {
      updateData.unreadCount = FieldValue.increment(1);
    }
    await db.collection('leads').doc(leadId).update(updateData);
  }
});

    

    return sock;
  } catch (error) {
    console.error("Error al conectar con WhatsApp:", error);
    throw error;
  }
}

export async function sendFullAudioAsDocument(phone, fileUrl) {
  const sock = getWhatsAppSock();
  if (!sock) throw new Error('No hay conexión activa con WhatsApp');

  const { jid } = buildJidFromPhone(phone);

  // 1) Descargar el archivo
  let res;
  try {
    res = await axios.get(fileUrl, { responseType: 'arraybuffer' });
  } catch (err) {
    console.error('Error descargando fullUrl:', err);
    throw new Error('No se pudo descargar el archivo completo');
  }
  if (!res.data) {
    throw new Error('La descarga no produjo datos');
  }
  const buffer = Buffer.from(res.data);

  // 2) Enviar como documento adjunto (payload "flat")
  try {
    await sock.sendMessage(jid, {
      document: buffer,
      mimetype: 'audio/mpeg',
      fileName: 'cancion_completa.mp3',
      caption: '¡Te comparto tu canción completa!'
    });
    console.log(`✅ Canción completa enviada como adjunto a ${jid}`);
  } catch (err) {
    console.error('Error enviando documento:', err);
    throw err;
  }
}

export async function sendMessageToLead(phone, messageContent) {
  if (!whatsappSock) {
    throw new Error('No hay conexión activa con WhatsApp');
  }

  // 1) Normalizar número / JID
  const { jid, phone: normalizedPhone } = buildJidFromPhone(phone);

  // 2) Enviar mensaje de texto sin link preview y con timeout extendido
  await whatsappSock.sendMessage(
    jid,
    {
      text: messageContent,
      linkPreview: false
    },
    {
      timeoutMs: 60_000
    }
  );

  // 3) Guardar en Firestore bajo sender 'business'
  const q = await db
    .collection('leads')
    .where('telefono', '==', normalizedPhone)
    .limit(1)
    .get();

  if (!q.empty) {
    const leadId = q.docs[0].id;
    const outMsg = {
      content: messageContent,
      sender: 'business',
      timestamp: new Date()
    };

    // 3a) Añadir al subcolección messages
    await db
      .collection('leads')
      .doc(leadId)
      .collection('messages')
      .add(outMsg);

    // 3b) Actualizar lastMessageAt del lead
    await db
      .collection('leads')
      .doc(leadId)
      .update({ lastMessageAt: outMsg.timestamp });
  }

  return { success: true };
}

export function getLatestQR() {
  return latestQR;
}

export function getConnectionStatus() {
  return connectionStatus;
}

export function getWhatsAppSock() {
  return whatsappSock;
}

export function getSessionPhone() {
  return sessionPhone;
}

/**
 * Envía una nota de voz en M4A, la sube a Firebase Storage y la guarda en Firestore.
 * @param {string} phone    — número limpio (solo dígitos, con código de país).
 * @param {string} filePath — ruta al archivo .m4a en el servidor.
 */
export async function sendAudioMessage(phone, filePath) {
  const sock = getWhatsAppSock();
  if (!sock) throw new Error('Socket de WhatsApp no está conectado');

  const { jid, phone: normalizedPhone } = buildJidFromPhone(phone);

  // 1) Leer y enviar por Baileys como audio/mp4
  const audioBuffer = fs.readFileSync(filePath);
  await sock.sendMessage(jid, {
    audio: audioBuffer,
    mimetype: 'audio/mp4',
    ptt: true,    // ← activa el modo nota de voz
  });

  // 2) Subir a Firebase Storage
  const bucket = admin.storage().bucket();
  const dest   = `audios/${normalizedPhone}-${Date.now()}.m4a`;
  const file   = bucket.file(dest);
  await file.save(audioBuffer, { contentType: 'audio/mp4' });
  const [mediaUrl] = await file.getSignedUrl({
    action: 'read',
    expires: '03-01-2500'
  });

  // 3) Guardar en Firestore
  const q = await db.collection('leads')
                    .where('telefono', '==', normalizedPhone)
                    .limit(1)
                    .get();
  if (!q.empty) {
    const leadId = q.docs[0].id;
    const msgData = {
      content: '',
      mediaType: 'audio',
      mediaUrl,
      sender: 'business',
      timestamp: new Date()
    };
    await db.collection('leads')
            .doc(leadId)
            .collection('messages')
            .add(msgData);
    await db.collection('leads')
            .doc(leadId)
            .update({ lastMessageAt: msgData.timestamp });
  }
}

/**
 * Envía un clip de audio AAC (.m4a) inline desde su URL.
 *
 * @param {string} phone      — número de teléfono (con o sin +52)
 * @param {string} clipUrl    — URL pública al .m4a (p.ej. Firebase Storage)
 */
export async function sendClipMessage(phone, clipUrl) {
  const sock = getWhatsAppSock();
  if (!sock) throw new Error('No hay conexión activa con WhatsApp');

  // 1) Normalizar teléfono → JID
  const { jid } = buildJidFromPhone(phone);

  // 2) Payload de audio directo desde URL
  const messagePayload = {
    audio: { url: clipUrl },
    mimetype: 'audio/mp4',
    ptt: false,
  };

  // 3) Opciones con timeout extendido y sin marcar como leído
  const sendOpts = {
    timeoutMs: 120_000,
    sendSeen: false,
  };

  // 4) Retry automático sólo en “Timed Out”
  for (let i = 1; i <= 3; i++) {
    try {
      await sock.sendMessage(jid, messagePayload, sendOpts);
      console.log(`✅ clip enviado (intento ${i}) a ${jid}`);
      return;
    } catch (err) {
      const isTO = err.message?.includes('Timed Out');
      console.warn(`⚠️ fallo envío clip intento ${i}${isTO ? ' (Timeout)' : ''}`);
      if (i === 3 || !isTO) throw err;
      await new Promise(r => setTimeout(r, 2_000 * i));
    }
  }
}
