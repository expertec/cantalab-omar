import admin from 'firebase-admin';
import { db } from '../firebaseAdmin.js';

const sequencesCache = new Map();

async function loadSequenceByTrigger(trigger) {
  if (!trigger) return null;
  if (sequencesCache.has(trigger)) {
    return sequencesCache.get(trigger);
  }

  const snap = await db
    .collection('secuencias')
    .where('trigger', '==', trigger)
    .limit(1)
    .get();

  if (snap.empty) {
    sequencesCache.set(trigger, null);
    return null;
  }

  const data = snap.docs[0].data() || null;
  sequencesCache.set(trigger, data);
  return data;
}

export async function getSequenceDefinition(trigger) {
  return loadSequenceByTrigger(trigger);
}

function normalizeDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value.toDate === 'function') {
    try {
      return value.toDate();
    } catch {
      return null;
    }
  }
  return null;
}

export async function computeSequenceStepRun(trigger, startTime, index = 0) {
  const sequence = await loadSequenceByTrigger(trigger);
  if (!sequence || !Array.isArray(sequence.messages)) return null;
  if (index >= sequence.messages.length) return null;

  const baseDate = normalizeDate(startTime) || new Date();
  const delayMinutes = Number(sequence.messages[index]?.delay) || 0;
  return new Date(baseDate.getTime() + delayMinutes * 60_000);
}

export async function computeNextRunForLead(secuencias = []) {
  if (!Array.isArray(secuencias) || !secuencias.length) return null;
  const runDates = await Promise.all(
    secuencias.map(seq => computeSequenceStepRun(seq.trigger, seq.startTime, seq.index || 0))
  );
  const validDates = runDates.filter(Boolean);
  if (!validDates.length) return null;
  validDates.sort((a, b) => a.getTime() - b.getTime());
  return validDates[0];
}

export function toTimestamp(date) {
  if (!date) return null;
  if (date instanceof admin.firestore.Timestamp) return date;
  const normalized = date instanceof Date ? date : normalizeDate(date);
  if (!normalized) return null;
  return admin.firestore.Timestamp.fromDate(normalized);
}
