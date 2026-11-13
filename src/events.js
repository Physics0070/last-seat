/**
 * Server-sent events backed by a transactional outbox.
 *
 *   1. A change writes its events into `outbox` INSIDE its own transaction (see withTxn in db.js), so an event exists
 *      if and only if the change committed.
 *   2. After the commit, `publish` gives each event the next sequence number (monotonic, and continuing across restarts
 *      because it starts from the highest number stored), sends it to connected clients, and stamps the number into
 *      the outbox.
 *   3. A reconnecting client sends Last-Event-ID; anything newer is replayed from memory or, if the client is further
 *      behind than the memory buffer (or the server restarted), from the outbox.
 *   4. At boot, events that committed but were never stamped (the process died between commit and publish) are
 *      published then. Nothing committed is lost silently.
 *
 * Each payload carries `eventId` (the outbox document id) so a client can drop the rare duplicate: an event sent live
 * whose stamp failed is stamped again at the next boot under a new number.
 *
 * ponytail: sequence numbers come from this process, so this is correct for one instance. Scale-out path: every
 * instance tails the outbox with a change stream and uses the change's cluster time as the event id.
 */
export async function createEventBus(ctx) {
  const { config, outbox, log } = ctx;
  const buffer = [];
  const clients = new Set();
  const last = await outbox.find({ seq: { $type: 'number' } }, { projection: { seq: 1 } }).sort({ seq: -1 }).limit(1).next();
  let seq = last?.seq ?? 0;

  const frame = (e) => `id: ${e.seq}\ndata: ${e.json}\n\n`;
  const toEvent = (doc, number) => ({
    seq: number,
    hackathonId: String(doc.hackathonId),
    json: JSON.stringify({ ...doc.data, eventId: String(doc._id), at: doc.at }),
  });
  const send = (client, e) => {
    if (client.hackathonId !== e.hackathonId) return;
    if (client.queue) client.queue.push(e);
    else client.res.write(frame(e));
  };

  /** Publishes committed outbox documents in order. Returns once they are stamped. */
  async function publish(docs) {
    if (!docs?.length) return;
    const events = docs.map((doc) => toEvent(doc, ++seq));
    for (const e of events) {
      buffer.push(e);
      if (buffer.length > config.SSE_REPLAY_BUFFER) buffer.shift();
      for (const client of clients) send(client, e);
    }
    await outbox.bulkWrite(
      docs.map((doc, i) => ({ updateOne: { filter: { _id: doc._id, seq: { $exists: false } }, update: { $set: { seq: events[i].seq } } } })),
      { ordered: false },
    );
  }

  /** Events that committed but were never published by a previous process. */
  async function relay() {
    const pending = await outbox.find({ seq: { $exists: false } }).sort({ _id: 1 }).toArray();
    await publish(pending);
    return pending.length;
  }

  /** Everything after `after` for one hackathon, or null when continuity cannot be proven. */
  async function missedSince(hackathonId, after) {
    if (!Number.isInteger(after) || after < 0 || after > seq) return null;
    const fromMemory = buffer.filter((e) => e.seq > after && e.hackathonId === hackathonId);
    if (buffer.length && after >= buffer[0].seq - 1) return fromMemory;
    // Further back than memory: read the outbox. Retention removes old rows, so prove nothing in between was dropped.
    const oldest = await outbox.find({ seq: { $type: 'number' } }, { projection: { seq: 1 } }).sort({ seq: 1 }).limit(1).next();
    if (!oldest || after < oldest.seq - 1) return null;
    const rows = await outbox
      .find({ hackathonId: ctx.hackathon._id, seq: { $gt: after } })
      .sort({ seq: 1 })
      .limit(config.SSE_OUTBOX_REPLAY_MAX + 1)
      .toArray();
    if (rows.length > config.SSE_OUTBOX_REPLAY_MAX) return null;
    const stored = rows.map((doc) => toEvent(doc, doc.seq));
    // Events sent in the last moment may not be stamped yet; memory has them.
    const top = stored.at(-1)?.seq ?? after;
    return [...stored, ...fromMemory.filter((e) => e.seq > top)];
  }

  async function subscribe(req, res, hackathonId) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: ${config.SSE_RETRY_MS}\n\n`);

    // Registered before the replay is read, with live events queued, so nothing published meanwhile falls in the gap.
    const client = { res, hackathonId: String(hackathonId), queue: [] };
    clients.add(client);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), config.SSE_HEARTBEAT_MS);
    req.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(client);
    });

    const lastEventId = req.get('Last-Event-ID');
    let sent = seq;
    if (lastEventId !== undefined) {
      const after = /^\d+$/.test(lastEventId) ? Number(lastEventId) : NaN;
      const missed = await missedSince(client.hackathonId, after).catch((err) => {
        log.error({ err }, 'event replay failed');
        return null;
      });
      if (missed) {
        for (const e of missed) res.write(frame(e));
        sent = missed.at(-1)?.seq ?? after;
      } else {
        res.write('event: reset\ndata: {}\n\n');
      }
    }
    for (const e of client.queue) if (e.seq > sent) res.write(frame(e));
    client.queue = null;
  }

  function close() {
    for (const client of clients) client.res.end();
  }

  return { publish, relay, subscribe, close, clientCount: () => clients.size, lastSeq: () => seq };
}
