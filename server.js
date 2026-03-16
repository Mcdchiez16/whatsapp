/**
 * ATCIS WhatsApp Server — Baileys + Supabase
 *
 * REST API (React app):
 *   GET  /health | /status | /qr
 *   POST /refresh-qr | /send | /send-bulk | /disconnect
 *
 * Bot commands (WhatsApp self-message or from other number):
 *   !help | !latest | !open | !ict | !deadline | !search <kw> | !tender <ref> | !stats
 */

import express from 'express';
import cors from 'cors';
import QRCode from 'qrcode';
import pino from 'pino';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, rmSync } from 'fs';
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

// ── State ─────────────────────────────────────────────────────────────────────
let sock = null;
let currentQrDataUrl = null;
let connectionStatus = 'disconnected';
let connectedPhone = null;   // e.g. "260778558456"
let qrGeneratedAt = null;
let reconnectAttempts = 0;
const MAX_RECONNECT = 8;
const AUTH_DIR = join(__dirname, '.wa_auth');
const logger = pino({ level: 'silent' });

// ══════════════════════════════════════════════════════════════════════════════
//  FORMATTING — Professional, no decorative emojis
// ══════════════════════════════════════════════════════════════════════════════
const LINE = '────────────────────────';

function fmtDate(d) {
    if (!d) return 'Not specified';
    return new Date(d).toLocaleDateString('en-ZM', { day: '2-digit', month: 'short', year: 'numeric' });
}

function daysLeft(d) {
    if (!d) return null;
    return Math.ceil((new Date(d) - new Date()) / 86_400_000);
}

function fmtDeadline(d) {
    const days = daysLeft(d);
    if (days === null) return 'Not specified';
    if (days < 0) return `${fmtDate(d)} [CLOSED]`;
    if (days === 0) return `${fmtDate(d)} [CLOSING TODAY]`;
    if (days <= 3) return `${fmtDate(d)} [${days} day${days !== 1 ? 's' : ''} remaining — URGENT]`;
    return `${fmtDate(d)} [${days} days remaining]`;
}

function formatTenderList(tenders, title) {
    if (!tenders?.length) {
        return `*${title}*\n${LINE}\nNo records found matching your query.`;
    }
    const items = tenders.map((t, i) => {
        const ref = t.reference_number || 'N/A';
        const title = t.tender_title || t.title || 'Untitled';
        const entity = t.procuring_entity || 'Unknown Entity';
        const deadline = fmtDeadline(t.closing_date);
        return `*${i + 1}. ${title}*\nRef: ${ref}\nEntity: ${entity}\nDeadline: ${deadline}`;
    });
    return `*${title.toUpperCase()}*\n${LINE}\n${items.join(`\n${LINE}\n`)}\n${LINE}\n_${tenders.length} record${tenders.length !== 1 ? 's' : ''} returned_`;
}

// ══════════════════════════════════════════════════════════════════════════════
//  Supabase queries
// ══════════════════════════════════════════════════════════════════════════════
async function queryLatest() {
    const { data } = await supabase
        .from('tenders')
        .select('tender_title, reference_number, procuring_entity, closing_date')
        .order('created_at', { ascending: false })
        .limit(10);
    return formatTenderList(data, 'Latest Tenders');
}

async function queryOpen() {
    const { data } = await supabase
        .from('tenders')
        .select('tender_title, reference_number, procuring_entity, closing_date, status')
        .in('status', ['open', 'active', 'published', 'new'])
        .order('closing_date', { ascending: true })
        .limit(15);
    return formatTenderList(data, 'Open Tenders');
}

async function queryICT() {
    const { data } = await supabase
        .from('tenders')
        .select('tender_title, reference_number, procuring_entity, closing_date')
        .or('tender_title.ilike.%ict%,tender_title.ilike.%information technology%,tender_title.ilike.%software%,tender_title.ilike.%system%,tender_title.ilike.%network%,tender_title.ilike.%computer%,category.ilike.%ict%,category.ilike.%technology%')
        .order('closing_date', { ascending: true })
        .limit(15);
    return formatTenderList(data, 'ICT and Technology Tenders');
}

async function queryDeadlines() {
    const now = new Date().toISOString();
    const in7 = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const { data } = await supabase
        .from('tenders')
        .select('tender_title, reference_number, procuring_entity, closing_date')
        .gte('closing_date', now)
        .lte('closing_date', in7)
        .order('closing_date', { ascending: true });
    return formatTenderList(data, 'Tenders Closing Within 7 Days');
}

async function querySearch(keyword) {
    const { data } = await supabase
        .from('tenders')
        .select('tender_title, reference_number, procuring_entity, closing_date')
        .or(`tender_title.ilike.%${keyword}%,procuring_entity.ilike.%${keyword}%,reference_number.ilike.%${keyword}%,category.ilike.%${keyword}%`)
        .order('created_at', { ascending: false })
        .limit(10);
    return formatTenderList(data, `Search Results for "${keyword}"`);
}

async function queryTenderByRef(ref) {
    const { data } = await supabase
        .from('tenders')
        .select('tender_title, reference_number, procuring_entity, closing_date, status, category, description')
        .ilike('reference_number', `%${ref}%`)
        .limit(1)
        .single();

    if (!data) return `*TENDER LOOKUP*\n${LINE}\nNo tender found matching reference: ${ref}`;

    return [
        `*TENDER DETAILS*`,
        LINE,
        `*${data.tender_title}*`,
        ``,
        `Reference:  ${data.reference_number || 'N/A'}`,
        `Entity:     ${data.procuring_entity || 'N/A'}`,
        `Category:   ${data.category || 'N/A'}`,
        `Status:     ${(data.status || 'Unknown').toUpperCase()}`,
        `Deadline:   ${fmtDeadline(data.closing_date)}`,
        data.description ? `\nSummary:\n${data.description.slice(0, 300)}${data.description.length > 300 ? '...' : ''}` : '',
        LINE,
    ].filter(Boolean).join('\n');
}

async function queryStats() {
    const [total, open, closing] = await Promise.all([
        supabase.from('tenders').select('id', { count: 'exact', head: true }),
        supabase.from('tenders').select('id', { count: 'exact', head: true }).in('status', ['open', 'active', 'new', 'published']),
        supabase.from('tenders').select('id', { count: 'exact', head: true })
            .gte('closing_date', new Date().toISOString())
            .lte('closing_date', new Date(Date.now() + 7 * 86_400_000).toISOString()),
    ]);
    return [
        `*ATCIS SYSTEM STATISTICS*`,
        LINE,
        `Total Tenders:         ${total.count ?? 'N/A'}`,
        `Currently Open:        ${open.count ?? 'N/A'}`,
        `Closing Within 7 Days: ${closing.count ?? 'N/A'}`,
        LINE,
        `_Report generated: ${new Date().toLocaleString('en-ZM', { dateStyle: 'medium', timeStyle: 'short' })}_`,
    ].join('\n');
}

const HELP_MSG = [
    `*ATCIS TENDER BOT — COMMAND REFERENCE*`,
    LINE,
    `Send any of the following commands:`,
    ``,
    `*!latest*              Most recent tenders`,
    `*!open*                Currently open tenders`,
    `*!ict*                 ICT and technology tenders`,
    `*!deadline*            Closing within 7 days`,
    `*!search <keyword>*    Search tenders by keyword`,
    `  e.g.  !search construction`,
    `*!tender <reference>*  Look up by reference number`,
    `  e.g.  !tender PSC/RFQ/279`,
    `*!stats*               System statistics`,
    `*!help*                Show this command list`,
    LINE,
    `_ATCIS Tender Intelligence System_`,
].join('\n');

// ══════════════════════════════════════════════════════════════════════════════
//  ASSIGNMENT NOTIFICATIONS — polled from Supabase
// ══════════════════════════════════════════════════════════════════════════════
let lastAssignmentCheck = new Date().toISOString();

async function checkNewAssignments() {
    if (connectionStatus !== 'connected' || !sock) return;

    try {
        // Fetch assignments created after our last check
        const { data: assignments } = await supabase
            .from('team_assignments')
            .select(`
                id, role, member_name, phone, email, assigned_at,
                tenders(tender_title, reference_number, procuring_entity, closing_date)
            `)
            .gt('assigned_at', lastAssignmentCheck)
            .order('assigned_at', { ascending: true });

        if (!assignments?.length) return;

        // Update checkpoint
        lastAssignmentCheck = assignments[assignments.length - 1].assigned_at;

        for (const assignment of assignments) {
            // Use phone directly from team_assignments, or look up from whatsapp_contacts
            let phone = assignment.phone?.replace(/\D/g, '');

            if (!phone && assignment.email) {
                // Try to match from stored WhatsApp contacts by email
                const { data: setting } = await supabase
                    .from('system_settings')
                    .select('value')
                    .eq('key', 'whatsapp_contacts')
                    .single();

                if (setting?.value) {
                    const contacts = JSON.parse(setting.value);
                    const match = contacts.find(c =>
                        c.email?.toLowerCase() === assignment.email?.toLowerCase() ||
                        c.name?.toLowerCase() === assignment.member_name?.toLowerCase()
                    );
                    if (match) phone = match.phone?.replace(/\D/g, '');
                }
            }

            if (!phone) {
                console.log(`[Assignment] No phone for ${assignment.member_name} — skipping notification`);
                continue;
            }

            const tender = assignment.tenders;
            const message = [
                `*TENDER ASSIGNMENT NOTIFICATION*`,
                LINE,
                `You have been assigned to the following tender:`,
                ``,
                `*${tender?.tender_title || 'Tender'}*`,
                ``,
                `Reference:  ${tender?.reference_number || 'N/A'}`,
                `Entity:     ${tender?.procuring_entity || 'N/A'}`,
                `Your Role:  ${assignment.role || 'Team Member'}`,
                `Deadline:   ${fmtDeadline(tender?.closing_date)}`,
                LINE,
                `Please log in to ATCIS to view full details.`,
                `_ATCIS Tender Intelligence System_`,
            ].join('\n');

            try {
                const jid = phone + '@s.whatsapp.net';
                await sock.sendMessage(jid, { text: message });
                console.log(`[Assignment] Notified ${assignment.member_name} (+${phone}) for ${tender?.reference_number}`);
            } catch (e) {
                console.error(`[Assignment] Failed to notify ${assignment.member_name}:`, e.message);
            }
        }
    } catch (e) {
        console.error('[Assignment] Poll error:', e.message);
    }
}

// ══════════════════════════════════════════════════════════════════════════════
//  BOT: Incoming message handler
// ══════════════════════════════════════════════════════════════════════════════
async function handleIncomingMessage(msg) {
    const jid = msg.key.remoteJid;

    // Extract text from all message types
    const text = (
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.documentMessage?.caption ||
        ''
    ).trim();

    // Log all incoming messages for debugging
    console.log(`[Msg] from=${jid} fromMe=${msg.key.fromMe} text="${text}"`);

    // Skip group chats
    if (jid?.endsWith('@g.us')) return;

    // Skip empty
    if (!text) return;

    // Only respond to ! commands (case-insensitive)
    if (!text.startsWith('!')) return;

    const parts = text.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1).join(' ');

    console.log(`[Bot] Command="${cmd}" Args="${args}" from ${jid}`);

    let reply = '';
    try {
        switch (cmd) {
            case '!help': reply = HELP_MSG; break;
            case '!latest': reply = await queryLatest(); break;
            case '!open': reply = await queryOpen(); break;
            case '!ict': reply = await queryICT(); break;
            case '!deadline':
            case '!deadlines': reply = await queryDeadlines(); break;
            case '!stats': reply = await queryStats(); break;
            case '!search':
                reply = args ? await querySearch(args)
                    : `*USAGE ERROR*\n${LINE}\nProvide a search term.\nExample: !search construction`;
                break;
            case '!tender':
                reply = args ? await queryTenderByRef(args)
                    : `*USAGE ERROR*\n${LINE}\nProvide a reference number.\nExample: !tender PSC/RFQ/279`;
                break;
            default:
                reply = `*UNKNOWN COMMAND*\n${LINE}\nCommand "${cmd}" is not recognised.\nSend *!help* to view available commands.`;
        }
    } catch (err) {
        console.error('[Bot] Query error:', err);
        reply = `*SYSTEM ERROR*\n${LINE}\nAn error occurred processing your request.\nPlease try again.\n\n_${err.message}_`;
    }

    if (reply) {
        await sock.sendMessage(jid, { text: reply }, { quoted: msg });
        console.log(`[Bot] Replied to ${jid}`);
    }
}

// ══════════════════════════════════════════════════════════════════════════════
//  WhatsApp connection
// ══════════════════════════════════════════════════════════════════════════════
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    let waVersion;
    try {
        const { version, isLatest } = await fetchLatestWaWebVersion();
        waVersion = version;
        console.log(`[WA] Version ${version.join('.')} (latest: ${isLatest})`);
    } catch {
        console.warn('[WA] Could not fetch version — using bundled default.');
    }

    sock = makeWASocket({
        auth: state,
        logger,
        printQRInTerminal: false,
        ...(waVersion ? { version: waVersion } : {}),
        browser: Browsers.macOS('Chrome'),
        connectTimeoutMs: 60_000,
        defaultQueryTimeoutMs: 60_000,
        keepAliveIntervalMs: 30_000,
        retryRequestDelayMs: 500,
        markOnlineOnConnect: true,
        getMessage: async () => ({ conversation: '' }),
    });

    sock.ev.on('creds.update', saveCreds);

    // ── Incoming messages ────────────────────────────────────────────────────
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        console.log(`[Msg] upsert type="${type}" count=${messages.length}`);
        for (const msg of messages) {
            // Skip old history messages during reconnect
            if (type === 'append') {
                const age = Date.now() - (msg.messageTimestamp ?? 0) * 1000;
                if (age > 30_000) continue;
            }
            try { await handleIncomingMessage(msg); }
            catch (e) { console.error('[Msg] Handler error:', e); }
        }
    });

    // ── Connection state ─────────────────────────────────────────────────────
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            connectionStatus = 'qr_ready';
            qrGeneratedAt = Date.now();
            reconnectAttempts = 0;
            try {
                currentQrDataUrl = await QRCode.toDataURL(qr, {
                    width: 300, margin: 2,
                    color: { dark: '#000000', light: '#ffffff' },
                });
                console.log('[WA] QR code ready — scan it in the app.');
            } catch (e) { console.error('[WA] QR error:', e.message); }
        }

        if (connection === 'open') {
            connectionStatus = 'connected';
            currentQrDataUrl = null;
            reconnectAttempts = 0;
            connectedPhone = sock.user?.id?.split(':')[0] || sock.user?.id || 'unknown';
            console.log(`[WA] Connected as +${connectedPhone}`);
            console.log(`[Bot] Active — send !help from your phone to this number.`);
            // Reset assignment check timestamp on fresh connect
            lastAssignmentCheck = new Date(Date.now() - 60_000).toISOString();
        }

        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            const loggedOut = code === DisconnectReason.loggedOut;
            console.log(`[WA] Connection closed. Code: ${code ?? 'unknown'}`);

            if (loggedOut) {
                if (existsSync(AUTH_DIR)) rmSync(AUTH_DIR, { recursive: true, force: true });
                connectionStatus = 'disconnected';
                connectedPhone = null;
                currentQrDataUrl = null;
                reconnectAttempts = 0;
                console.log('[WA] Logged out — rescan QR to reconnect.');
                return;
            }

            reconnectAttempts++;
            if (reconnectAttempts > MAX_RECONNECT) {
                connectionStatus = 'disconnected';
                reconnectAttempts = 0;
                console.error(`[WA] Gave up after ${MAX_RECONNECT} attempts.`);
                return;
            }

            const delay = Math.min(2000 * reconnectAttempts, 20_000);
            console.log(`[WA] Retry in ${delay / 1000}s (${reconnectAttempts}/${MAX_RECONNECT})...`);
            connectionStatus = 'connecting';
            connectedPhone = null;
            setTimeout(connectToWhatsApp, delay);
        }
    });
}

// ══════════════════════════════════════════════════════════════════════════════
//  REST API
// ══════════════════════════════════════════════════════════════════════════════
app.get('/health', (_, res) => res.json({ ok: true }));

app.get('/status', (_, res) => res.json({
    status: connectionStatus,
    phone: connectedPhone,
    hasQr: !!currentQrDataUrl,
    qrAge: qrGeneratedAt ? Math.floor((Date.now() - qrGeneratedAt) / 1000) : null,
}));

app.get('/qr', (_, res) => {
    if (connectionStatus === 'connected')
        return res.json({ status: 'connected', phone: connectedPhone });

    if (!currentQrDataUrl) {
        if (connectionStatus === 'disconnected') {
            connectionStatus = 'connecting';
            connectToWhatsApp().catch(console.error);
        }
        return res.json({ status: connectionStatus, qr: null });
    }

    const age = qrGeneratedAt ? (Date.now() - qrGeneratedAt) / 1000 : 0;
    if (age > 60) {
        currentQrDataUrl = null;
        return res.json({ status: 'expired', qr: null });
    }
    res.json({ status: 'qr_ready', qr: currentQrDataUrl, expiresIn: Math.max(0, 60 - Math.floor(age)) });
});

app.post('/refresh-qr', async (_, res) => {
    try {
        if (sock) { sock.ev.removeAllListeners(); try { await sock.logout(); } catch { } sock = null; }
        currentQrDataUrl = null; connectedPhone = null; reconnectAttempts = 0;
        connectionStatus = 'connecting';
        connectToWhatsApp().catch(console.error);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/send', async (req, res) => {
    const { phone, message, document } = req.body;
    if (connectionStatus !== 'connected' || !sock)
        return res.status(400).json({ success: false, error: 'WhatsApp not connected' });
    if (!phone || (!message && !document))
        return res.status(400).json({ success: false, error: 'phone and message/document required' });
    try {
        const jid = phone.replace(/\D/g, '') + '@s.whatsapp.net';
        if (document) {
            // Document payload: { base64: string, fileName: string, mimetype: string }
            const buffer = Buffer.from(document.base64, 'base64');
            await sock.sendMessage(jid, {
                document: buffer,
                fileName: document.fileName || 'document.pdf',
                mimetype: document.mimetype || 'application/pdf',
                caption: message || ''
            });
        } else {
            await sock.sendMessage(jid, { text: message });
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/send-bulk', async (req, res) => {
    const { phones = [], message } = req.body;
    if (connectionStatus !== 'connected' || !sock)
        return res.status(400).json({ success: false, sent: 0, failed: phones.length, error: 'Not connected' });
    let sent = 0, failed = 0; const errors = [];
    for (const phone of phones) {
        try {
            await sock.sendMessage(phone.replace(/\D/g, '') + '@s.whatsapp.net', { text: message });
            sent++; await new Promise(r => setTimeout(r, 400));
        } catch (e) { failed++; errors.push({ phone, error: e.message }); }
    }
    res.json({ success: true, sent, failed, errors });
});

app.post('/disconnect', async (_, res) => {
    try {
        if (sock) { sock.ev.removeAllListeners(); try { await sock.logout(); } catch { } sock = null; }
        if (existsSync(AUTH_DIR)) rmSync(AUTH_DIR, { recursive: true, force: true });
        connectionStatus = 'disconnected'; connectedPhone = null; currentQrDataUrl = null;
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
//  Start
// ══════════════════════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
    console.log(`\nATCIS WhatsApp Server  →  http://localhost:${PORT}\n`);

    // Start WA connection
    connectionStatus = 'connecting';
    connectToWhatsApp().catch(console.error);

    // Poll for new assignments every 60 seconds
    setInterval(checkNewAssignments, 60_000);
    console.log('[Assignment] Polling for new assignments every 60s.');
});
