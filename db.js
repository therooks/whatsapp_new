// db.js
import mysql from "mysql2/promise";
import config from "./config.js";

/**
 * Create MySQL pool (auto handles connections)
 */
export const db = mysql.createPool({
  host: config.DB_HOST,        // remote host or IP
  user: config.DB_USER,        // your MySQL username
  password: config.DB_PASS,    // your MySQL password
  database: config.DB_NAME,    // your database name
  port: config.DB_PORT || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

export async function testConnection() {
  try {
    const [rows] = await db.query("SELECT NOW() AS now");
    console.log("✅ MySQL connected successfully:", rows[0].now);
  } catch (err) {
    console.error("❌ MySQL connection failed:", err.message);
  }
}
