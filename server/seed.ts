import { db, initializeDatabase } from './db.js';

try {
  initializeDatabase();
  const authors = (db.prepare('SELECT COUNT(*) AS count FROM authors WHERE is_active = 1').get() as { count: number }).count;
  const books = (db.prepare('SELECT COUNT(*) AS count FROM books WHERE is_active = 1').get() as { count: number }).count;
  console.log(`Seed complete: ${authors} authors and ${books} books.`);
} finally {
  db.close();
}
