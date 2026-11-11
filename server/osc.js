// Minimal OSC 1.0 sender over UDP (no dependencies). Floats only.
import dgram from 'node:dgram';

function padString(s) {
  const bytes = Buffer.from(s, 'utf8');
  const len = (bytes.length + 4) & ~3;      // at least one NUL, pad to 4
  const out = Buffer.alloc(len);
  bytes.copy(out);
  return out;
}

export function encodeMessage(address, values) {
  const tags = ',' + values.map(v => typeof v === 'string' ? 's' : (Number.isInteger(v) && Math.abs(v) < 2 ** 31 && values.int ? 'i' : 'f')).join('');
  const parts = [padString(address), padString(tags)];
  for (const v of values) {
    if (typeof v === 'string') parts.push(padString(v));
    else { const b = Buffer.alloc(4); b.writeFloatBE(v); parts.push(b); }
  }
  return Buffer.concat(parts);
}

export function encodeBundle(messages) {
  const header = Buffer.concat([padString('#bundle'), Buffer.from([0, 0, 0, 0, 0, 0, 0, 1])]);
  const parts = [header];
  for (const m of messages) { const sz = Buffer.alloc(4); sz.writeUInt32BE(m.length); parts.push(sz, m); }
  return Buffer.concat(parts);
}

export class OscSender {
  constructor({ host, port, enabled = true }) {
    this.host = host; this.port = port; this.enabled = enabled;
    this.sock = enabled ? dgram.createSocket('udp4') : null;
    this.sent = 0; this.lastError = null;
    if (this.sock) this.sock.on('error', (e) => { this.lastError = e.message; });
  }
  send(messages) {
    if (!this.sock) return;
    const buf = encodeBundle(messages.map(([addr, ...vals]) => encodeMessage(addr, vals)));
    this.sock.send(buf, this.port, this.host, (e) => { if (e) this.lastError = e.message; else this.sent++; });
  }
  close() { this.sock?.close(); }
}
