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

const starterServices = [
  ['Conteúdo', 'Arte para feed', 'Criação de peça visual original para publicação em rede social.', 'arte', 1, 50, 45.00],
  ['Conteúdo', 'Edição de vídeo curto', 'Edição de vídeo vertical para Reels, Shorts ou TikTok.', 'vídeo', 1, 30, 90.00],
  ['Estratégia', 'Planejamento editorial mensal', 'Calendário editorial, temas, formatos e distribuição por canal.', 'pacote', 1, 12, 320.00],
  ['Social', 'Gestão mensal de perfil', 'Planejamento, publicação, monitoramento e relatório de um perfil.', 'perfil/mês', 1, 10, 690.00],
  ['Anúncios', 'Gestão de campanha paga', 'Configuração, acompanhamento e otimização de campanha; verba de mídia não inclusa.', 'campanha', 1, 20, 250.00],
  ['Analytics', 'Relatório de desempenho', 'Leitura de métricas, diagnóstico e plano de melhoria.', 'relatório', 1, 12, 180.00]
];

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

  const [[count]] = await pool.query('SELECT COUNT(*) total FROM services');
  if (Number(count.total) === 0) {
    for (const service of starterServices) {
      await pool.query(
        'INSERT INTO services (category,name,description,unit_label,min_qty,max_qty,price_per_unit) VALUES (?,?,?,?,?,?,?)',
        service
      );
    }
  }
}

module.exports = { pool, initDatabase };
