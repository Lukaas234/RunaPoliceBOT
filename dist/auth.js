"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startOAuth = startOAuth;
exports.finishOAuth = finishOAuth;
exports.requireAuth = requireAuth;
exports.requireRole = requireRole;
exports.setSessionCookie = setSessionCookie;
exports.clearSession = clearSession;
const node_crypto_1 = __importDefault(require("node:crypto"));
const config_1 = require("./config");
const db_1 = require("./db");
const discord_js_1 = require("discord.js");
const sha = (x) => node_crypto_1.default.createHash('sha256').update(x).digest('hex');
function startOAuth() {
    const state = node_crypto_1.default.randomBytes(32).toString('base64url');
    db_1.db.prepare('INSERT INTO oauth_states(state,expires_at) VALUES(?,?)').run(sha(state), Date.now() + 10 * 60_000);
    const u = new URL('https://discord.com/oauth2/authorize');
    u.searchParams.set('client_id', config_1.config.DISCORD_CLIENT_ID);
    u.searchParams.set('redirect_uri', config_1.config.DISCORD_REDIRECT_URI);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', 'identify');
    u.searchParams.set('state', state);
    return { url: u.toString(), state };
}
async function finishOAuth(client, code, state) {
    const stateHash = sha(state);
    const valid = db_1.db.prepare('SELECT state FROM oauth_states WHERE state=? AND expires_at>?').get(stateHash, Date.now());
    db_1.db.prepare('DELETE FROM oauth_states WHERE expires_at<=?').run(Date.now());
    if (!valid)
        throw new Error('Your login session expired or is invalid.');
    db_1.db.prepare('DELETE FROM oauth_states WHERE state=?').run(stateHash);
    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: config_1.config.DISCORD_CLIENT_ID, client_secret: config_1.config.DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: config_1.config.DISCORD_REDIRECT_URI }) });
    if (!tokenResponse.ok)
        throw new Error('Discord rejected the authorization request.');
    const token = await tokenResponse.json();
    const userResponse = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${token.access_token}` } });
    if (!userResponse.ok)
        throw new Error('Could not verify your Discord identity.');
    const profile = await userResponse.json();
    const guild = await client.guilds.fetch(config_1.config.DISCORD_GUILD_ID);
    const member = guild.members.cache.get(profile.id) || await guild.members.fetch(profile.id).catch(() => null);
    if (!member)
        throw new Error('Only Run a Police members can access the dashboard.');
    const role = getRole([...member.roles.cache.keys()], member.permissions.has(discord_js_1.PermissionFlagsBits.Administrator));
    if (!role)
        throw new Error('Your account does not have a role authorized to access the dashboard.');
    const cookie = node_crypto_1.default.randomBytes(32).toString('base64url');
    const csrfToken = node_crypto_1.default.randomBytes(24).toString('base64url');
    db_1.db.prepare('INSERT INTO sessions(token_hash,user_id,username,avatar,csrf_token,expires_at) VALUES(?,?,?,?,?,?)')
        .run(sha(cookie), profile.id, profile.username, profile.avatar, csrfToken, Date.now() + 12 * 60 * 60_000);
    return { cookie, user: { id: profile.id, username: profile.username, avatar: profile.avatar, csrfToken, role } };
}
function getRole(roles, administrator) {
    if (administrator || roles.some(id => config_1.config.bootstrapAdminRoleIds.includes(id)))
        return 'admin';
    const groups = [['admin', (0, db_1.getSetting)('adminRoleIds', [])], ['supervisor', (0, db_1.getSetting)('supervisorRoleIds', [])], ['support', (0, db_1.getSetting)('supportRoleIds', [])], ['readonly', (0, db_1.getSetting)('readonlyRoleIds', [])]];
    for (const [name, ids] of groups)
        if (roles.some(id => ids.includes(id)))
            return name;
    return null;
}
async function requireAuth(client, req, res, next) {
    try {
        const raw = req.cookies?.['__Host-rap_session'] || req.cookies?.['rap_session'];
        if (!raw)
            return res.status(401).json({ error: 'Sign in with Discord.' });
        const row = db_1.db.prepare('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?').get(sha(raw), Date.now());
        if (!row)
            return res.status(401).json({ error: 'Your session has expired.' });
        const guild = await client.guilds.fetch(config_1.config.DISCORD_GUILD_ID);
        const member = guild.members.cache.get(row.user_id) || await guild.members.fetch(row.user_id).catch(() => null);
        if (!member) {
            db_1.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(raw));
            return res.status(403).json({ error: 'You are no longer a member of Run a Police.' });
        }
        const role = getRole([...member.roles.cache.keys()], member.permissions.has(discord_js_1.PermissionFlagsBits.Administrator));
        if (!role) {
            db_1.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(raw));
            return res.status(403).json({ error: 'Your role no longer has access.' });
        }
        req.authUser = { id: row.user_id, username: row.username, avatar: row.avatar, csrfToken: row.csrf_token, role };
        if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('x-csrf-token') !== row.csrf_token)
            return res.status(403).json({ error: 'Invalid CSRF token.' });
        next();
    }
    catch (e) {
        next(e);
    }
}
function requireRole(...roles) {
    return (req, res, next) => {
        const order = ['readonly', 'support', 'supervisor', 'admin'];
        const current = req.authUser?.role;
        if (!current || Math.max(...roles.map(r => order.indexOf(r))) > order.indexOf(current))
            return res.status(403).json({ error: 'You are not allowed to perform this action.' });
        next();
    };
}
function setSessionCookie(res, cookie) {
    res.cookie(config_1.config.secureCookies ? '__Host-rap_session' : 'rap_session', cookie, { httpOnly: true, secure: config_1.config.secureCookies, sameSite: 'lax', path: '/', maxAge: 12 * 60 * 60_000 });
}
function clearSession(req, res) {
    const raw = req.cookies?.['__Host-rap_session'] || req.cookies?.['rap_session'];
    if (raw)
        db_1.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(raw));
    res.clearCookie(config_1.config.secureCookies ? '__Host-rap_session' : 'rap_session', { httpOnly: true, secure: config_1.config.secureCookies, sameSite: 'lax', path: '/' });
}
