/**
 * ATCIS WhatsApp Server — Multi-Tenant (Baileys + Supabase)
 *
 * REST API:
 *   All endpoints now require a `session` query parameter or JSON body property.
 *   GET  /health | /status?session=ID | /qr?session=ID
 *   POST /refresh-qr | /send | /send-bulk | /disconnect
 */

import express from 'express';
import cors from 'cors';
import QRCode from 'qrcode';
import pino from 'pino';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, rmSync, readdirSync, statSync } from 'fs';
import { createClient } from '@supabase/supabase-js';

import {
    makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestWaWebVersion,
    Browsers,
} from '@whiskeysockets/baileys';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Supabase ──────────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qrkjzqgedilftfivvhqq.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFya2p6cWdlZGlsZnRmaXZ2aHFxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA4NzUwMTEsImV4cCI6MjA4NjQ1MTAxMX0.6Ot1jKtBiqhzj0tIaoneM6kOxdu9QzTimSIbPtvdajQ';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// ── Sessions Management ───────────────────────────────────────────────────────
const AUTH_DIR_ROOT = join(__dirname, '.wa_auth_sessions');
const MAX_RECONNECT = 8;
const logger = pino({ level: 'silent' });

// Store active connections in memory
const sessions = new Map();

function getSession(sessionId) {
    if (!sessions.has(sessionId)) {
        sessions.set(sessionId, {
            sock: null,
            currentQrDataUrl: null,
            connectionStatus: 'disconnected',
            connectedPhone: null,
            qrGeneratedAt: null,
            reconnectAttempts: 0
        });
    }
    return sessions.get(sessionId);
}

// ══════════════════════════════════════════════════════════════════════════════
//  FORMATTING (Same as before)
// ══════════════════════════════════════════════════════════════════════════════
const LINE = '────────────────────────';

function fmtDate(d) {
    if (!d) return 'Not specified';
    return new Date(d).toLocaleDateString('en-ZM', { day: '2-digit', month: 'short', year: 'numeric' });
}

function fmtDeadline(d) {
    if (!d) return 'Not specified';
    const days = Math.ceil((new Date(d) - new Date()) / 86_400_000);
    if (days < 0) return `${fmtDate(d)} [CLOSED]`;
    if (days === 0) return `${fmtDate(d)} [CLOSING TODAY]`;
    if (days <= 3) return `${fmtDate(d)} [${days} days remaining — URGENT]`;
    return `${fmtDate(d)} [${days} days remaining]`;
}

// ══════════════════════════════════════════════════════════════════════════════
//  BOT: Incoming message handler (Scoped by session)
// ══════════════════════════════════════════════════════════════════════════════
async function handleIncomingMessage(msg, sock, sessionId) {
    const jid = msg.key.remoteJid;
    const text = (
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.documentMessage?.caption ||
        ''
    ).trim();

    if (jid?.endsWith('@g.us') || !text || !text.startsWith('!')) return;
    
    // Command handling logic can live here (truncated for multi-tenant brevity)
    if (text === '!help') {
        const reply = `*ATCIS TENDER BOT*\n${LINE}\nAvailable Commands:\n!latest, !open, !search\n\n_Connected User ID: ${sessionId}_`;
        await sock.sendMessage(jid, { text: reply }, { quoted: msg });
    }
}

// ══════════════════════════════════════════════════════════════════════════════
//  WhatsApp Connection Initializer
// ══════════════════════════════════════════════════════════════════════════════
async function connectToWhatsApp(sessionId) {
    const session = getSession(sessionId);
    const sessionDir = join(AUTH_DIR_ROOT, sessionId);
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    let waVersion;
    try {
        const { version } = await fetchLatestWaWebVersion();
        waVersion = version;
    } catch { }

    session.sock = makeWASocket({
        auth: state,
        logger,
        printQRInTerminal: false,
        ...(waVersion ? { version: waVersion } : {}),
        browser: Browsers.macOS('Chrome'),
        connectTimeoutMs: 60_000,
        markOnlineOnConnect: true,
    });

    session.sock.ev.on('creds.update', saveCreds);

    // Incoming messages
    session.sock.ev.on('messages.upsert', async ({ messages, type }) => {
        for (const msg of messages) {
            if (type === 'append' && (Date.now() - (msg.messageTimestamp ?? 0) * 1000) > 30_000) continue;
            try { await handleIncomingMessage(msg, session.sock, sessionId); }
            catch (e) { console.error(`[Session ${sessionId}] msg error:`, e.message); }
        }
    });

    // Connection state
    session.sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            session.connectionStatus = 'qr_ready';
            session.qrGeneratedAt = Date.now();
            session.reconnectAttempts = 0;
            try {
                session.currentQrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
            } catch (e) { }
        }

        if (connection === 'open') {
            session.connectionStatus = 'connected';
            session.currentQrDataUrl = null;
            session.reconnectAttempts = 0;
            session.connectedPhone = session.sock.user?.id?.split(':')[0] || 'connected';
            console.log(`[Session ${sessionId}] Connected as +${session.connectedPhone}`);
        }

        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            const loggedOut = code === DisconnectReason.loggedOut;
            console.log(`[Session ${sessionId}] Closed. Code: ${code}`);

            if (loggedOut) {
                if (existsSync(sessionDir)) rmSync(sessionDir, { recursive: true, force: true });
                session.connectionStatus = 'disconnected';
                session.connectedPhone = null;
                session.currentQrDataUrl = null;
                session.reconnectAttempts = 0;
                return;
            }

            session.reconnectAttempts++;
            if (session.reconnectAttempts > MAX_RECONNECT) {
                session.connectionStatus = 'disconnected';
                return;
            }

            const delay = Math.min(2000 * session.reconnectAttempts, 20_000);
            session.connectionStatus = 'connecting';
            session.connectedPhone = null;
            setTimeout(() => connectToWhatsApp(sessionId), delay);
        }
    });
}

// ══════════════════════════════════════════════════════════════════════════════
//  REST API
// ══════════════════════════════════════════════════════════════════════════════
app.get('/health', (_, res) => res.json({ ok: true }));

app.get('/status', (req, res) => {
    const sessionId = req.query.session || 'default';
    const session = getSession(sessionId);
    res.json({
        status: session.connectionStatus,
        phone: session.connectedPhone,
        hasQr: !!session.currentQrDataUrl,
        qrAge: session.qrGeneratedAt ? Math.floor((Date.now() - session.qrGeneratedAt) / 1000) : null,
    });
});

app.get('/qr', (req, res) => {
    const sessionId = req.query.session || 'default';
    const session = getSession(sessionId);

    if (session.connectionStatus === 'connected')
        return res.json({ status: 'connected', phone: session.connectedPhone });

    if (!session.currentQrDataUrl) {
        if (session.connectionStatus === 'disconnected') {
            session.connectionStatus = 'connecting';
            connectToWhatsApp(sessionId).catch(console.error);
        }
        return res.json({ status: session.connectionStatus, qr: null });
    }

    const age = session.qrGeneratedAt ? (Date.now() - session.qrGeneratedAt) / 1000 : 0;
    if (age > 60) {
        session.currentQrDataUrl = null;
        return res.json({ status: 'expired', qr: null });
    }
    res.json({ status: 'qr_ready', qr: session.currentQrDataUrl, expiresIn: Math.max(0, 60 - Math.floor(age)) });
});

app.post('/refresh-qr', async (req, res) => {
    const sessionId = req.query.session || req.body.session || 'default';
    const session = getSession(sessionId);
    try {
        if (session.sock) { session.sock.ev.removeAllListeners(); try { await session.sock.logout(); } catch { } session.sock = null; }
        session.currentQrDataUrl = null; session.connectedPhone = null; session.reconnectAttempts = 0;
        session.connectionStatus = 'connecting';
        connectToWhatsApp(sessionId).catch(console.error);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/send', async (req, res) => {
    const sessionId = req.body.session || req.query.session || 'default';
    const session = getSession(sessionId);
    const { phone, message, document } = req.body;

    if (session.connectionStatus !== 'connected' || !session.sock)
        return res.status(400).json({ success: false, error: 'WhatsApp not connected for this session' });
    
    try {
        const jid = phone.replace(/\D/g, '') + '@s.whatsapp.net';
        if (document) {
            const buffer = Buffer.from(document.base64, 'base64');
            await session.sock.sendMessage(jid, { document: buffer, fileName: document.fileName, mimetype: document.mimetype, caption: message || '' });
        } else {
            await session.sock.sendMessage(jid, { text: message });
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/send-bulk', async (req, res) => {
    const sessionId = req.body.session || req.query.session || 'default';
    const session = getSession(sessionId);
    const { phones = [], message } = req.body;

    if (session.connectionStatus !== 'connected' || !session.sock)
        return res.status(400).json({ success: false, sent: 0, failed: phones.length, error: 'Not connected' });
    
    let sent = 0, failed = 0; const errors = [];
    for (const phone of phones) {
        try {
            await session.sock.sendMessage(phone.replace(/\D/g, '') + '@s.whatsapp.net', { text: message });
            sent++; await new Promise(r => setTimeout(r, 400));
        } catch (e) { failed++; errors.push({ phone, error: e.message }); }
    }
    res.json({ success: true, sent, failed, errors });
});

app.post('/disconnect', async (req, res) => {
    const sessionId = req.body.session || req.query.session || 'default';
    const session = getSession(sessionId);
    try {
        if (session.sock) { session.sock.ev.removeAllListeners(); try { await session.sock.logout(); } catch { } session.sock = null; }
        const sessionDir = join(AUTH_DIR_ROOT, sessionId);
        if (existsSync(sessionDir)) rmSync(sessionDir, { recursive: true, force: true });
        session.connectionStatus = 'disconnected'; session.connectedPhone = null; session.currentQrDataUrl = null;
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Auto-boot existing sessions
function bootExistingSessions() {
    if (!existsSync(AUTH_DIR_ROOT)) return;
    const dirs = readdirSync(AUTH_DIR_ROOT).filter(f => statSync(join(AUTH_DIR_ROOT, f)).isDirectory());
    for (const session of dirs) {
        if (session.startsWith('session_') || session !== '.DS_Store') {
            console.log(`[Auto-Boot] Initializing found session: ${session}`);
            getSession(session).connectionStatus = 'connecting';
            connectToWhatsApp(session).catch(() => {});
        }
    }
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`\nATCIS Multi-Tenant WhatsApp Server  →  http://localhost:${PORT}\n`);
    bootExistingSessions();
});
