import session from 'express-session';
import { db } from './db.js';

type StoreCallback = (error?: Error | null) => void;

export class SQLiteSessionStore extends session.Store {
  get(sid: string, callback: (error: Error | null, value?: session.SessionData | null) => void) {
    try {
      const row = db.prepare('SELECT data FROM sessions WHERE sid = ? AND expires_at > ?').get(sid, Date.now()) as { data: string } | undefined;
      callback(null, row ? JSON.parse(row.data) as session.SessionData : null);
    } catch (error) {
      callback(error instanceof Error ? error : new Error('Unable to load session.'));
    }
  }

  set(sid: string, value: session.SessionData, callback?: StoreCallback) {
    try {
      const expiresAt = value.cookie?.expires ? new Date(value.cookie.expires).getTime() : Date.now() + 8 * 60 * 60 * 1000;
      db.prepare('INSERT INTO sessions (sid, expires_at, data) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET expires_at = excluded.expires_at, data = excluded.data')
        .run(sid, expiresAt, JSON.stringify(value));
      db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
      callback?.(null);
    } catch (error) {
      callback?.(error instanceof Error ? error : new Error('Unable to save session.'));
    }
  }

  destroy(sid: string, callback?: StoreCallback) {
    try {
      db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      callback?.(null);
    } catch (error) {
      callback?.(error instanceof Error ? error : new Error('Unable to destroy session.'));
    }
  }

  touch(sid: string, value: session.SessionData, callback?: () => void) {
    try {
      const expiresAt = value.cookie?.expires ? new Date(value.cookie.expires).getTime() : Date.now() + 8 * 60 * 60 * 1000;
      db.prepare('UPDATE sessions SET expires_at = ? WHERE sid = ?').run(expiresAt, sid);
      callback?.();
    } catch (error) {
      console.error('Unable to update session expiration:', error);
    }
  }
}
