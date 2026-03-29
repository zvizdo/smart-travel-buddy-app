const QUEUE_KEY = "pulse_offline_queue";

interface QueuedPulse {
  tripId: string;
  lat: number;
  lng: number;
  heading: number;
  timestamp: number;
}

export function enqueuePulse(pulse: QueuedPulse): void {
  const queue = getQueue();
  queue.push(pulse);
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}

export function getQueue(): QueuedPulse[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    return raw ? (JSON.parse(raw) as QueuedPulse[]) : [];
  } catch {
    return [];
  }
}

export function clearQueue(): void {
  localStorage.removeItem(QUEUE_KEY);
}

export async function flushQueue(
  sendPulse: (tripId: string, lat: number, lng: number, heading: number) => Promise<void>,
): Promise<number> {
  const queue = getQueue();
  if (queue.length === 0) return 0;

  // Only send the latest pulse per trip (older ones are stale)
  const latestByTrip = new Map<string, QueuedPulse>();
  for (const pulse of queue) {
    const existing = latestByTrip.get(pulse.tripId);
    if (!existing || pulse.timestamp > existing.timestamp) {
      latestByTrip.set(pulse.tripId, pulse);
    }
  }

  let sent = 0;
  for (const pulse of latestByTrip.values()) {
    try {
      await sendPulse(pulse.tripId, pulse.lat, pulse.lng, pulse.heading);
      sent++;
    } catch {
      // If sending fails, keep remaining in queue
    }
  }

  clearQueue();
  return sent;
}
