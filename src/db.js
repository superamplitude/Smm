const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  decimalNumbers: true,
  multipleStatements: true
});

async function initDatabase() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);

  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (adminEmail && adminPassword && adminPassword !== 'change-me-now') {
    const [rows] = await pool.query('SELECT id FROM users WHERE email=? LIMIT 1', [adminEmail.toLowerCase()]);
    if (!rows.length) {
      const hash = await bcrypt.hash(adminPassword, 12);
      await pool.query(
        "INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,'admin')",
        ['Administrador', adminEmail.toLowerCase(), hash]
      );
    }
  }
}

module.exports = { pool, initDatabase };
