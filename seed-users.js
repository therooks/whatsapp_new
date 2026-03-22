// seed-users.js  — Run once: node seed-users.js
import bcrypt from "bcryptjs";
import { db, testConnection } from "./db.js";

const users = [
  { username: "admin",    password: "admin123", role: "admin",    full_name: "Administrator",  email: "admin@waengine.local" },
  { username: "operator", password: "op2024",   role: "operator", full_name: "Ops Manager",    email: "ops@waengine.local"   },
  { username: "viewer",   password: "view123",  role: "viewer",   full_name: "View Only User", email: "viewer@waengine.local"},
];

async function seed() {
  await testConnection();

  // Create table if not exists
  await db.query(`
    CREATE TABLE IF NOT EXISTS wa_users (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      username      VARCHAR(50)  NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      role          ENUM('admin','operator','viewer') DEFAULT 'operator',
      full_name     VARCHAR(100),
      email         VARCHAR(100),
      is_active     TINYINT(1) DEFAULT 1,
      last_login    DATETIME DEFAULT NULL,
      created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  for (const u of users) {
    const hash = await bcrypt.hash(u.password, 10);
    await db.query(
      `INSERT INTO wa_users (username, password_hash, role, full_name, email)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), role = VALUES(role)`,
      [u.username, hash, u.role, u.full_name, u.email]
    );
    console.log(`✅ Seeded user: ${u.username}  (password: ${u.password})`);
  }

  console.log("\n🎉 All users seeded successfully!\n");
  process.exit(0);
}

seed().catch((e) => { console.error("Seed failed:", e); process.exit(1); });
