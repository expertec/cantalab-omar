import {
  getWhatsAppSock,
  buildJidFromPhone,
  extractJidFromLead
} from '../whatsappService.js';
import { db } from '../firebaseAdmin.js';  // Asegúrate de tener Firebase Admin configurado

/**
 * Función para enviar mensajes a través de WhatsApp
 * @param {string} leadId - El ID del lead al que se va a enviar el mensaje.
 * @param {string} message - El contenido del mensaje a enviar.
 */
export async function sendMessage(leadId, message) {
  try {
    const leadDoc = await db.collection('leads').doc(leadId).get();
    if (!leadDoc.exists) {
      throw new Error(`Lead con ID ${leadId} no encontrado.`);
    }
    const leadData = leadDoc.data();
    const jidFromLead = extractJidFromLead({ id: leadId, ...leadData });
    let jid = jidFromLead;

    if (!jid) {
      const telefono = leadData.telefono;
      const built = telefono ? buildJidFromPhone(telefono) : null;
      jid = built?.jid;
    }

    if (!jid) {
      throw new Error(`No se pudo obtener JID para el lead ${leadId}`);
    }

    // Enviar mensaje a WhatsApp
    const sock = getWhatsAppSock();
    if (!sock) {
      throw new Error('No hay conexión activa con WhatsApp.');
    }

    const sendMessagePromise = sock.sendMessage(jid, { text: message });
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out')), 10000));

    await Promise.race([sendMessagePromise, timeout]);
    console.log(`Mensaje enviado a ${jid}: ${message}`);

    // Guardar el mensaje en Firebase
    const newMessage = {
      content: message,
      sender: "business",
      timestamp: new Date(),
    };
    await db.collection('leads').doc(leadId).collection('messages').add(newMessage);
    console.log(`Mensaje guardado en Firebase: ${message}`);
  } catch (error) {
    console.error('Error en el envío de mensaje:', error);
    throw error;
  }
}
