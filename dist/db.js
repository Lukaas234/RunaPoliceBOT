"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DATABASE_FILE = exports.db = void 0;
exports.getSetting = getSetting;
exports.setSetting = setSetting;
exports.getLocalizedSetting = getLocalizedSetting;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const config_1 = require("./config");
const resolved = node_path_1.default.resolve(config_1.config.DATABASE_PATH);
node_fs_1.default.mkdirSync(node_path_1.default.dirname(resolved), { recursive: true });
exports.db = new better_sqlite3_1.default(resolved);
exports.db.pragma('journal_mode = WAL');
exports.db.pragma('foreign_keys = ON');
exports.db.pragma('busy_timeout = 5000');
exports.db.pragma('synchronous = FULL');
exports.DATABASE_FILE = resolved;
exports.db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', emoji TEXT NOT NULL DEFAULT '🎫',
  discord_category_id TEXT, support_role_ids TEXT NOT NULL DEFAULT '[]', enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT, public_id TEXT NOT NULL UNIQUE, guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL UNIQUE, owner_id TEXT NOT NULL, category_id TEXT NOT NULL REFERENCES categories(id),
  language TEXT NOT NULL DEFAULT 'en' CHECK(language IN ('en','es')),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','claimed','closed')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
  claimed_by TEXT, created_at TEXT NOT NULL, closed_at TEXT, closed_by TEXT, close_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_tickets_owner_status ON tickets(owner_id, status);
CREATE INDEX IF NOT EXISTS idx_tickets_status_created ON tickets(status, created_at);
CREATE TABLE IF NOT EXISTS ticket_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  actor_id TEXT NOT NULL, type TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ticket_events_ticket ON ticket_events(ticket_id, id);
CREATE TABLE IF NOT EXISTS ticket_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  author_id TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS transcripts (
  ticket_id INTEGER PRIMARY KEY REFERENCES tickets(id), html BLOB NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS community_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_thread_id TEXT UNIQUE,
  target_channel_id TEXT NOT NULL,
  target_message_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('task','error','problem','suggestion')),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  changes TEXT NOT NULL DEFAULT '',
  image_url TEXT,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
  source_votes INTEGER NOT NULL DEFAULT 0,
  delivery_state TEXT NOT NULL DEFAULT 'queued' CHECK(delivery_state IN ('queued','publishing','published')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  approved_by TEXT,
  approved_at TEXT
);
CREATE TABLE IF NOT EXISTS community_votes (
  post_id INTEGER NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(post_id,user_id)
);
CREATE TABLE IF NOT EXISTS ratings (
  ticket_id INTEGER PRIMARY KEY REFERENCES tickets(id), user_id TEXT NOT NULL,
  staff_id TEXT, score INTEGER NOT NULL CHECK(score BETWEEN 1 AND 5), comment TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, username TEXT NOT NULL, avatar TEXT,
  csrf_token TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,actor_id TEXT NOT NULL,type TEXT NOT NULL,detail TEXT NOT NULL,created_at TEXT NOT NULL
);
`);
// Additive migration for databases created by an earlier community-board build.
const communityPostColumns = exports.db.prepare('PRAGMA table_info(community_posts)').all();
if (!communityPostColumns.some(column => column.name === 'delivery_state')) {
    exports.db.exec("ALTER TABLE community_posts ADD COLUMN delivery_state TEXT NOT NULL DEFAULT 'published' CHECK(delivery_state IN ('queued','publishing','published'))");
}
if (!communityPostColumns.some(column => column.name === 'priority')) {
    exports.db.exec("ALTER TABLE community_posts ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent'))");
}
const ticketColumns = exports.db.prepare('PRAGMA table_info(tickets)').all();
if (!ticketColumns.some(column => column.name === 'language'))
    exports.db.exec("ALTER TABLE tickets ADD COLUMN language TEXT NOT NULL DEFAULT 'en' CHECK(language IN ('en','es'))");
const initialCategories = [
    ['general', 'General support', 'General questions and support.', '💬'],
    ['report', 'Report a user', 'Confidential user reports.', '🚩'],
    ['appeal', 'Appeal', 'Request a review of a moderation action.', '⚖️'],
    ['technical', 'Technical issues', 'Errors, failures, or technical problems.', '🛠️'],
    ['admin', 'Administrative questions', 'Questions for the administrative team.', '📋']
];
const addCategory = exports.db.prepare('INSERT OR IGNORE INTO categories (id,name,description,emoji,sort_order) VALUES (?,?,?,?,?)');
exports.db.transaction(() => initialCategories.forEach(([id, name, description, emoji], i) => addCategory.run(id, name, description, emoji, i)))();
// Translate only untouched built-in seed categories; preserve server customizations.
const translateSeed = exports.db.prepare('UPDATE categories SET name=?,description=? WHERE id=? AND name=?');
exports.db.transaction(() => [
    ['General support', 'General questions and support.', 'general', 'Soporte general'],
    ['Report a user', 'Confidential user reports.', 'report', 'Reportar a un usuario'],
    ['Appeal', 'Request a review of a moderation action.', 'appeal', 'Apelaciones'],
    ['Technical issues', 'Errors, failures, or technical problems.', 'technical', 'Problemas técnicos'],
    ['Administrative questions', 'Questions for the administrative team.', 'admin', 'Consultas administrativas']
].forEach(([name, description, id, oldName]) => translateSeed.run(name, description, id, oldName)))();
const translateDefaultSetting = exports.db.prepare('UPDATE settings SET value=?,updated_at=? WHERE key=? AND value=?');
exports.db.transaction(() => [
    ['panelMessage', 'Selecciona una categoría para abrir un ticket privado.', 'Choose a category to open a private ticket.'],
    ['welcomeMessage', 'Describe tu consulta al equipo de soporte.', 'Describe your issue for the support team.']
].forEach(([key, oldValue, newValue]) => translateDefaultSetting.run(JSON.stringify(newValue), new Date().toISOString(), key, JSON.stringify(oldValue))))();
function getSetting(key, fallback) {
    const row = exports.db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    if (!row)
        return fallback;
    try {
        return JSON.parse(row.value);
    }
    catch {
        return fallback;
    }
}
function setSetting(key, value) {
    exports.db.prepare('INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
        .run(key, JSON.stringify(value), new Date().toISOString());
}
function getLocalizedSetting(key, locale, fallback) {
    const row = exports.db.prepare('SELECT value FROM settings WHERE key=?').get(`${key}_${locale}`);
    if (row)
        try {
            return JSON.parse(row.value);
        }
        catch {
            return fallback;
        }
    return locale === 'en' ? getSetting(key, fallback) : fallback;
}
